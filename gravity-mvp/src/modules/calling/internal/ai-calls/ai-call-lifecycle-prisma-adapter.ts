/* eslint-disable @typescript-eslint/no-explicit-any -- Prisma client can lag AI-call model generation */
import { prisma } from '@/lib/prisma'
import {
    AI_CALL_LIFECYCLE_METADATA_KEY,
    AiCallLifecycleConflictError,
    applyAiCallLifecycleEvent,
    aiCallLifecycleId,
    createAiCallLifecycleJournal,
    lifecycleStateFromCurrent,
    metadataWithAiCallLifecycleJournal,
    readAiCallLifecycleJournal,
    type AiCallLifecycleEventInput,
    type AiCallLifecycleState,
    type AiCallLifecyclePersistencePort,
} from '../../application/ai-call-lifecycle'

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasLifecycleKey(metadata: unknown): boolean {
    return isRecord(metadata) && Object.prototype.hasOwnProperty.call(metadata, AI_CALL_LIFECYCLE_METADATA_KEY)
}

function bootstrapJournal(
    callId: string,
    aiSessionStatus: unknown,
    metadata: unknown,
    event: AiCallLifecycleEventInput,
) {
    const existing = readAiCallLifecycleJournal(metadata)
    if (existing) {
        if (existing.lifecycleId !== aiCallLifecycleId(callId)
            || existing.state !== lifecycleStateFromCurrent(aiSessionStatus)) {
            throw new AiCallLifecycleConflictError('identity_collision', 'lifecycle projection diverged from journal')
        }
        return existing
    }
    if (hasLifecycleKey(metadata)) {
        throw new AiCallLifecycleConflictError('identity_collision', 'AI call lifecycle journal is corrupt')
    }
    const state = lifecycleStateFromCurrent(aiSessionStatus)
    if (event.source === 'audio_bridge' && state === event.target) {
        const predecessor: AiCallLifecycleState = state === 'greeting' ? 'starting'
            : state === 'active' ? 'greeting'
                : state === 'transferring' ? 'active' : state
        return createAiCallLifecycleJournal(callId, predecessor, ['ended', 'failed'].includes(predecessor))
    }
    const journal = createAiCallLifecycleJournal(callId, state, ['ended', 'failed'].includes(state))
    const currentBridgeSequence = state === 'greeting' ? 1 : state === 'active' ? 2 : state === 'transferring' ? 3 : 0
    return currentBridgeSequence > 0
        ? { ...journal, sourceWatermarks: { audio_bridge: currentBridgeSequence } }
        : journal
}

export const aiCallLifecyclePrismaPort: AiCallLifecyclePersistencePort = {
    async apply(callId, event) {
        return (prisma as any).$transaction(async (tx: any) => {
            await tx.$queryRaw`SELECT "id" FROM "Call" WHERE "id" = ${callId} FOR UPDATE`
            const call = await tx.call.findUnique({
                where: { id: callId },
                select: { id: true, isAi: true, aiSessionStatus: true, metadata: true },
            })
            if (!call || !call.isAi) return { kind: 'not_found' as const }

            const journal = bootstrapJournal(callId, call.aiSessionStatus, call.metadata, event)
            const result = applyAiCallLifecycleEvent(journal, event)
            if (result.kind !== 'duplicate') {
                const metadata = metadataWithAiCallLifecycleJournal(call.metadata, result.journal)
                if (result.kind !== 'applied') {
                    await tx.call.update({ where: { id: callId }, data: { metadata } })
                } else if (event.kind === 'call_cancelled') {
                    await tx.call.update({
                        where: { id: callId },
                        data: { aiSessionStatus: 'failed', status: 'cancelled', metadata },
                    })
                } else if (event.kind === 'call_timed_out') {
                    await tx.call.update({
                        where: { id: callId },
                        data: { aiSessionStatus: 'failed', status: 'no_answer', metadata },
                    })
                } else if (event.kind === 'provider_failed') {
                    await tx.call.update({
                        where: { id: callId },
                        data: { aiSessionStatus: 'failed', status: 'failed', metadata },
                    })
                } else if (event.kind === 'call_ended') {
                    await tx.call.update({
                        where: { id: callId },
                        data: { aiSessionStatus: 'ended', status: 'completed', metadata },
                    })
                } else if (event.target === 'active') {
                    await tx.call.update({
                        where: { id: callId },
                        data: { aiSessionStatus: 'active', status: 'active', metadata },
                    })
                } else {
                    await tx.call.update({
                        where: { id: callId },
                        data: { aiSessionStatus: event.target, metadata },
                    })
                }
            }
            return { ...result, callId }
        })
    },
}
