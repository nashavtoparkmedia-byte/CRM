import { createHash } from 'node:crypto'

export const AI_CALL_TRANSCRIPT_METADATA_KEY = 'aiCallTranscriptV1' as const
export const AI_CALL_TRANSCRIPT_MAX_MESSAGES = 512
export const AI_CALL_TRANSCRIPT_MAX_ACCEPTED_REVISIONS = 2_048
export const AI_CALL_TRANSCRIPT_MAX_CONTENT_CHARS = 10_000

export type AiCallTranscriptSource = 'audio_bridge' | 'legacy_calling' | 'calling_mock'

export interface AiCallTranscriptMessageInput {
    messageId: string
    ordinal: number
    segmentRevision: number
    role: 'user' | 'assistant'
    content: string
    final: boolean
    source: AiCallTranscriptSource
}

export interface AiCallTranscriptMessageReceiptV1 {
    messageId: string
    rowId: string
    ordinal: number
    segmentRevision: number
    role: 'user' | 'assistant'
    final: boolean
    source: AiCallTranscriptSource
    fingerprint: string
    acceptedAfterTerminal: boolean
    /** Monotonic aggregate revision at which this segment revision was accepted. */
    revision: number
}

export interface AiCallTranscriptAcceptedRevisionV1 {
    messageId: string
    segmentRevision: number
    fingerprint: string
    journalRevision: number
}

export interface AiCallTranscriptJournalV1 {
    version: 1
    transcriptId: string
    revision: number
    maxOrdinal: number
    messages: AiCallTranscriptMessageReceiptV1[]
    acceptedRevisions: AiCallTranscriptAcceptedRevisionV1[]
}

export interface AiCallTranscriptSnapshotV1 {
    callId: string
    revision: number
    sha256: string
    messages: AiCallTranscriptMessageInput[]
}

export type ReconcileAiCallTranscriptJournalResult =
    | { kind: 'applied'; journal: AiCallTranscriptJournalV1; receipt: AiCallTranscriptMessageReceiptV1 }
    | { kind: 'duplicate'; journal: AiCallTranscriptJournalV1; receipt: AiCallTranscriptMessageReceiptV1 }
    | { kind: 'stale'; journal: AiCallTranscriptJournalV1; receipt: AiCallTranscriptMessageReceiptV1 }

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
        readonly code:
            | 'identity_collision'
            | 'revision_collision'
            | 'ordinal_collision'
            | 'final_regression'
            | 'terminal_snapshot'
            | 'message_limit'
            | 'revision_limit'
            | 'corrupt_journal',
        message: string,
    ) {
        super(message)
        this.name = 'AiCallTranscriptConflictError'
    }
}

export interface AiCallTranscriptPersistencePort {
    append(callId: string, message: AiCallTranscriptMessageInput): Promise<AppendAiCallTranscriptResult>
    snapshot(callId: string): Promise<AiCallTranscriptSnapshotV1 | null>
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

/** Payload identity is deliberately separate from the monotonic segment revision. */
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
        acceptedRevisions: [],
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
    const segmentRevision = input.segmentRevision ?? 1
    if (!Number.isSafeInteger(segmentRevision) || (segmentRevision as number) < 1 || (segmentRevision as number) > 10_000) {
        throw new AiCallTranscriptInputError('segmentRevision is invalid')
    }
    if (!['user', 'assistant'].includes(String(input.role))) {
        throw new AiCallTranscriptInputError('role must be user or assistant')
    }
    if (typeof input.final !== 'boolean') throw new AiCallTranscriptInputError('final must be a boolean')
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
        segmentRevision: segmentRevision as number,
        role: input.role as 'user' | 'assistant',
        content,
        final: input.final,
        source: input.source as AiCallTranscriptSource,
    }
}

