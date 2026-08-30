import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiCallFinalizationJournalV1, AiCallTerminalUpdate } from '../../application/ai-call-finalization'
import {
    aiCallTranscriptSnapshotSha256,
    createAiCallTranscriptJournal,
    reconcileAiCallTranscriptJournal,
} from '../../application/ai-call-transcript'

const mocks = vi.hoisted(() => {
    const tx = {
        $queryRaw: vi.fn(),
        call: { findUnique: vi.fn(), update: vi.fn() },
        domainOutboxEvent: { create: vi.fn() },
    }
    return {
        tx,
        callFindUnique: vi.fn(),
        transaction: vi.fn(async (operation: (value: typeof tx) => unknown) => operation(tx)),
    }
})
vi.mock('@/lib/prisma', () => ({
    prisma: {
        call: { findUnique: mocks.callFindUnique },
        $transaction: mocks.transaction,
    },
}))

import { aiCallFinalizationPrismaPort } from './ai-call-finalization-prisma-adapter'

const JOURNAL: AiCallFinalizationJournalV1 = {
    version: 1,
    finalizationId: 'ai-call-finalization:v1:call-1',
    fingerprint: 'a'.repeat(64),
    acceptedAt: '2026-08-29T10:00:00.000Z',
    sessionStatus: 'ended',
    transcriptRevision: 0,
    transcriptSnapshotSha256: aiCallTranscriptSnapshotSha256(createAiCallTranscriptJournal('call-1')),
    followUp: {
        state: 'pending',
        idempotencyKey: 'ai-call-finalization-follow-up:v1:call-1',
        taskData: { driverId: 'driver-1', source: 'auto', type: 'ai_call_followup', title: 'Call back' },
        attempts: 0,
        retryableFailures: 0,
        nextAttemptAt: null,
        leaseToken: null,
        leaseUntil: null,
        task: null,
        failure: null,
    },
}

const TERMINAL: AiCallTerminalUpdate = {
    status: 'completed',
    endedAt: new Date('2026-08-29T10:00:00.000Z'),
    durationSec: 10,
    hangupCause: 'NORMAL_CLEARING',
    aiSessionStatus: 'ended',
    aiAnalysis: { qualification_status: 'qualified' },
    aiSummary: 'Ready',
    aiTransferReason: null,
    aiOutcome: 'qualified',
    aiOutcomeReason: 'llm_qualified',
    qualificationScore: 88,
    leadDataStructured: {},
}

