import { describe, expect, it, vi } from 'vitest'
import {
    CREATE_IDEMPOTENT_TASK_COMMAND_V1,
    parseCreateIdempotentTaskCommandV1,
} from '@/contracts/work-management/v1'
import {
    AI_CALL_FINALIZATION_MAX_FAILURES,
    AI_CALL_FINALIZATION_METADATA_KEY,
    AI_CALL_FINALIZATION_RETRY_BACKOFF_MS,
    createAiCallFinalizationOperation,
    createAiCallFinalizationRecoveryOperation,
    createAiCallFinalizationWithTranscriptReconciliation,
    metadataWithAiCallFinalizationJournal,
    readAiCallFinalizationJournal,
    type AiCallFinalizationCall,
    type AiCallFinalizationJournalV1,
    type AiCallFinalizationRecoveryPersistencePort,
    type AiCallTerminalUpdate,
    type FinalizationAcceptance,
    type FollowUpClaim,
} from './ai-call-finalization'
import type { AiCallTranscriptMessageInput } from './ai-call-transcript'

const FOLLOW_UP_BODY = {
    callUuid: 'fs-1',
    reason: 'completed',
    result: {
        qualification_status: 'qualified',
        lead_summary: 'Ready to proceed',
        reason: 'Positive answers',
        qualification_score: 88,
        manager_task: { should_create: true, summary: 'Call the lead', priority: 'high' },
        lead_data: { experienceYears: '5' },
    },
    transcript: [{ role: 'user', content: 'Yes' }],
    realUserUtterances: 1,
    events: [],
}

function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
}

class MemoryFinalizationPort implements AiCallFinalizationRecoveryPersistencePort {
    call: AiCallFinalizationCall & { aiAnalysis?: unknown } = {
        id: 'call-1',
        status: 'connected',
        startedAt: new Date('2026-08-29T09:59:50.000Z'),
        endedAt: null,
        aiSessionStatus: null,
        aiOutcome: null,
        driverId: 'driver-1',
        contactId: 'contact-1',
        managerId: 'manager-1',
        aiScenarioId: null,
        transcript: null,
        metadata: {},
        aiScenario: null,
    }
    terminal: AiCallTerminalUpdate | null = null
    crashOnClaimOnce = false

    async findCall(callId: string) {
        return callId === this.call.id ? this.call : null
    }

    async accept(input: {
        callId: string
        fingerprint: string
        journal: AiCallFinalizationJournalV1
        terminal: AiCallTerminalUpdate
    }): Promise<FinalizationAcceptance> {
        if (input.callId !== this.call.id) return { kind: 'not_found' }
        const existing = readAiCallFinalizationJournal(this.call.metadata)
        if (existing) {
            return existing.fingerprint === input.fingerprint
                ? { kind: 'duplicate', journal: existing }
                : { kind: 'conflict' }
        }
        if (
            ['ended', 'failed'].includes(String(this.call.aiSessionStatus))
            || this.call.aiOutcome
            || (this.call.aiSessionStatus === 'transferring'
                && this.call.aiAnalysis !== null
                && this.call.aiAnalysis !== undefined)
        ) {
            return { kind: 'legacy_terminal' }
        }
        this.terminal = input.terminal
        this.call.status = input.terminal.status
        this.call.endedAt = input.terminal.endedAt
        this.call.aiSessionStatus = input.terminal.aiSessionStatus
        this.call.aiOutcome = input.terminal.aiOutcome
        this.call.aiAnalysis = input.terminal.aiAnalysis
        this.call.metadata = metadataWithAiCallFinalizationJournal(this.call.metadata, input.journal)
        return { kind: 'accepted', journal: input.journal }
    }