function validFingerprint(value: unknown): value is string {
    return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
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
    const messages: AiCallTranscriptMessageReceiptV1[] = []
    for (const raw of value.messages) {
        if (!isRecord(raw)) return null
        const segmentRevision = raw.segmentRevision ?? 1
        if (
            typeof raw.messageId !== 'string'
            || typeof raw.rowId !== 'string'
            || !Number.isSafeInteger(raw.ordinal)
            || (raw.ordinal as number) < 1
            || !Number.isSafeInteger(segmentRevision)
            || (segmentRevision as number) < 1
            || !['user', 'assistant'].includes(String(raw.role))
            || typeof raw.final !== 'boolean'
            || !['audio_bridge', 'legacy_calling', 'calling_mock'].includes(String(raw.source))
            || !validFingerprint(raw.fingerprint)
            || typeof raw.acceptedAfterTerminal !== 'boolean'
            || !Number.isSafeInteger(raw.revision)
            || (raw.revision as number) < 1
            || identities.has(raw.messageId)
            || ordinals.has(raw.ordinal as number)
            || rowIds.has(raw.rowId)
        ) return null
        identities.add(raw.messageId)
        rowIds.add(raw.rowId)
        ordinals.add(raw.ordinal as number)
        messages.push({
            messageId: raw.messageId,
            rowId: raw.rowId,
            ordinal: raw.ordinal as number,
            segmentRevision: segmentRevision as number,
            role: raw.role as 'user' | 'assistant',
            final: raw.final,
            source: raw.source as AiCallTranscriptSource,
            fingerprint: raw.fingerprint,
            acceptedAfterTerminal: raw.acceptedAfterTerminal,
            revision: raw.revision as number,
        })
    }

    const rawAccepted = value.acceptedRevisions
    const acceptedRevisions: AiCallTranscriptAcceptedRevisionV1[] = rawAccepted === undefined
        ? messages.map((message) => ({
            messageId: message.messageId,
            segmentRevision: message.segmentRevision,
            fingerprint: message.fingerprint,
            journalRevision: message.revision,
        }))
        : Array.isArray(rawAccepted) ? rawAccepted.flatMap((raw) => {
            if (!isRecord(raw)
                || typeof raw.messageId !== 'string'
                || !Number.isSafeInteger(raw.segmentRevision)
                || (raw.segmentRevision as number) < 1
                || !validFingerprint(raw.fingerprint)
                || !Number.isSafeInteger(raw.journalRevision)
                || (raw.journalRevision as number) < 1) return []
            return [{
                messageId: raw.messageId,
                segmentRevision: raw.segmentRevision as number,
                fingerprint: raw.fingerprint,
                journalRevision: raw.journalRevision as number,
            }]
        }) : []
    if (
        (rawAccepted !== undefined && (!Array.isArray(rawAccepted) || acceptedRevisions.length !== rawAccepted.length))
        || acceptedRevisions.length > AI_CALL_TRANSCRIPT_MAX_ACCEPTED_REVISIONS
        || acceptedRevisions.length !== value.revision
    ) return null
    const acceptedIdentities = new Set<string>()
    const journalRevisions = new Set<number>()
    for (const accepted of acceptedRevisions) {
        const identity = `${accepted.messageId}\0${accepted.segmentRevision}`
        if (acceptedIdentities.has(identity) || journalRevisions.has(accepted.journalRevision)) return null
        acceptedIdentities.add(identity)
        journalRevisions.add(accepted.journalRevision)
    }
    for (let revision = 1; revision <= value.revision; revision += 1) {
        if (!journalRevisions.has(revision)) return null
    }
    if (value.maxOrdinal !== Math.max(0, ...ordinals)) return null
    if (messages.some((message) => !acceptedRevisions.some((accepted) => (
        accepted.messageId === message.messageId
        && accepted.segmentRevision === message.segmentRevision
        && accepted.fingerprint === message.fingerprint
        && accepted.journalRevision === message.revision
    )))) return null

    return {
        version: 1,
        transcriptId: value.transcriptId,
        revision: value.revision as number,
        maxOrdinal: value.maxOrdinal as number,
        messages,
        acceptedRevisions,
    }
}

export function metadataWithAiCallTranscriptJournal(
    metadata: unknown,
    journal: AiCallTranscriptJournalV1,
): Record<string, unknown> {
    const record = isRecord(metadata) ? metadata : {}
    return { ...record, [AI_CALL_TRANSCRIPT_METADATA_KEY]: journal }
}