describe('Calling Prisma finalization journal adapter', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.tx.$queryRaw.mockResolvedValue([{ id: 'call-1' }])
        mocks.tx.call.update.mockResolvedValue({})
        mocks.tx.domainOutboxEvent.create.mockResolvedValue({})
    })

    it('atomically locks and writes terminal Call fields with the journal', async () => {
        mocks.tx.call.findUnique.mockResolvedValue({
            id: 'call-1', status: 'connected', endedAt: null, aiSessionStatus: null, aiOutcome: null,
            metadata: { originate: 'kept' },
        })
        await expect(aiCallFinalizationPrismaPort.accept({
            callId: 'call-1', fingerprint: JOURNAL.fingerprint, journal: JOURNAL, terminal: TERMINAL,
        })).resolves.toEqual({ kind: 'accepted', journal: JOURNAL })
        expect(mocks.transaction).toHaveBeenCalledTimes(1)
        expect(mocks.tx.$queryRaw).toHaveBeenCalledTimes(1)
        expect(mocks.tx.call.update).toHaveBeenCalledWith({
            where: { id: 'call-1' },
            data: {
                ...TERMINAL,
                metadata: expect.objectContaining({
                    originate: 'kept',
                    aiCallFinalizationV1: JOURNAL,
                    aiCallLifecycleV1: expect.objectContaining({
                        state: 'ended',
                        revision: 1,
                        terminal: expect.objectContaining({ kind: 'finalized' }),
                    }),
                }),
            },
        })
        expect(mocks.tx.$queryRaw.mock.invocationCallOrder[0])
            .toBeLessThan(mocks.tx.call.update.mock.invocationCallOrder[0])
        expect(mocks.tx.domainOutboxEvent.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                eventId: 'calling.AiCallFinalizationFollowUpRequested.v1:call-1',
                eventType: 'calling.AiCallFinalizationFollowUpRequested.v1',
                aggregateType: 'Call',
                aggregateId: 'call-1',
                maxAttempts: 5,
            }),
        })
        expect(mocks.tx.call.update.mock.invocationCallOrder[0])
            .toBeLessThan(mocks.tx.domainOutboxEvent.create.mock.invocationCallOrder[0])
    })

    it('replays the accepted journal without rewriting Call terminal state', async () => {
        mocks.tx.call.findUnique.mockResolvedValue({
            id: 'call-1', status: 'completed', endedAt: TERMINAL.endedAt, aiSessionStatus: 'ended',
            aiOutcome: 'qualified', metadata: { aiCallFinalizationV1: JOURNAL },
        })
        await expect(aiCallFinalizationPrismaPort.accept({
            callId: 'call-1', fingerprint: JOURNAL.fingerprint, journal: JOURNAL, terminal: TERMINAL,
        })).resolves.toEqual({ kind: 'duplicate', journal: JOURNAL })
        expect(mocks.tx.call.update).not.toHaveBeenCalled()
        expect(mocks.tx.domainOutboxEvent.create).not.toHaveBeenCalled()
    })

    it('fails the atomic acceptance if the deterministic recovery event identity is occupied', async () => {
        mocks.tx.call.findUnique.mockResolvedValue({
            id: 'call-1', status: 'connected', endedAt: null, aiSessionStatus: null, aiOutcome: null,
            metadata: {},
        })
        mocks.tx.domainOutboxEvent.create.mockRejectedValueOnce(new Error('unique eventId violation'))
        await expect(aiCallFinalizationPrismaPort.accept({
            callId: 'call-1', fingerprint: JOURNAL.fingerprint, journal: JOURNAL, terminal: TERMINAL,
        })).rejects.toThrow(/unique eventId violation/)
        expect(mocks.tx.call.update).toHaveBeenCalledTimes(1)
        expect(mocks.tx.domainOutboxEvent.create).toHaveBeenCalledTimes(1)
    })

    it('fails closed when a valid finalization journal is transplanted from another Call', async () => {
        const transplanted = {
            ...JOURNAL,
            finalizationId: 'ai-call-finalization:v1:call-other',
            followUp: {
                ...JOURNAL.followUp,
                idempotencyKey: 'ai-call-finalization-follow-up:v1:call-other',
            },
        }
        mocks.tx.call.findUnique.mockResolvedValue({
            id: 'call-1', status: 'completed', endedAt: TERMINAL.endedAt, aiSessionStatus: 'ended',
            aiOutcome: 'qualified', metadata: { aiCallFinalizationV1: transplanted },
        })
        await expect(aiCallFinalizationPrismaPort.accept({
            callId: 'call-1', fingerprint: JOURNAL.fingerprint, journal: JOURNAL, terminal: TERMINAL,
        })).rejects.toThrow(/belongs to another aggregate/)
        expect(mocks.tx.call.update).not.toHaveBeenCalled()
    })

    it('rejects a different payload while the locked first-wins journal remains unchanged', async () => {
        mocks.tx.call.findUnique.mockResolvedValue({
            id: 'call-1', status: 'completed', endedAt: TERMINAL.endedAt, aiSessionStatus: 'ended',
            aiOutcome: 'qualified', metadata: { aiCallFinalizationV1: JOURNAL },
        })
        await expect(aiCallFinalizationPrismaPort.accept({
            callId: 'call-1', fingerprint: 'different', journal: JOURNAL, terminal: TERMINAL,
        })).resolves.toEqual({ kind: 'conflict' })
        expect(mocks.tx.call.update).not.toHaveBeenCalled()
    })

    it('claims pending work with a monotonic fenced lease', async () => {
        mocks.tx.call.findUnique.mockResolvedValue({
            id: 'call-1', status: 'completed', endedAt: TERMINAL.endedAt, aiSessionStatus: 'ended',
            aiOutcome: 'qualified', aiAnalysis: TERMINAL.aiAnalysis,
            metadata: { aiCallFinalizationV1: JOURNAL },
        })
        const result = await aiCallFinalizationPrismaPort.claimFollowUp({
            callId: 'call-1',
            fingerprint: JOURNAL.fingerprint,
            now: new Date('2026-08-29T10:00:01.000Z'),
            leaseMs: 1_000,
        })
        expect(result).toMatchObject({
            kind: 'claimed',
            leaseToken: 'ai-call-finalization:v1:call-1:attempt:1',
            journal: {
                followUp: {
                    state: 'in_progress',
                    attempts: 1,
                    leaseUntil: '2026-08-29T10:00:02.000Z',
                },
            },
        })
        expect(mocks.tx.call.update).toHaveBeenCalledTimes(1)
    })

    it('correlates successful Task replay back into journal and Call analysis', async () => {
        const inProgress: AiCallFinalizationJournalV1 = {
            ...JOURNAL,
            followUp: {
                ...JOURNAL.followUp,
                state: 'in_progress',
                attempts: 1,
                leaseToken: 'ai-call-finalization:v1:call-1:attempt:1',
                leaseUntil: '2026-08-29T10:00:02.000Z',
            },
        }
        mocks.tx.call.findUnique.mockResolvedValue({
            id: 'call-1', status: 'completed', endedAt: TERMINAL.endedAt, aiSessionStatus: 'ended',
            aiOutcome: 'qualified', aiAnalysis: TERMINAL.aiAnalysis,
            metadata: { aiCallFinalizationV1: inProgress },
        })
        const result = await aiCallFinalizationPrismaPort.completeFollowUp({
            callId: 'call-1',
            fingerprint: JOURNAL.fingerprint,
            leaseToken: inProgress.followUp.leaseToken!,
            task: { id: 'task-1', title: 'Call back' },
            now: new Date('2026-08-29T10:00:01.500Z'),
        })
        expect(result.followUp).toMatchObject({
            state: 'completed',
            leaseToken: null,
            leaseUntil: null,
            task: { id: 'task-1', title: 'Call back' },
        })
        expect(mocks.tx.call.update).toHaveBeenCalledWith({
            where: { id: 'call-1' },
            data: expect.objectContaining({
                aiAnalysis: { qualification_status: 'qualified', created_task_id: 'task-1' },
                metadata: expect.objectContaining({
                    aiCallFinalizationV1: expect.objectContaining({
                        followUp: expect.objectContaining({ state: 'completed' }),
                    }),
                }),
            }),
        })
    })

    it('persists bounded retry state and clears the failed lease', async () => {
        const inProgress: AiCallFinalizationJournalV1 = {
            ...JOURNAL,
            followUp: {
                ...JOURNAL.followUp,
                state: 'in_progress',
                attempts: 1,
                leaseToken: 'ai-call-finalization:v1:call-1:attempt:1',
                leaseUntil: '2026-08-29T10:00:02.000Z',
            },
        }
        mocks.tx.call.findUnique.mockResolvedValue({
            id: 'call-1', status: 'completed', endedAt: TERMINAL.endedAt, aiSessionStatus: 'ended',
            aiOutcome: 'qualified', aiAnalysis: TERMINAL.aiAnalysis,
            metadata: { aiCallFinalizationV1: inProgress },
        })
        const result = await aiCallFinalizationPrismaPort.failFollowUp({
            callId: 'call-1',
            fingerprint: JOURNAL.fingerprint,
            leaseToken: inProgress.followUp.leaseToken!,
            now: new Date('2026-08-29T10:00:01.500Z'),
            retryable: true,
            code: 'TASK_COMMAND_TRANSIENT_FAILURE',
            message: 'Work Management task creation did not complete',
            maxFailures: 3,
            retryBackoffMs: [500, 1_500],
        })
        expect(result.followUp).toMatchObject({
            state: 'retry_wait',
            retryableFailures: 1,
            nextAttemptAt: '2026-08-29T10:00:02.000Z',
            leaseToken: null,
            leaseUntil: null,
        })
    })

    it('ignores stale completion tokens after a newer lease has completed', async () => {
        const completed: AiCallFinalizationJournalV1 = {
            ...JOURNAL,
            followUp: { ...JOURNAL.followUp, state: 'completed', task: { id: 'task-1', title: 'Call back' } },
        }
        mocks.tx.call.findUnique.mockResolvedValue({
            id: 'call-1', status: 'completed', endedAt: TERMINAL.endedAt, aiSessionStatus: 'ended',
            aiOutcome: 'qualified', aiAnalysis: TERMINAL.aiAnalysis,
            metadata: { aiCallFinalizationV1: completed },
        })
        await expect(aiCallFinalizationPrismaPort.completeFollowUp({
            callId: 'call-1',
            fingerprint: JOURNAL.fingerprint,
            leaseToken: 'stale-token',
            task: { id: 'task-old', title: 'Old' },
            now: new Date('2026-08-29T10:00:10.000Z'),
        })).resolves.toEqual(completed)
        expect(mocks.tx.call.update).not.toHaveBeenCalled()
    })

    it('rejects acceptance when the locked transcript revision changed after snapshot', async () => {
        const transcript = reconcileAiCallTranscriptJournal(
            'call-1',
            createAiCallTranscriptJournal('call-1'),
            {
                messageId: 'm1', ordinal: 1, segmentRevision: 1, role: 'user',
                content: 'late', final: true, source: 'audio_bridge',
            },
            false,
        ).journal
        mocks.tx.call.findUnique.mockResolvedValue({
            id: 'call-1', status: 'connected', endedAt: null, aiSessionStatus: null, aiOutcome: null,
            metadata: { aiCallTranscriptV1: transcript },
        })
        await expect(aiCallFinalizationPrismaPort.accept({
            callId: 'call-1', fingerprint: JOURNAL.fingerprint, journal: JOURNAL, terminal: TERMINAL,
        })).resolves.toEqual({ kind: 'transcript_changed' })
        expect(mocks.tx.call.update).not.toHaveBeenCalled()
        expect(mocks.tx.domainOutboxEvent.create).not.toHaveBeenCalled()
    })
})
