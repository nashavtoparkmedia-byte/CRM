/* eslint-disable @typescript-eslint/no-explicit-any -- Prisma client can lag AI-call model generation */
import { prisma } from '@/lib/prisma'
import {
    AI_CALL_FINALIZATION_METADATA_KEY,
    metadataWithAiCallFinalizationJournal,
    readAiCallFinalizationJournal,
    type AiCallFinalizationJournalV1,
    type AiCallFinalizationPersistencePort,
    type FollowUpClaim,
} from '../../application/ai-call-finalization'

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasJournalKey(metadata: unknown): boolean {
    return isRecord(metadata) && Object.prototype.hasOwnProperty.call(metadata, AI_CALL_FINALIZATION_METADATA_KEY)
}

function requireJournal(metadata: unknown, fingerprint: string): AiCallFinalizationJournalV1 {
    const journal = readAiCallFinalizationJournal(metadata)
    if (!journal) throw new Error('AI call finalization journal is missing or corrupt')
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

export const aiCallFinalizationPrismaPort: AiCallFinalizationPersistencePort = {
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
                    metadata: metadataWithAiCallFinalizationJournal(call.metadata, input.journal),
                },
            })
            return { kind: 'accepted' as const, journal: input.journal }
        })
    },

    async claimFollowUp(input): Promise<FollowUpClaim> {
        return withLockedCall(input.callId, async (tx, call) => {
            const journal = requireJournal(call.metadata, input.fingerprint)
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
            const journal = requireJournal(call.metadata, input.fingerprint)
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
            const journal = requireJournal(call.metadata, input.fingerprint)
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
}
