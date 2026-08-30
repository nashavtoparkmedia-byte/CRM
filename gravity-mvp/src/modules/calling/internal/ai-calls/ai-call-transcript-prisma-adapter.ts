/* eslint-disable @typescript-eslint/no-explicit-any -- Prisma client can lag AI-call model generation */
import { prisma } from '@/lib/prisma'
import {
    AI_CALL_TRANSCRIPT_METADATA_KEY,
    AiCallTranscriptConflictError,
    aiCallMessageRowId,
    aiCallTranscriptId,
    createAiCallTranscriptJournal,
    materializeAiCallTranscriptSnapshot,
    metadataWithAiCallTranscriptJournal,
    parseLegacyAiCallTranscript,
    readAiCallTranscriptJournal,
    reconcileAiCallTranscriptJournal,
    renderLegacyAiCallTranscriptProjection,
    type AiCallTranscriptJournalV1,
    type AiCallTranscriptMessageInput,
    type AiCallTranscriptPersistencePort,
} from '../../application/ai-call-transcript'
import { readAiCallFinalizationJournal } from '../../application/ai-call-finalization'

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasTranscriptKey(metadata: unknown): boolean {
    return isRecord(metadata) && Object.prototype.hasOwnProperty.call(metadata, AI_CALL_TRANSCRIPT_METADATA_KEY)
}

function isTerminalCall(call: any): boolean {
    return call.endedAt !== null
        || ['ended', 'failed'].includes(String(call.aiSessionStatus))
        || readAiCallFinalizationJournal(call.metadata) !== null
}

interface BootstrapResult {
    journal: AiCallTranscriptJournalV1
    normalizedLegacy: boolean
}

async function createCanonicalRow(tx: any, callId: string, message: AiCallTranscriptMessageInput, rowId: string, at: Date) {
    await tx.aiCallMessage.create({
        data: {
            id: rowId,
            callId,
            role: message.role,
            content: message.content,
            startedAt: at,
        },
    })
}

async function bootstrapJournal(
    tx: any,
    callId: string,
    metadata: unknown,
    legacyTranscript: unknown,
    callStartedAt: Date,
): Promise<BootstrapResult> {
    const existing = readAiCallTranscriptJournal(metadata)
    if (existing) {
        if (existing.transcriptId !== aiCallTranscriptId(callId)
            || existing.messages.some((item) => (
                item.source !== 'legacy_calling' && item.rowId !== aiCallMessageRowId(callId, item.messageId)
            ))) {
            throw new AiCallTranscriptConflictError('corrupt_journal', 'AI call transcript journal belongs to another aggregate')
        }
        return { journal: existing, normalizedLegacy: false }
    }
    if (hasTranscriptKey(metadata)) {
        throw new AiCallTranscriptConflictError('corrupt_journal', 'AI call transcript journal is corrupt')
    }

    const rows = await tx.aiCallMessage.findMany({
        where: { callId, role: { in: ['user', 'assistant'] } },
        select: { id: true, role: true, content: true, startedAt: true },
        orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
    })
    let journal = createAiCallTranscriptJournal(callId)
    for (const [index, row] of rows.entries()) {
        const result = reconcileAiCallTranscriptJournal(callId, journal, {
            messageId: `legacy-ai-call-message:v1:${row.id}`,
            ordinal: index + 1,
            segmentRevision: 1,
            role: row.role,
            content: row.content,
            final: true,
            source: 'legacy_calling',
        }, false)
        const receipt = { ...result.receipt, rowId: row.id }
        journal = {
            ...result.journal,
            messages: result.journal.messages.map((item) => item.messageId === receipt.messageId ? receipt : item),
        }
    }

    if (typeof legacyTranscript === 'string' && legacyTranscript.trim()) {
        const represented = new Map<string, number>()
        for (const row of rows) {
            const key = `${row.role}\0${row.content.trim()}`
            represented.set(key, (represented.get(key) ?? 0) + 1)
        }
        const legacyMessages = parseLegacyAiCallTranscript(legacyTranscript)
        for (const legacy of legacyMessages) {
            const legacyKey = `${legacy.role}\0${legacy.content}`
            const representedCount = represented.get(legacyKey) ?? 0
            if (representedCount > 0) {
                represented.set(legacyKey, representedCount - 1)
                continue
            }
            const ordinal = journal.maxOrdinal + 1
            const message = {
                ...legacy,
                messageId: rows.length === 0
                    ? legacy.messageId
                    : `legacy-call-transcript-extra:v1:${ordinal}`,
                ordinal,
            }
            const result = reconcileAiCallTranscriptJournal(callId, journal, message, false)
            await createCanonicalRow(
                tx,
                callId,
                message,
                result.receipt.rowId,
                new Date(callStartedAt.getTime() + ordinal),
            )
            journal = result.journal
        }
    }
    return { journal, normalizedLegacy: true }
}

