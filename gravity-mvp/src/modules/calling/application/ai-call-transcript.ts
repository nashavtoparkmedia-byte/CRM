import { createHash } from 'node:crypto'

export const AI_CALL_TRANSCRIPT_METADATA_KEY = 'aiCallTranscriptV1' as const
export const AI_CALL_TRANSCRIPT_MAX_MESSAGES = 512
export const AI_CALL_TRANSCRIPT_MAX_CONTENT_CHARS = 10_000

export type AiCallTranscriptSource = 'audio_bridge' | 'legacy_calling' | 'calling_mock'

export interface AiCallTranscriptMessageInput {
    messageId: string
    ordinal: number
    role: 'user' | 'assistant'
    content: string
    final: true
    source: AiCallTranscriptSource
}

export interface AiCallTranscriptMessageReceiptV1 {
    messageId: string
    rowId: string
    ordinal: number
    role: 'user' | 'assistant'
    final: true
    source: AiCallTranscriptSource
    fingerprint: string
    acceptedAfterTerminal: boolean
    revision: number
}

export interface AiCallTranscriptJournalV1 {
    version: 1
    transcriptId: string
    revision: number
    maxOrdinal: number
    messages: AiCallTranscriptMessageReceiptV1[]
}

export type ReconcileAiCallTranscriptJournalResult =
    | { kind: 'applied'; journal: AiCallTranscriptJournalV1; receipt: AiCallTranscriptMessageReceiptV1 }
    | { kind: 'duplicate'; journal: AiCallTranscriptJournalV1; receipt: AiCallTranscriptMessageReceiptV1 }

export type AppendAiCallTranscriptResult =
    | ({ callId: string; legacyTranscript: string } & ReconcileAiCallTranscriptJournalResult)
    | { kind: 'not_found' }

export class AiCallTranscriptInputError extends Error {
    readonly code = 'INVALID_TRANSCRIPT_MESSAGE' as const

    constructor(message: string) {
        super(message)
        this.name = 'AiCallTranscriptInputError'
    }
}

export class AiCallTranscriptConflictError extends Error {
    constructor(
        readonly code: 'identity_collision' | 'ordinal_collision' | 'message_limit' | 'corrupt_journal',
        message: string,
    ) {
        super(message)
        this.name = 'AiCallTranscriptConflictError'
    }
}