    async claimFollowUp(input: {
        callId: string
        fingerprint: string
        now: Date
        leaseMs: number
    }): Promise<FollowUpClaim> {
        if (this.crashOnClaimOnce) {
            this.crashOnClaimOnce = false
            throw new Error('simulated_process_crash_after_call_commit')
        }
        const journal = this.journal(input.fingerprint)
        const followUp = journal.followUp
        if (['not_required', 'completed', 'terminal_failure'].includes(followUp.state)) {
            return { kind: 'settled', journal }
        }
        if (
            followUp.state === 'in_progress'
            && followUp.leaseUntil
            && new Date(followUp.leaseUntil).getTime() > input.now.getTime()
        ) return { kind: 'busy', journal }
        if (
            followUp.state === 'retry_wait'
            && followUp.nextAttemptAt
            && new Date(followUp.nextAttemptAt).getTime() > input.now.getTime()
        ) return { kind: 'not_due', journal }
        const attempts = followUp.attempts + 1
        const leaseToken = `${journal.finalizationId}:attempt:${attempts}`
        const claimed: AiCallFinalizationJournalV1 = {
            ...journal,
            followUp: {
                ...followUp,
                state: 'in_progress',
                attempts,
                nextAttemptAt: null,
                leaseToken,
                leaseUntil: new Date(input.now.getTime() + input.leaseMs).toISOString(),
            },
        }
        this.store(claimed)
        return { kind: 'claimed', journal: claimed, leaseToken }
    }

    async completeFollowUp(input: {
        fingerprint: string
        leaseToken: string
        task: { id: string; title: string }
    }) {
        const journal = this.journal(input.fingerprint)
        if (journal.followUp.state !== 'in_progress' || journal.followUp.leaseToken !== input.leaseToken) {
            return journal
        }
        const completed: AiCallFinalizationJournalV1 = {
            ...journal,
            followUp: {
                ...journal.followUp,
                state: 'completed',
                nextAttemptAt: null,
                leaseToken: null,
                leaseUntil: null,
                task: input.task,
                failure: null,
            },
        }
        this.call.aiAnalysis = { ...(this.call.aiAnalysis as object), created_task_id: input.task.id }
        this.store(completed)
        return completed
    }

    async failFollowUp(input: {
        fingerprint: string
        leaseToken: string
        now: Date
        retryable: boolean
        code: string
        message: string
        maxFailures: number
        retryBackoffMs: readonly number[]
    }) {
        const journal = this.journal(input.fingerprint)
        if (journal.followUp.state !== 'in_progress' || journal.followUp.leaseToken !== input.leaseToken) {
            return journal
        }
        const failures = journal.followUp.retryableFailures + (input.retryable ? 1 : 0)
        const terminal = !input.retryable || failures >= input.maxFailures
        const backoff = input.retryBackoffMs[Math.min(Math.max(0, failures - 1), input.retryBackoffMs.length - 1)] ?? 0
        const failed: AiCallFinalizationJournalV1 = {
            ...journal,
            followUp: {
                ...journal.followUp,
                state: terminal ? 'terminal_failure' : 'retry_wait',
                retryableFailures: failures,
                nextAttemptAt: terminal ? null : new Date(input.now.getTime() + backoff).toISOString(),
                leaseToken: null,
                leaseUntil: null,
                failure: {
                    code: input.code,
                    message: input.message,
                    retryable: input.retryable && !terminal,
                    at: input.now.toISOString(),
                },
            },
        }
        this.store(failed)
        return failed
    }

    async findRecoverableFollowUps(input: { now: Date; limit: number }) {
        const journal = readAiCallFinalizationJournal(this.call.metadata)
        if (!journal || !['pending', 'in_progress', 'retry_wait'].includes(journal.followUp.state)) return []
        if (
            journal.followUp.state === 'in_progress'
            && journal.followUp.leaseUntil
            && new Date(journal.followUp.leaseUntil).getTime() > input.now.getTime()
        ) return []
        if (
            journal.followUp.state === 'retry_wait'
            && journal.followUp.nextAttemptAt
            && new Date(journal.followUp.nextAttemptAt).getTime() > input.now.getTime()
        ) return []
        return [{
            callId: this.call.id,
            fingerprint: journal.fingerprint,
            followUpState: journal.followUp.state as 'pending' | 'in_progress' | 'retry_wait',
        }].slice(0, input.limit)
    }

    async countTerminalFollowUpFailures() {
        return readAiCallFinalizationJournal(this.call.metadata)?.followUp.state === 'terminal_failure' ? 1 : 0
    }

    journal(fingerprint?: string) {
        const journal = readAiCallFinalizationJournal(this.call.metadata)
        if (!journal) throw new Error('journal missing')
        if (fingerprint && journal.fingerprint !== fingerprint) throw new Error('fingerprint changed')
        return journal
    }

    private store(journal: AiCallFinalizationJournalV1) {
        this.call.metadata = metadataWithAiCallFinalizationJournal(this.call.metadata, journal)
    }
}