function appendAcceptedRevision(
    journal: AiCallTranscriptJournalV1,
    message: AiCallTranscriptMessageInput,
    fingerprint: string,
    journalRevision: number,
): AiCallTranscriptAcceptedRevisionV1[] {
    if (journal.acceptedRevisions.length >= AI_CALL_TRANSCRIPT_MAX_ACCEPTED_REVISIONS) {
        throw new AiCallTranscriptConflictError('revision_limit', 'transcript accepted-revision bound reached')
    }
    return [...journal.acceptedRevisions, {
        messageId: message.messageId,
        segmentRevision: message.segmentRevision,
        fingerprint,
        journalRevision,
    }]
}

export function reconcileAiCallTranscriptJournal(
    callId: string,
    journal: AiCallTranscriptJournalV1,
    rawMessage: unknown,
    terminal: boolean,
): ReconcileAiCallTranscriptJournalResult {
    const message = normalizeAiCallTranscriptMessage(rawMessage)
    const fingerprint = aiCallTranscriptMessageFingerprint(message)
    const existing = journal.messages.find((item) => item.messageId === message.messageId)
    const accepted = journal.acceptedRevisions.find((item) => (
        item.messageId === message.messageId && item.segmentRevision === message.segmentRevision
    ))
    if (accepted) {
        if (accepted.fingerprint !== fingerprint) {
            throw new AiCallTranscriptConflictError('revision_collision', 'transcript segment revision identity was reused')
        }
        if (!existing) throw new AiCallTranscriptConflictError('corrupt_journal', 'accepted segment has no current receipt')
        return message.segmentRevision === existing.segmentRevision
            ? { kind: 'duplicate', journal, receipt: existing }
            : { kind: 'stale', journal, receipt: existing }
    }

    if (existing) {
        if (message.segmentRevision < existing.segmentRevision) {
            return { kind: 'stale', journal, receipt: existing }
        }
        if (message.segmentRevision === existing.segmentRevision) {
            throw new AiCallTranscriptConflictError('revision_collision', 'transcript segment revision identity was reused')
        }
        if (
            message.ordinal !== existing.ordinal
            || message.role !== existing.role
            || message.source !== existing.source
        ) {
            throw new AiCallTranscriptConflictError('identity_collision', 'transcript segment identity changed immutable fields')
        }
        if (existing.final && !message.final) {
            throw new AiCallTranscriptConflictError('final_regression', 'a final transcript segment cannot regress to interim')
        }
        if (terminal) {
            throw new AiCallTranscriptConflictError('terminal_snapshot', 'terminal transcript snapshot is fenced')
        }
        const revision = journal.revision + 1
        const receipt: AiCallTranscriptMessageReceiptV1 = {
            ...existing,
            segmentRevision: message.segmentRevision,
            final: message.final,
            fingerprint,
            acceptedAfterTerminal: false,
            revision,
        }
        return {
            kind: 'applied',
            receipt,
            journal: {
                ...journal,
                revision,
                messages: journal.messages.map((item) => item.messageId === message.messageId ? receipt : item),
                acceptedRevisions: appendAcceptedRevision(journal, message, fingerprint, revision),
            },
        }
    }

    if (terminal) {
        throw new AiCallTranscriptConflictError('terminal_snapshot', 'terminal transcript snapshot is fenced')
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
        segmentRevision: message.segmentRevision,
        role: message.role,
        final: message.final,
        source: message.source,
        fingerprint,
        acceptedAfterTerminal: false,
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
            acceptedRevisions: appendAcceptedRevision(journal, message, fingerprint, revision),
        },
    }
}

function orderedReceipts(journal: AiCallTranscriptJournalV1): AiCallTranscriptMessageReceiptV1[] {
    return [...journal.messages]
        .sort((left, right) => left.ordinal - right.ordinal || left.messageId.localeCompare(right.messageId))
}