export interface AiCallTranscriptPersistencePort {
    append(callId: string, message: AiCallTranscriptMessageInput): Promise<AppendAiCallTranscriptResult>
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

function sha256(value: unknown): string {
    return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

export function aiCallTranscriptMessageFingerprint(message: AiCallTranscriptMessageInput): string {
    return sha256({
        messageId: message.messageId,
        ordinal: message.ordinal,
        role: message.role,
        content: message.content,
        final: message.final,
        source: message.source,
    })
}

export function aiCallTranscriptId(callId: string): string {
    return `ai-call-transcript:v1:${callId}`
}

export function aiCallMessageRowId(callId: string, messageId: string): string {
    return `ai-call-message-v1-${createHash('sha256').update(`${callId}\0${messageId}`).digest('hex')}`
}

export function createAiCallTranscriptJournal(callId: string): AiCallTranscriptJournalV1 {
    return {
        version: 1,
        transcriptId: aiCallTranscriptId(callId),
        revision: 0,
        maxOrdinal: 0,
        messages: [],
    }
}

export function normalizeAiCallTranscriptMessage(input: unknown): AiCallTranscriptMessageInput {
    if (!isRecord(input)) throw new AiCallTranscriptInputError('message must be an object')
    if (
        typeof input.messageId !== 'string'
        || input.messageId.length < 1
        || input.messageId.length > 255
        || input.messageId !== input.messageId.trim()
    ) throw new AiCallTranscriptInputError('messageId is invalid')
    if (!Number.isSafeInteger(input.ordinal) || (input.ordinal as number) < 1 || (input.ordinal as number) > 10_000) {
        throw new AiCallTranscriptInputError('ordinal is invalid')
    }
    if (!['user', 'assistant'].includes(String(input.role))) {
        throw new AiCallTranscriptInputError('role must be user or assistant')
    }
    if (input.final !== true) {
        throw new AiCallTranscriptInputError('partial transcript messages are not supported by the current Bridge')
    }
    if (!['audio_bridge', 'legacy_calling', 'calling_mock'].includes(String(input.source))) {
        throw new AiCallTranscriptInputError('source is invalid')
    }
    if (typeof input.content !== 'string') throw new AiCallTranscriptInputError('content must be a string')
    const content = input.content.trim()
    if (!content) throw new AiCallTranscriptInputError('content must not be empty')
    if (content.length > AI_CALL_TRANSCRIPT_MAX_CONTENT_CHARS) {
        throw new AiCallTranscriptInputError('content is too large')
    }
    return {
        messageId: input.messageId,
        ordinal: input.ordinal as number,
        role: input.role as 'user' | 'assistant',
        content,
        final: true,
        source: input.source as AiCallTranscriptSource,
    }
}

export function readAiCallTranscriptJournal(metadata: unknown): AiCallTranscriptJournalV1 | null {
    if (!isRecord(metadata)) return null
    const value = metadata[AI_CALL_TRANSCRIPT_METADATA_KEY]
    if (!isRecord(value) || value.version !== 1) return null
    if (
        typeof value.transcriptId !== 'string'
        || !value.transcriptId.startsWith('ai-call-transcript:v1:')
        || !Number.isSafeInteger(value.revision)
        || (value.revision as number) < 0
        || !Number.isSafeInteger(value.maxOrdinal)
        || (value.maxOrdinal as number) < 0
        || !Array.isArray(value.messages)
        || value.messages.length > AI_CALL_TRANSCRIPT_MAX_MESSAGES
    ) return null
    const identities = new Set<string>()
    const rowIds = new Set<string>()
    const ordinals = new Set<number>()
    const revisions = new Set<number>()
    for (const message of value.messages) {
        if (
            !isRecord(message)
            || typeof message.messageId !== 'string'
            || typeof message.rowId !== 'string'
            || !Number.isSafeInteger(message.ordinal)
            || (message.ordinal as number) < 1
            || !['user', 'assistant'].includes(String(message.role))
            || message.final !== true
            || !['audio_bridge', 'legacy_calling', 'calling_mock'].includes(String(message.source))
            || !/^[0-9a-f]{64}$/.test(String(message.fingerprint))
            || typeof message.acceptedAfterTerminal !== 'boolean'
            || !Number.isSafeInteger(message.revision)
            || (message.revision as number) < 1
            || identities.has(message.messageId)
            || ordinals.has(message.ordinal as number)
            || revisions.has(message.revision as number)
            || rowIds.has(message.rowId)
        ) return null
        identities.add(message.messageId)
        rowIds.add(message.rowId)
        ordinals.add(message.ordinal as number)
        revisions.add(message.revision as number)
    }
    if (value.revision !== value.messages.length) return null
    if (value.maxOrdinal !== Math.max(0, ...ordinals)) return null
    for (let revision = 1; revision <= value.revision; revision += 1) {
        if (!revisions.has(revision)) return null
    }
    return value as unknown as AiCallTranscriptJournalV1
}

export function metadataWithAiCallTranscriptJournal(
    metadata: unknown,
    journal: AiCallTranscriptJournalV1,
): Record<string, unknown> {
    const record = isRecord(metadata) ? metadata : {}
    return { ...record, [AI_CALL_TRANSCRIPT_METADATA_KEY]: journal }
}

export function reconcileAiCallTranscriptJournal(
    callId: string,
    journal: AiCallTranscriptJournalV1,
    rawMessage: unknown,
    acceptedAfterTerminal: boolean,
): ReconcileAiCallTranscriptJournalResult {
    const message = normalizeAiCallTranscriptMessage(rawMessage)
    const fingerprint = aiCallTranscriptMessageFingerprint(message)
    const existing = journal.messages.find((item) => item.messageId === message.messageId)
    if (existing) {
        if (existing.fingerprint !== fingerprint) {
            throw new AiCallTranscriptConflictError('identity_collision', 'transcript message identity was reused')
        }
        return { kind: 'duplicate', journal, receipt: existing }
    }
    if (journal.messages.some((item) => item.ordinal === message.ordinal)) {
        throw new AiCallTranscriptConflictError('ordinal_collision', 'transcript ordinal was reused')
    }
    if (journal.messages.length >= AI_CALL_TRANSCRIPT_MAX_MESSAGES) {
        throw new AiCallTranscriptConflictError('message_limit', 'transcript message bound reached')
    }
    const revision = journal.revision + 1
    const receipt: AiCallTranscriptMessageReceiptV1 = {
        messageId: message.messageId,
        rowId: aiCallMessageRowId(callId, message.messageId),
        ordinal: message.ordinal,
        role: message.role,
        final: true,
        source: message.source,
        fingerprint,
        acceptedAfterTerminal,
        revision,
    }
    return {
        kind: 'applied',
        receipt,
        journal: {
            ...journal,
            revision,
            maxOrdinal: Math.max(journal.maxOrdinal, message.ordinal),
            messages: [...journal.messages, receipt],
        },
    }
}

export function renderLegacyAiCallTranscriptProjection(
    journal: AiCallTranscriptJournalV1,
    rows: Array<{ id: string; role: string; content: string }>,
): string {
    const byId = new Map(rows.map((row) => [row.id, row]))
    return [...journal.messages]
        .sort((left, right) => left.ordinal - right.ordinal || left.messageId.localeCompare(right.messageId))
        .map((receipt) => {
            const row = byId.get(receipt.rowId)
            if (!row) throw new AiCallTranscriptConflictError('corrupt_journal', 'canonical transcript row is missing')
            if (row.role !== receipt.role || aiCallTranscriptMessageFingerprint({
                messageId: receipt.messageId,
                ordinal: receipt.ordinal,
                role: receipt.role,
                content: row.content,
                final: true,
                source: receipt.source,
            }) !== receipt.fingerprint) {
                throw new AiCallTranscriptConflictError('corrupt_journal', 'canonical transcript row changed')
            }
            const label = row.role === 'user' ? '[Лид]' : '[AI]'
            return `${label} ${row.content}\n`
        })
        .join('')
}

export function createAiCallTranscriptOperation(deps: { persistence: AiCallTranscriptPersistencePort }) {
    return async (callId: string, rawMessage: unknown): Promise<AppendAiCallTranscriptResult> => {
        if (!callId) throw new AiCallTranscriptInputError('callId is required')
        return deps.persistence.append(callId, normalizeAiCallTranscriptMessage(rawMessage))
    }
}