function harness(taskCreate?: (command: { idempotencyKey: string; data: unknown }) => Promise<{ task: { id: string; title: string } }>) {
    const persistence = new MemoryFinalizationPort()
    let nowMs = new Date('2026-08-29T10:00:00.000Z').getTime()
    const sideEffect = vi.fn().mockResolvedValue(undefined)
    const create = vi.fn(taskCreate ?? (async () => ({ task: { id: 'task-1', title: 'Call back' } })))
    const tasks = {
        create,
        isPermanentError: (error: unknown) => (error as { permanent?: boolean })?.permanent === true,
    }
    const operation = createAiCallFinalizationOperation({
        persistence,
        tasks,
        sideEffects: { onAccepted: sideEffect },
        clock: () => new Date(nowMs),
        leaseMs: 1_000,
        maxFailures: AI_CALL_FINALIZATION_MAX_FAILURES,
        retryBackoffMs: AI_CALL_FINALIZATION_RETRY_BACKOFF_MS,
    })
    const recovery = createAiCallFinalizationRecoveryOperation({
        persistence,
        tasks,
        clock: () => new Date(nowMs),
        leaseMs: 1_000,
        maxFailures: AI_CALL_FINALIZATION_MAX_FAILURES,
        retryBackoffMs: AI_CALL_FINALIZATION_RETRY_BACKOFF_MS,
    })
    return {
        persistence,
        operation,
        recovery,
        create,
        sideEffect,
        advance(ms: number) { nowMs += ms },
    }
}

