/* eslint-disable @typescript-eslint/no-explicit-any -- Prisma client can lag AI-call model generation */
import { prisma } from '@/lib/prisma'
import {
    AI_CALL_TRANSCRIPT_METADATA_KEY,
    AiCallTranscriptConflictError,
    aiCallMessageRowId,
    aiCallTranscriptId,
    createAiCallTranscriptJournal,
    metadataWithAiCallTranscriptJournal,
    readAiCallTranscriptJournal,
    reconcileAiCallTranscriptJournal,
    renderLegacyAiCallTranscriptProjection,
    type AiCallTranscriptJournalV1,
    type AiCallTranscriptMessageInput,
    type AiCallTranscriptPersistencePort,
} from '../../application/ai-call-transcript'

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasTranscriptKey(metadata: unknown): boolean {
    return isRecord(metadata) && Object.prototype.hasOwnProperty.call(metadata, AI_CALL_TRANSCRIPT_METADATA_KEY)
}

async function bootstrapJournal(
    tx: any,
    callId: string,
    metadata: unknown,
    legacyTranscript: unknown,
    acceptedAfterTerminal: boolean,
): Promise<AiCallTranscriptJournalV1> {
    const existing = readAiCallTranscriptJournal(metadata)
    if (existing) {
        if (existing.transcriptId !== aiCallTranscriptId(callId)
            || existing.messages.some((item) => item.rowId !== aiCallMessageRowId(callId, item.messageId))) {
            throw new AiCallTranscriptConflictError('corrupt_journal', 'AI call transcript journal belongs to another aggregate')
        }
        return existing
    }
    if (hasTranscriptKey(metadata)) {
        throw new AiCallTranscriptConflictError('corrupt_journal', 'AI call transcript journal is corrupt')
    }

    // Existing structured rows, if any, remain canonical. The legacy mutable
    // Call.transcript string is deliberately not parsed back into truth.
    const rows = await tx.aiCallMessage.findMany({
        where: { callId, role: { in: ['user', 'assistant'] } },
        select: { id: true, role: true, content: true, startedAt: true },
        orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
    })
    if (rows.length === 0 && typeof legacyTranscript === 'string' && legacyTranscript.trim()) {
        throw new AiCallTranscriptConflictError(
            'corrupt_journal',
            'legacy transcript exists without canonical structured rows',
        )
    }
    let journal = createAiCallTranscriptJournal(callId)
    for (const [index, row] of rows.entries()) {
        const result = reconcileAiCallTranscriptJournal(callId, journal, {
            messageId: `legacy-ai-call-message:v1:${row.id}`,
            ordinal: index + 1,
            role: row.role,
            content: row.content,
            final: true,
            source: 'legacy_calling',
        }, acceptedAfterTerminal)
        const receipt = { ...result.receipt, rowId: row.id }
        journal = {
            ...result.journal,
            messages: result.journal.messages.map((item) => item.messageId === receipt.messageId ? receipt : item),
        }
    }
    return journal
}

export const aiCallTranscriptPrismaPort: AiCallTranscriptPersistencePort = {
    async append(callId: string, message: AiCallTranscriptMessageInput) {
        return (prisma as any).$transaction(async (tx: any) => {
            await tx.$queryRaw`SELECT "id" FROM "Call" WHERE "id" = ${callId} FOR UPDATE`
            const call = await tx.call.findUnique({
                where: { id: callId },
                select: {
                    id: true,
                    isAi: true,
                    endedAt: true,
                    aiSessionStatus: true,
                    transcript: true,
                    metadata: true,
                },
            })
            if (!call || !call.isAi) return { kind: 'not_found' as const }

            const acceptedAfterTerminal = call.endedAt !== null
                || ['ended', 'failed'].includes(String(call.aiSessionStatus))
            const journal = await bootstrapJournal(
                tx,
                callId,
                call.metadata,
                call.transcript,
                acceptedAfterTerminal,
            )
            const result = reconcileAiCallTranscriptJournal(callId, journal, message, acceptedAfterTerminal)
            if (result.kind === 'duplicate') {
                const rows = await tx.aiCallMessage.findMany({
                    where: { callId, id: { in: result.journal.messages.map((item) => item.rowId) } },
                    select: { id: true, role: true, content: true },
                })
                return {
                    ...result,
                    callId,
                    legacyTranscript: renderLegacyAiCallTranscriptProjection(result.journal, rows),
                }
            }

            await tx.aiCallMessage.create({
                data: {
                    id: result.receipt.rowId,
                    callId,
                    role: message.role,
                    content: message.content,
                    startedAt: new Date(),
                },
            })
            const rows = await tx.aiCallMessage.findMany({
                where: { callId, id: { in: result.journal.messages.map((item) => item.rowId) } },
                select: { id: true, role: true, content: true },
            })
            const legacyTranscript = renderLegacyAiCallTranscriptProjection(result.journal, rows)
            await tx.call.update({
                where: { id: callId },
                data: {
                    transcript: legacyTranscript,
                    metadata: metadataWithAiCallTranscriptJournal(call.metadata, result.journal),
                },
            })
            return { ...result, callId, legacyTranscript }
        })
    },
}
