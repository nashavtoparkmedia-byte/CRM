/* eslint-disable @typescript-eslint/no-explicit-any -- Prisma client can lag AI-call model generation */
import { prisma } from '@/lib/prisma'
import {
    AI_CALL_FINALIZATION_METADATA_KEY,
    metadataWithAiCallFinalizationJournal,
    readAiCallFinalizationJournal,
    type AiCallFinalizationJournalV1,
    type AiCallFinalizationRecoveryPersistencePort,
    type FollowUpClaim,
} from '../../application/ai-call-finalization'
import {
    AI_CALL_LIFECYCLE_METADATA_KEY,
    aiCallLifecycleId,
    applyAiCallLifecycleEvent,
    createAiCallLifecycleJournal,
    finalizationLifecycleEvent,
    lifecycleStateFromCurrent,
    metadataWithAiCallLifecycleJournal,
    readAiCallLifecycleJournal,
} from '../../application/ai-call-lifecycle'

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasJournalKey(metadata: unknown): boolean {
    return isRecord(metadata) && Object.prototype.hasOwnProperty.call(metadata, AI_CALL_FINALIZATION_METADATA_KEY)
}

function terminalMetadata(input: {
    callId: string
    fingerprint: string
    target: 'ended' | 'failed' | 'transferring'
    currentSessionStatus: unknown
    metadata: unknown
    finalizationJournal: AiCallFinalizationJournalV1
}): Record<string, unknown> {
    const existingLifecycle = readAiCallLifecycleJournal(input.metadata)
    if (!existingLifecycle && isRecord(input.metadata)
        && Object.prototype.hasOwnProperty.call(input.metadata, AI_CALL_LIFECYCLE_METADATA_KEY)) {
        throw new Error('AI call lifecycle journal is corrupt')
    }
    if (existingLifecycle
        && (existingLifecycle.lifecycleId !== aiCallLifecycleId(input.callId)
            || existingLifecycle.state !== lifecycleStateFromCurrent(input.currentSessionStatus))) {
        throw new Error('AI call lifecycle projection diverged from journal')
    }
    const lifecycle = existingLifecycle ?? createAiCallLifecycleJournal(
        input.callId,
        lifecycleStateFromCurrent(input.currentSessionStatus),
    )
    const lifecycleResult = applyAiCallLifecycleEvent(lifecycle, finalizationLifecycleEvent({
        callId: input.callId,
        fingerprint: input.fingerprint,
        target: input.target,
    }))
    const withFinalization = metadataWithAiCallFinalizationJournal(input.metadata, input.finalizationJournal)
    return metadataWithAiCallLifecycleJournal(withFinalization, lifecycleResult.journal)
}

function requireJournal(metadata: unknown, callId: string, fingerprint: string): AiCallFinalizationJournalV1 {
    const journal = readAiCallFinalizationJournal(metadata)
    if (!journal) throw new Error('AI call finalization journal is missing or corrupt')
    if (journal.finalizationId !== `ai-call-finalization:v1:${callId}`
        || (journal.followUp.state !== 'not_required'
            && journal.followUp.idempotencyKey !== `ai-call-finalization-follow-up:v1:${callId}`)) {
        throw new Error('AI call finalization journal belongs to another aggregate')
    }
    if (journal.fingerprint !== fingerprint) throw new Error('AI call finalization fingerprint changed')
    return journal
}

async function withLockedCall<T>(callId: string, operation: (tx: any, call: any) => Promise<T>): Promise<T> {
    return (prisma as any).$transaction(async (tx: any) => {
        await tx.$queryRaw`SELECT "id" FROM "Call" WHERE "id" = ${callId} FOR UPDATE`
        const call = await tx.call.findUnique({
            where: { id: callId },
            select: {
                id: true,
                status: true,
                endedAt: true,
                aiSessionStatus: true,
                aiOutcome: true,
                aiAnalysis: true,
                metadata: true,
            },
        })
        if (!call) throw new Error('AI call disappeared while finalization row was locked')
        return operation(tx, call)
    })
}

function clearLease(journal: AiCallFinalizationJournalV1): AiCallFinalizationJournalV1['followUp'] {
    return {
        ...journal.followUp,
        leaseToken: null,
        leaseUntil: null,
    }
}