describe('Calling durable single-call finalization', () => {
    it('accepts the first valid terminal result and completes one follow-up', async () => {
        const h = harness()
        await expect(h.operation('call-1', FOLLOW_UP_BODY)).resolves.toMatchObject({
            kind: 'success',
            createdTask: { id: 'task-1' },
            duplicate: false,
            followUpStatus: 'completed',
        })
        expect(h.persistence.terminal?.endedAt.toISOString()).toBe('2026-08-29T10:00:00.000Z')
        expect(h.persistence.journal().finalizationId).toBe('ai-call-finalization:v1:call-1')
        expect(h.create).toHaveBeenCalledTimes(1)
    })

    it('emits an exact valid Work Management consumer contract with deterministic identity', async () => {
        const h = harness()
        await h.operation('call-1', FOLLOW_UP_BODY)
        const emitted = h.create.mock.calls[0][0]
        expect(parseCreateIdempotentTaskCommandV1({
            contract: CREATE_IDEMPOTENT_TASK_COMMAND_V1,
            ...emitted,
        })).toMatchObject({
            idempotencyKey: 'ai-call-finalization-follow-up:v1:call-1',
            data: {
                driverId: 'driver-1',
                contactId: 'contact-1',
                source: 'auto',
                type: 'ai_call_followup',
                status: 'todo',
            },
        })
    })

    it('replays an exact duplicate without repeating Task or first-acceptance side effects', async () => {
        const h = harness()
        await h.operation('call-1', FOLLOW_UP_BODY)
        await expect(h.operation('call-1', structuredClone(FOLLOW_UP_BODY))).resolves.toMatchObject({
            kind: 'success', duplicate: true, createdTask: { id: 'task-1' },
        })
        expect(h.create).toHaveBeenCalledTimes(1)
        expect(h.sideEffect).toHaveBeenCalledTimes(1)
    })

    it('fences simultaneous equivalent callbacks to one logical finalization', async () => {
        const pending = deferred<{ task: { id: string; title: string } }>()
        const h = harness(async () => pending.promise)
        const first = h.operation('call-1', FOLLOW_UP_BODY)
        await vi.waitFor(() => expect(h.create).toHaveBeenCalledTimes(1))
        const second = await h.operation('call-1', structuredClone(FOLLOW_UP_BODY))
        expect(second).toMatchObject({ kind: 'retryable', followUpStatus: 'in_progress' })
        pending.resolve({ task: { id: 'task-1', title: 'Call back' } })
        await expect(first).resolves.toMatchObject({ kind: 'success' })
        await expect(h.operation('call-1', FOLLOW_UP_BODY)).resolves.toMatchObject({ kind: 'success', duplicate: true })
        expect(h.create).toHaveBeenCalledTimes(1)
    })

    it('rejects a conflicting terminal payload and never overwrites first-wins state', async () => {
        const h = harness()
        await h.operation('call-1', FOLLOW_UP_BODY)
        const acceptedAt = h.persistence.terminal?.endedAt
        await expect(h.operation('call-1', { ...FOLLOW_UP_BODY, reason: 'closed' })).resolves.toEqual({
            kind: 'conflict', reason: 'different_terminal_payload',
        })
        expect(h.persistence.terminal?.endedAt).toBe(acceptedAt)
        expect(h.create).toHaveBeenCalledTimes(1)
    })

    it('recovers a crash after atomic Call/journal commit but before Task creation', async () => {
        const h = harness()
        h.persistence.crashOnClaimOnce = true
        await expect(h.operation('call-1', FOLLOW_UP_BODY)).rejects.toThrow('simulated_process_crash')
        expect(h.persistence.call.status).toBe('completed')
        expect(h.persistence.journal().followUp.state).toBe('pending')
        expect(h.create).not.toHaveBeenCalled()
        await expect(h.operation('call-1', FOLLOW_UP_BODY)).resolves.toMatchObject({
            kind: 'success', duplicate: true, createdTask: { id: 'task-1' },
        })
    })

    it('recovers a lost Task-command result through owner replay without a second logical Task', async () => {
        let logicalCreates = 0
        let stored = false
        const h = harness(async () => {
            if (!stored) {
                stored = true
                logicalCreates += 1
                throw new Error('response_lost_after_task_commit')
            }
            return { task: { id: 'task-1', title: 'Call back' } }
        })
        await expect(h.operation('call-1', FOLLOW_UP_BODY)).resolves.toMatchObject({
            kind: 'retryable', followUpStatus: 'retry_wait', retryAfterMs: 500,
        })
        h.advance(500)
        await expect(h.operation('call-1', FOLLOW_UP_BODY)).resolves.toMatchObject({
            kind: 'success', createdTask: { id: 'task-1' },
        })
        expect(logicalCreates).toBe(1)
        expect(h.create).toHaveBeenCalledTimes(2)
    })

    it('backs off a retryable Task failure and then succeeds', async () => {
        let calls = 0
        const h = harness(async () => {
            if (++calls === 1) throw new Error('temporary_database_error')
            return { task: { id: 'task-1', title: 'Call back' } }
        })
        await expect(h.operation('call-1', FOLLOW_UP_BODY)).resolves.toMatchObject({
            kind: 'retryable', retryAfterMs: 500,
        })
        await expect(h.operation('call-1', FOLLOW_UP_BODY)).resolves.toMatchObject({
            kind: 'retryable', retryAfterMs: 500,
        })
        expect(h.create).toHaveBeenCalledTimes(1)
        h.advance(500)
        await expect(h.operation('call-1', FOLLOW_UP_BODY)).resolves.toMatchObject({ kind: 'success' })
        expect(h.persistence.journal().followUp.attempts).toBe(2)
    })

    it('makes a permanent Task failure inspectable and does not retry it', async () => {
        const permanent = Object.assign(new Error('invalid owner command'), { permanent: true, code: 'INVALID_CONTRACT' })
        const h = harness(async () => { throw permanent })
        await expect(h.operation('call-1', FOLLOW_UP_BODY)).resolves.toMatchObject({
            kind: 'terminal_failure',
            failure: { code: 'INVALID_CONTRACT', retryable: false },
        })
        await expect(h.operation('call-1', FOLLOW_UP_BODY)).resolves.toMatchObject({ kind: 'terminal_failure' })
        expect(h.create).toHaveBeenCalledTimes(1)
        expect(h.persistence.journal().followUp.state).toBe('terminal_failure')
    })

    it('bounds retryable Task failures and makes exhaustion terminal', async () => {
        const h = harness(async () => { throw new Error('temporary') })
        await h.operation('call-1', FOLLOW_UP_BODY)
        h.advance(500)
        await h.operation('call-1', FOLLOW_UP_BODY)
        h.advance(1_500)
        await expect(h.operation('call-1', FOLLOW_UP_BODY)).resolves.toMatchObject({ kind: 'terminal_failure' })
        expect(h.create).toHaveBeenCalledTimes(3)
        expect(h.persistence.journal().followUp.retryableFailures).toBe(3)
    })

    it('completes a no-follow-up outcome without invoking Work Management', async () => {
        const h = harness()
        await expect(h.operation('call-1', { reason: 'closed' })).resolves.toMatchObject({
            kind: 'success', createdTask: null, followUpStatus: 'not_required',
        })
        expect(h.create).not.toHaveBeenCalled()
    })

    it('fences a stale lease holder while an expired lease is safely recovered', async () => {
        const firstResult = deferred<{ task: { id: string; title: string } }>()
        let invocation = 0
        const h = harness(async () => {
            invocation += 1
            if (invocation === 1) return firstResult.promise
            return { task: { id: 'task-1', title: 'Call back' } }
        })
        const staleWorker = h.operation('call-1', FOLLOW_UP_BODY)
        await vi.waitFor(() => expect(h.create).toHaveBeenCalledTimes(1))
        h.advance(500)
        await expect(h.operation('call-1', FOLLOW_UP_BODY)).resolves.toMatchObject({
            kind: 'retryable', followUpStatus: 'in_progress', retryAfterMs: 500,
        })
        h.advance(1_500)
        await expect(h.operation('call-1', FOLLOW_UP_BODY)).resolves.toMatchObject({ kind: 'success' })
        firstResult.resolve({ task: { id: 'task-1', title: 'Call back' } })
        await expect(staleWorker).resolves.toMatchObject({ kind: 'success' })
        expect(h.persistence.journal().followUp.attempts).toBe(2)
        expect(h.persistence.journal().followUp.task?.id).toBe('task-1')
    })

    it('refuses to overwrite an already AI-terminal legacy Call without a journal', async () => {
        const h = harness()
        h.persistence.call.aiSessionStatus = 'ended'
        h.persistence.call.aiOutcome = 'qualified'
        await expect(h.operation('call-1', FOLLOW_UP_BODY)).resolves.toEqual({
            kind: 'conflict', reason: 'legacy_terminal_without_journal',
        })
        expect(h.persistence.call.metadata).not.toHaveProperty(AI_CALL_FINALIZATION_METADATA_KEY)
        expect(h.create).not.toHaveBeenCalled()
    })

    it('accepts the first terminal payload after the non-terminal transferring state', async () => {
        const h = harness()
        h.persistence.call.aiSessionStatus = 'transferring'
        await expect(h.operation('call-1', { ...FOLLOW_UP_BODY, reason: 'transferred' })).resolves.toMatchObject({
            kind: 'success', sessionStatus: 'transferring', duplicate: false,
        })
        expect(h.persistence.journal().sessionStatus).toBe('transferring')
    })

    it('does not replay a legacy completed transfer that already has AI analysis but no journal', async () => {
        const h = harness()
        h.persistence.call.aiSessionStatus = 'transferring'
        h.persistence.call.aiAnalysis = { qualification_status: 'unclear' }
        await expect(h.operation('call-1', { ...FOLLOW_UP_BODY, reason: 'transferred' })).resolves.toEqual({
            kind: 'conflict', reason: 'legacy_terminal_without_journal',
        })
        expect(h.create).not.toHaveBeenCalled()
    })

    it('fails closed when durable journal identity or lease metadata is malformed', () => {
        const h = harness()
        h.persistence.call.metadata = {
            aiCallFinalizationV1: {
                version: 1,
                finalizationId: 'wall-clock-derived-id',
                fingerprint: 'not-a-sha',
                acceptedAt: 'invalid-date',
                sessionStatus: 'ended',
                followUp: {},
            },
        }
        expect(readAiCallFinalizationJournal(h.persistence.call.metadata)).toBeNull()
    })

    it.each([
        null,
        [],
        { reason: '' },
        { reason: 'completed', result: { qualification_status: 'maybe' } },
        { reason: 'completed', realUserUtterances: -1 },
        { reason: 'completed', transcript: [{ role: 'tool', content: 'x' }] },
        { reason: 'completed', events: {} },
    ])('rejects malformed finalization payload %# before persistence', async (body) => {
        const h = harness()
        await expect(h.operation('call-1', body)).rejects.toMatchObject({ code: 'INVALID_FINALIZATION_PAYLOAD' })
        expect(h.persistence.call.metadata).not.toHaveProperty(AI_CALL_FINALIZATION_METADATA_KEY)
    })
})