export function aiCallTranscriptSnapshotSha256(journal: AiCallTranscriptJournalV1): string {
    return sha256(orderedReceipts(journal).map((receipt) => ({
        messageId: receipt.messageId,
        ordinal: receipt.ordinal,
        segmentRevision: receipt.segmentRevision,
        role: receipt.role,
        final: receipt.final,
        source: receipt.source,
        fingerprint: receipt.fingerprint,
    })))
}

export function aiCallTranscriptMessagesSnapshotSha256(messages: AiCallTranscriptMessageInput[]): string {
    return sha256([...messages]
        .sort((left, right) => left.ordinal - right.ordinal || left.messageId.localeCompare(right.messageId))
        .map((message) => ({
            messageId: message.messageId,
            ordinal: message.ordinal,
            segmentRevision: message.segmentRevision,
            role: message.role,
            final: message.final,
            source: message.source,
            fingerprint: aiCallTranscriptMessageFingerprint(message),
        })))
}

export function materializeAiCallTranscriptSnapshot(
    callId: string,
    journal: AiCallTranscriptJournalV1,
    rows: Array<{ id: string; role: string; content: string }>,
): AiCallTranscriptSnapshotV1 {
    const byId = new Map(rows.map((row) => [row.id, row]))
    const messages = orderedReceipts(journal).map((receipt): AiCallTranscriptMessageInput => {
        const row = byId.get(receipt.rowId)
        if (!row) throw new AiCallTranscriptConflictError('corrupt_journal', 'canonical transcript row is missing')
        const message: AiCallTranscriptMessageInput = {
            messageId: receipt.messageId,
            ordinal: receipt.ordinal,
            segmentRevision: receipt.segmentRevision,
            role: receipt.role,
            content: row.content,
            final: receipt.final,
            source: receipt.source,
        }
        if (row.role !== receipt.role || aiCallTranscriptMessageFingerprint(message) !== receipt.fingerprint) {
            throw new AiCallTranscriptConflictError('corrupt_journal', 'canonical transcript row changed')
        }
        return message
    })
    return { callId, revision: journal.revision, sha256: aiCallTranscriptSnapshotSha256(journal), messages }
}

export function renderLegacyAiCallTranscriptProjection(
    journal: AiCallTranscriptJournalV1,
    rows: Array<{ id: string; role: string; content: string }>,
): string {
    return materializeAiCallTranscriptSnapshot(journal.transcriptId.slice('ai-call-transcript:v1:'.length), journal, rows)
        .messages
        .map((message) => `${message.role === 'user' ? '[Лид]' : '[AI]'} ${message.content}\n`)
        .join('')
}

export function parseLegacyAiCallTranscript(value: string): AiCallTranscriptMessageInput[] {
    const chunks: Array<{ role: 'user' | 'assistant'; content: string[] }> = []
    for (const rawLine of value.replaceAll('\r\n', '\n').split('\n')) {
        const labelled = /^\[(Лид|AI)\]\s?(.*)$/u.exec(rawLine)
        if (labelled) {
            chunks.push({ role: labelled[1] === 'Лид' ? 'user' : 'assistant', content: [labelled[2]] })
        } else if (chunks.length > 0) {
            chunks[chunks.length - 1].content.push(rawLine)
        } else if (rawLine.trim()) {
            chunks.push({ role: 'user', content: [rawLine] })
        }
    }
    return chunks.flatMap((chunk, index) => {
        const content = chunk.content.join('\n').trim()
        if (!content) return []
        return [normalizeAiCallTranscriptMessage({
            messageId: `legacy-call-transcript:v1:${index + 1}`,
            ordinal: index + 1,
            segmentRevision: 1,
            role: chunk.role,
            content,
            final: true,
            source: 'legacy_calling',
        })]
    })
}

export function createAiCallTranscriptOperation(deps: { persistence: AiCallTranscriptPersistencePort }) {
    return async (callId: string, rawMessage: unknown): Promise<AppendAiCallTranscriptResult> => {
        if (!callId) throw new AiCallTranscriptInputError('callId is required')
        return deps.persistence.append(callId, normalizeAiCallTranscriptMessage(rawMessage))
    }
}