async function selectCall(tx: any, callId: string) {
    return tx.call.findUnique({
        where: { id: callId },
        select: {
            id: true,
            isAi: true,
            startedAt: true,
            endedAt: true,
            aiSessionStatus: true,
            transcript: true,
            metadata: true,
        },
    })
}

async function selectCanonicalRows(tx: any, callId: string, journal: AiCallTranscriptJournalV1) {
    return tx.aiCallMessage.findMany({
        where: { callId, id: { in: journal.messages.map((item) => item.rowId) } },
        select: { id: true, role: true, content: true },
    })
}

export const aiCallTranscriptPrismaPort: AiCallTranscriptPersistencePort = {
    async append(callId: string, message: AiCallTranscriptMessageInput) {
        return (prisma as any).$transaction(async (tx: any) => {
            await tx.$queryRaw`SELECT "id" FROM "Call" WHERE "id" = ${callId} FOR UPDATE`
            const call = await selectCall(tx, callId)
            if (!call || !call.isAi) return { kind: 'not_found' as const }

            const bootstrap = await bootstrapJournal(
                tx,
                callId,
                call.metadata,
                call.transcript,
                call.startedAt,
            )
            const previous = bootstrap.journal.messages.find((item) => item.messageId === message.messageId)
            const result = reconcileAiCallTranscriptJournal(
                callId,
                bootstrap.journal,
                message,
                isTerminalCall(call),
            )

            if (result.kind === 'applied') {
                if (previous) {
                    await tx.aiCallMessage.update({
                        where: { id: previous.rowId },
                        data: { content: message.content },
                    })
                } else {
                    await createCanonicalRow(tx, callId, message, result.receipt.rowId, new Date())
                }
            }

            const rows = await selectCanonicalRows(tx, callId, result.journal)
            const legacyProjection = renderLegacyAiCallTranscriptProjection(result.journal, rows)
            if (result.kind === 'applied' || bootstrap.normalizedLegacy) {
                await tx.call.update({
                    where: { id: callId },
                    data: {
                        transcript: legacyProjection,
                        metadata: metadataWithAiCallTranscriptJournal(call.metadata, result.journal),
                    },
                })
            }
            return { ...result, callId, legacyTranscript: legacyProjection }
        })
    },

    async snapshot(callId: string) {
        return (prisma as any).$transaction(async (tx: any) => {
            await tx.$queryRaw`SELECT "id" FROM "Call" WHERE "id" = ${callId} FOR UPDATE`
            const call = await selectCall(tx, callId)
            if (!call || !call.isAi) return null
            const bootstrap = await bootstrapJournal(
                tx,
                callId,
                call.metadata,
                call.transcript,
                call.startedAt,
            )
            const rows = await selectCanonicalRows(tx, callId, bootstrap.journal)
            const snapshot = materializeAiCallTranscriptSnapshot(callId, bootstrap.journal, rows)
            if (bootstrap.normalizedLegacy) {
                await tx.call.update({
                    where: { id: callId },
                    data: {
                        transcript: renderLegacyAiCallTranscriptProjection(bootstrap.journal, rows),
                        metadata: metadataWithAiCallTranscriptJournal(call.metadata, bootstrap.journal),
                    },
                })
            }
            return snapshot
        })
    },
}