export const aiCallFinalizationPrismaPort: AiCallFinalizationRecoveryPersistencePort = {
    async findCall(callId) {
        return (prisma as any).call.findUnique({
            where: { id: callId },
            select: {
                id: true,
                status: true,
                startedAt: true,
                endedAt: true,
                aiSessionStatus: true,
                aiOutcome: true,
                driverId: true,
                contactId: true,
                managerId: true,
                aiScenarioId: true,
                transcript: true,
                metadata: true,
                aiScenario: { select: { outcomeSchema: true } },
            },
        })
    },

    async accept(input) {
        return (prisma as any).$transaction(async (tx: any) => {
            await tx.$queryRaw`SELECT "id" FROM "Call" WHERE "id" = ${input.callId} FOR UPDATE`
            const call = await tx.call.findUnique({
                where: { id: input.callId },
                select: {
                    id: true,
                    status: true,
                    endedAt: true,
                    aiSessionStatus: true,
                    aiOutcome: true,
                    aiAnalysis: true,
                    metadata: true,
                },
            })
            if (!call) return { kind: 'not_found' as const }

            const existing = readAiCallFinalizationJournal(call.metadata)
            if (existing) {
                if (existing.finalizationId !== `ai-call-finalization:v1:${input.callId}`
                    || (existing.followUp.state !== 'not_required'
                        && existing.followUp.idempotencyKey !== `ai-call-finalization-follow-up:v1:${input.callId}`)) {
                    throw new Error('AI call finalization journal belongs to another aggregate')
                }
                return existing.fingerprint === input.fingerprint
                    ? { kind: 'duplicate' as const, journal: existing }
                    : { kind: 'conflict' as const }
            }
            if (hasJournalKey(call.metadata)) {
                throw new Error('AI call finalization journal is corrupt')
            }
            if (
                ['ended', 'failed'].includes(String(call.aiSessionStatus))
                || call.aiOutcome !== null
                || (call.aiSessionStatus === 'transferring'
                    && call.aiAnalysis !== null
                    && call.aiAnalysis !== undefined)
            ) {
                return { kind: 'legacy_terminal' as const }
            }

            await tx.call.update({
                where: { id: input.callId },
                data: {
                    ...input.terminal,
                    metadata: terminalMetadata({
                        callId: input.callId,
                        fingerprint: input.fingerprint,
                        target: input.terminal.aiSessionStatus,
                        currentSessionStatus: call.aiSessionStatus,
                        metadata: call.metadata,
                        finalizationJournal: input.journal,
                    }),
                },
            })
            return { kind: 'accepted' as const, journal: input.journal }
        })
    },

    async claimFollowUp(input): Promise<FollowUpClaim> {
        return withLockedCall(input.callId, async (tx, call) => {
            const journal = requireJournal(call.metadata, input.callId, input.fingerprint)
            const followUp = journal.followUp
            if (['not_required', 'completed', 'terminal_failure'].includes(followUp.state)) {
                return { kind: 'settled' as const, journal }
            }

            const nowMs = input.now.getTime()
            if (
                followUp.state === 'in_progress'
                && followUp.leaseUntil
                && new Date(followUp.leaseUntil).getTime() > nowMs
            ) return { kind: 'busy' as const, journal }
            if (
                followUp.state === 'retry_wait'
                && followUp.nextAttemptAt
                && new Date(followUp.nextAttemptAt).getTime() > nowMs
            ) return { kind: 'not_due' as const, journal }

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
                    leaseUntil: new Date(nowMs + input.leaseMs).toISOString(),
                },
            }
            await tx.call.update({
                where: { id: input.callId },
                data: { metadata: metadataWithAiCallFinalizationJournal(call.metadata, claimed) },
            })
            return { kind: 'claimed' as const, journal: claimed, leaseToken }
        })
    },

    async completeFollowUp(input) {
        return withLockedCall(input.callId, async (tx, call) => {
            const journal = requireJournal(call.metadata, input.callId, input.fingerprint)
            if (journal.followUp.state !== 'in_progress' || journal.followUp.leaseToken !== input.leaseToken) {
                return journal
            }
            const completed: AiCallFinalizationJournalV1 = {
                ...journal,
                followUp: {
                    ...clearLease(journal),
                    state: 'completed',
                    nextAttemptAt: null,
                    task: input.task,
                    failure: null,
                },
            }
            const analysis = isRecord(call.aiAnalysis)
                ? { ...call.aiAnalysis, created_task_id: input.task.id }
                : call.aiAnalysis
            await tx.call.update({
                where: { id: input.callId },
                data: {
                    aiAnalysis: analysis,
                    metadata: metadataWithAiCallFinalizationJournal(call.metadata, completed),
                },
            })
            return completed
        })
    },

    async failFollowUp(input) {
        return withLockedCall(input.callId, async (tx, call) => {
            const journal = requireJournal(call.metadata, input.callId, input.fingerprint)
            if (journal.followUp.state !== 'in_progress' || journal.followUp.leaseToken !== input.leaseToken) {
                return journal
            }
            const retryableFailures = journal.followUp.retryableFailures + (input.retryable ? 1 : 0)
            const terminal = !input.retryable || retryableFailures >= input.maxFailures
            const backoffIndex = Math.max(0, retryableFailures - 1)
            const backoffMs = input.retryBackoffMs[Math.min(backoffIndex, input.retryBackoffMs.length - 1)] ?? 0
            const failure = {
                code: input.code,
                message: input.message,
                retryable: input.retryable && !terminal,
                at: input.now.toISOString(),
            }
            const failed: AiCallFinalizationJournalV1 = {
                ...journal,
                followUp: {
                    ...clearLease(journal),
                    state: terminal ? 'terminal_failure' : 'retry_wait',
                    retryableFailures,
                    nextAttemptAt: terminal ? null : new Date(input.now.getTime() + backoffMs).toISOString(),
                    failure,
                },
            }
            await tx.call.update({
                where: { id: input.callId },
                data: { metadata: metadataWithAiCallFinalizationJournal(call.metadata, failed) },
            })
            return failed
        })
    },

    async findRecoverableFollowUps(input) {
        const now = input.now.toISOString()
        const rows = await (prisma as any).$queryRaw<Array<{ id: string; metadata: unknown }>>`
            SELECT "id", "metadata"
            FROM "Call"
            WHERE "isAi" = TRUE
              AND (
                "metadata"->'aiCallFinalizationV1'->'followUp'->>'state' = 'pending'
                OR (
                  "metadata"->'aiCallFinalizationV1'->'followUp'->>'state' = 'in_progress'
                  AND "metadata"->'aiCallFinalizationV1'->'followUp'->>'leaseUntil' <= ${now}
                )
                OR (
                  "metadata"->'aiCallFinalizationV1'->'followUp'->>'state' = 'retry_wait'
                  AND "metadata"->'aiCallFinalizationV1'->'followUp'->>'nextAttemptAt' <= ${now}
                )
              )
            ORDER BY "updatedAt" ASC, "id" ASC
            LIMIT ${input.limit}
        `
        return rows.flatMap((row: { id: string; metadata: unknown }) => {
            const journal = readAiCallFinalizationJournal(row.metadata)
            if (!journal
                || journal.finalizationId !== `ai-call-finalization:v1:${row.id}`
                || journal.followUp.idempotencyKey !== `ai-call-finalization-follow-up:v1:${row.id}`
                || !['pending', 'in_progress', 'retry_wait'].includes(journal.followUp.state)) return []
            return [{
                callId: row.id,
                fingerprint: journal.fingerprint,
                followUpState: journal.followUp.state as 'pending' | 'in_progress' | 'retry_wait',
            }]
        })
    },

    async countTerminalFollowUpFailures() {
        const rows = await (prisma as any).$queryRaw<Array<{ count: bigint | number }>>`
            SELECT COUNT(*) AS "count"
            FROM "Call"
            WHERE "isAi" = TRUE
              AND "metadata"->'aiCallFinalizationV1'->'followUp'->>'state' = 'terminal_failure'
        `
        return Number(rows[0]?.count ?? 0)
    },
}