describe('Calling finalization-specific crash recovery', () => {
    it('discovers pending work after restart without another Bridge finalize callback', async () => {
        const h = harness()
        h.persistence.crashOnClaimOnce = true
        await expect(h.operation('call-1', FOLLOW_UP_BODY)).rejects.toThrow('simulated_process_crash')
        expect(h.persistence.journal().followUp.state).toBe('pending')

        await expect(h.recovery()).resolves.toMatchObject({ discovered: 1, completed: 1, errors: 0 })
        expect(h.persistence.journal().followUp.state).toBe('completed')
        expect(h.create).toHaveBeenCalledTimes(1)
    })

    it('reclaims a stale in-progress lease while fencing the old worker result', async () => {
        const firstResult = deferred<{ task: { id: string; title: string } }>()
        let invocation = 0
        const h = harness(async () => {
            invocation += 1
            if (invocation === 1) return firstResult.promise
            return { task: { id: 'task-1', title: 'Call back' } }
        })
        const crashedWorker = h.operation('call-1', FOLLOW_UP_BODY)
        await vi.waitFor(() => expect(h.persistence.journal().followUp.state).toBe('in_progress'))
        h.advance(1_001)
        await expect(h.recovery()).resolves.toMatchObject({ discovered: 1, completed: 1 })
        firstResult.resolve({ task: { id: 'stale-task', title: 'Stale' } })
        await crashedWorker
        expect(h.persistence.journal().followUp).toMatchObject({
            state: 'completed', attempts: 2, task: { id: 'task-1' },
        })
    })

    it('discovers retry_wait only when its deterministic due time is reached', async () => {
        let calls = 0
        const h = harness(async () => {
            if (++calls === 1) throw new Error('temporary')
            return { task: { id: 'task-1', title: 'Call back' } }
        })
        await h.operation('call-1', FOLLOW_UP_BODY)
        await expect(h.recovery()).resolves.toMatchObject({ discovered: 0, completed: 0 })
        h.advance(500)
        await expect(h.recovery()).resolves.toMatchObject({ discovered: 1, completed: 1 })
        expect(h.create).toHaveBeenCalledTimes(2)
    })

    it('does not replay completed or not-required journals', async () => {
        const completed = harness()
        await completed.operation('call-1', FOLLOW_UP_BODY)
        await expect(completed.recovery()).resolves.toMatchObject({ discovered: 0 })
        expect(completed.create).toHaveBeenCalledTimes(1)

        const notRequired = harness()
        await notRequired.operation('call-1', { reason: 'closed' })
        await expect(notRequired.recovery()).resolves.toMatchObject({ discovered: 0 })
        expect(notRequired.create).not.toHaveBeenCalled()
    })

    it('keeps terminal failure visible without endlessly retrying it', async () => {
        const permanent = Object.assign(new Error('invalid'), { permanent: true, code: 'INVALID_CONTRACT' })
        const h = harness(async () => { throw permanent })
        await h.operation('call-1', FOLLOW_UP_BODY)
        await expect(h.recovery()).resolves.toMatchObject({
            discovered: 0, terminalFailuresVisible: 1,
        })
        expect(h.create).toHaveBeenCalledTimes(1)
    })
})

describe('Calling finalization transcript reconciliation', () => {
    it('reconciles deterministic receipts in ordinal order before terminal acceptance', async () => {
        const order: string[] = []
        const appendTranscript = vi.fn(async (_callId: string, item: AiCallTranscriptMessageInput) => {
            order.push(`transcript:${item.ordinal}`)
        })
        const finalize = vi.fn(async () => {
            order.push('finalize')
            return {
                kind: 'success' as const,
                callId: 'call-1',
                sessionStatus: 'ended' as const,
                createdTask: null,
                duplicate: false,
                followUpStatus: 'not_required' as const,
            }
        })
        const operation = createAiCallFinalizationWithTranscriptReconciliation({
            appendTranscript,
            finalize,
        })
        await operation('call-1', {
            reason: 'closed',
            transcriptItems: [
                { messageId: 'm2', ordinal: 2, role: 'assistant', content: 'second', final: true },
                { messageId: 'm1', ordinal: 1, role: 'user', content: 'first', final: true },
            ],
        })
        expect(order).toEqual(['transcript:1', 'transcript:2', 'finalize'])
        expect(finalize).toHaveBeenCalledTimes(1)
    })
})
