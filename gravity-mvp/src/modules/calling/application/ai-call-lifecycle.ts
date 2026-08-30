import { createHash } from 'node:crypto'

export const AI_CALL_LIFECYCLE_METADATA_KEY = 'aiCallLifecycleV1' as const
export const AI_CALL_LIFECYCLE_MAX_RECEIPTS = 32

export type AiCallLifecycleState =
    | 'starting'
    | 'greeting'
    | 'active'
    | 'transferring'
    | 'ended'
    | 'failed'

export type AiCallLifecycleEventKind =
    | 'greeting_started'
    | 'conversation_started'
    | 'transfer_started'
    | 'call_ended'
    | 'call_cancelled'
    | 'call_timed_out'
    | 'provider_failed'
    | 'finalized'

export interface AiCallLifecycleEventInput {
    eventId: string
    source: 'audio_bridge' | 'calling_finalization'
    sourceSequence: number
    kind: AiCallLifecycleEventKind
    target: AiCallLifecycleState
}

export interface AiCallLifecycleReceiptV1 extends AiCallLifecycleEventInput {
    fingerprint: string
    disposition: 'applied' | 'stale_rejected'
    revision: number
    previousState: AiCallLifecycleState
}

export interface AiCallLifecycleJournalV1 {
    version: 1
    lifecycleId: string
    state: AiCallLifecycleState
    revision: number
    sourceWatermarks: Record<string, number>
    terminal: {
        eventId: string
        state: AiCallLifecycleState
        revision: number
        kind: AiCallLifecycleEventKind
    } | null
    receipts: AiCallLifecycleReceiptV1[]
}

export type ApplyAiCallLifecycleResult =
    | { kind: 'applied'; journal: AiCallLifecycleJournalV1; receipt: AiCallLifecycleReceiptV1 }
    | { kind: 'duplicate'; journal: AiCallLifecycleJournalV1; receipt: AiCallLifecycleReceiptV1 }
    | { kind: 'stale'; journal: AiCallLifecycleJournalV1; receipt: AiCallLifecycleReceiptV1 }

export type ChangeAiCallLifecycleResult =
    | ({ callId: string } & ApplyAiCallLifecycleResult)
    | { kind: 'not_found' }

export class AiCallLifecycleInputError extends Error {
    readonly code = 'INVALID_LIFECYCLE_EVENT' as const

    constructor(message: string) {
        super(message)
        this.name = 'AiCallLifecycleInputError'
    }
}

export class AiCallLifecycleConflictError extends Error {
    constructor(
        readonly code: 'identity_collision' | 'invalid_transition' | 'terminal_state' | 'receipt_limit',
        message: string,
    ) {
        super(message)
        this.name = 'AiCallLifecycleConflictError'
    }
}

export interface AiCallLifecyclePersistencePort {
    apply(callId: string, event: AiCallLifecycleEventInput): Promise<ChangeAiCallLifecycleResult>
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

function isLifecycleState(value: unknown): value is AiCallLifecycleState {
    return ['starting', 'greeting', 'active', 'transferring', 'ended', 'failed'].includes(String(value))
}

function isLifecycleKind(value: unknown): value is AiCallLifecycleEventKind {
    return [
        'greeting_started',
        'conversation_started',
        'transfer_started',
        'call_ended',
        'call_cancelled',
        'call_timed_out',
        'provider_failed',
        'finalized',
    ].includes(String(value))
}

function isTerminalJournal(journal: AiCallLifecycleJournalV1): boolean {
    return journal.terminal !== null
}

function eventFingerprint(event: AiCallLifecycleEventInput): string {
    return sha256(event)
}

function isLegalTransition(
    current: AiCallLifecycleState,
    event: AiCallLifecycleEventInput,
): boolean {
    if (event.kind === 'greeting_started') {
        return event.target === 'greeting' && current === 'starting'
    }
    if (event.kind === 'conversation_started') {
        // A lost greeting callback must not prevent the first real utterance
        // from advancing the canonical call. A later greeting has a lower
        // source sequence and is durably rejected as stale.
        return event.target === 'active' && ['starting', 'greeting'].includes(current)
    }
    if (event.kind === 'transfer_started') {
        return event.target === 'transferring' && ['greeting', 'active'].includes(current)
    }
    if (event.kind === 'finalized') {
        return ['ended', 'failed', 'transferring'].includes(event.target)
            && ['starting', 'greeting', 'active', 'transferring'].includes(current)
    }
    if (event.kind === 'call_ended') {
        return event.target === 'ended' && ['starting', 'greeting', 'active', 'transferring'].includes(current)
    }
    if (['call_cancelled', 'call_timed_out', 'provider_failed'].includes(event.kind)) {
        return event.target === 'failed' && ['starting', 'greeting', 'active', 'transferring'].includes(current)
    }
    return false
}

function isTerminalEvent(event: AiCallLifecycleEventInput): boolean {
    return ['finalized', 'call_ended', 'call_cancelled', 'call_timed_out', 'provider_failed'].includes(event.kind)
}

export function aiCallLifecycleId(callId: string): string {
    return `ai-call-lifecycle:v1:${callId}`
}

export function createAiCallLifecycleJournal(
    callId: string,
    state: AiCallLifecycleState = 'starting',
    terminal = false,
): AiCallLifecycleJournalV1 {
    return {
        version: 1,
        lifecycleId: aiCallLifecycleId(callId),
        state,
        revision: 0,
        sourceWatermarks: {},
        terminal: terminal ? {
            eventId: `ai-call-lifecycle-bootstrap:v1:${callId}:${state}`,
            state,
            revision: 0,
            kind: state === 'ended' ? 'call_ended' : 'provider_failed',
        } : null,
        receipts: [],
    }
}

export function lifecycleStateFromCurrent(value: unknown): AiCallLifecycleState {
    return isLifecycleState(value) ? value : 'starting'
}

export function readAiCallLifecycleJournal(metadata: unknown): AiCallLifecycleJournalV1 | null {
    if (!isRecord(metadata)) return null
    const value = metadata[AI_CALL_LIFECYCLE_METADATA_KEY]
    if (!isRecord(value) || value.version !== 1) return null
    if (
        typeof value.lifecycleId !== 'string'
        || !value.lifecycleId.startsWith('ai-call-lifecycle:v1:')
        || !isLifecycleState(value.state)
        || !Number.isSafeInteger(value.revision)
        || (value.revision as number) < 0
        || !isRecord(value.sourceWatermarks)
        || !Array.isArray(value.receipts)
        || value.receipts.length > AI_CALL_LIFECYCLE_MAX_RECEIPTS
    ) return null

    if (Object.keys(value.sourceWatermarks).some((source) => !['audio_bridge', 'calling_finalization'].includes(source))) {
        return null
    }
    for (const sequence of Object.values(value.sourceWatermarks)) {
        if (!Number.isSafeInteger(sequence) || (sequence as number) < 0) return null
    }
    for (const receipt of value.receipts) {
        if (
            !isRecord(receipt)
            || typeof receipt.eventId !== 'string'
            || !['audio_bridge', 'calling_finalization'].includes(String(receipt.source))
            || !Number.isSafeInteger(receipt.sourceSequence)
            || (receipt.sourceSequence as number) < 1
            || !isLifecycleKind(receipt.kind)
            || !isLifecycleState(receipt.target)
            || !/^[0-9a-f]{64}$/.test(String(receipt.fingerprint))
            || !['applied', 'stale_rejected'].includes(String(receipt.disposition))
            || !Number.isSafeInteger(receipt.revision)
            || !isLifecycleState(receipt.previousState)
        ) return null
        const normalized = {
            eventId: receipt.eventId,
            source: receipt.source,
            sourceSequence: receipt.sourceSequence,
            kind: receipt.kind,
            target: receipt.target,
        } as AiCallLifecycleEventInput
        if (eventFingerprint(normalized) !== receipt.fingerprint) return null
    }
    const applied = (value.receipts as unknown as AiCallLifecycleReceiptV1[])
        .filter((receipt) => receipt.disposition === 'applied')
    if (value.revision !== applied.length) return null
    for (const [index, receipt] of applied.entries()) {
        if (receipt.revision !== index + 1) return null
    }
    if (applied.length > 0 && value.state !== applied[applied.length - 1].target) return null
    if (value.terminal !== null) {
        if (
            !isRecord(value.terminal)
            || typeof value.terminal.eventId !== 'string'
            || !isLifecycleState(value.terminal.state)
            || !Number.isSafeInteger(value.terminal.revision)
            || !isLifecycleKind(value.terminal.kind)
        ) return null
        const terminal = {
            eventId: value.terminal.eventId as string,
            state: value.terminal.state as AiCallLifecycleState,
            revision: value.terminal.revision as number,
            kind: value.terminal.kind as AiCallLifecycleEventKind,
        }
        const isBootstrapTerminal = applied.length === 0
            && terminal.revision === 0
            && terminal.eventId.startsWith('ai-call-lifecycle-bootstrap:v1:')
            && terminal.state === value.state
        if (!isBootstrapTerminal) {
            const terminalReceipt = applied.find((receipt) => receipt.eventId === terminal.eventId)
            if (!terminalReceipt || terminalReceipt.revision !== terminal.revision
                || terminalReceipt.target !== terminal.state || terminalReceipt.kind !== terminal.kind) return null
        }
    } else if (['ended', 'failed'].includes(String(value.state))) {
        return null
    }
    return value as unknown as AiCallLifecycleJournalV1
}

export function metadataWithAiCallLifecycleJournal(
    metadata: unknown,
    journal: AiCallLifecycleJournalV1,
): Record<string, unknown> {
    const record = isRecord(metadata) ? metadata : {}
    return { ...record, [AI_CALL_LIFECYCLE_METADATA_KEY]: journal }
}

export function normalizeAiCallLifecycleEvent(input: unknown): AiCallLifecycleEventInput {
    if (!isRecord(input)) throw new AiCallLifecycleInputError('event must be an object')
    if (
        typeof input.eventId !== 'string'
        || input.eventId.length < 1
        || input.eventId.length > 255
        || input.eventId !== input.eventId.trim()
    ) throw new AiCallLifecycleInputError('eventId is invalid')
    if (!['audio_bridge', 'calling_finalization'].includes(String(input.source))) {
        throw new AiCallLifecycleInputError('source is invalid')
    }
    if (!Number.isSafeInteger(input.sourceSequence) || (input.sourceSequence as number) < 1) {
        throw new AiCallLifecycleInputError('sourceSequence is invalid')
    }
    if (!isLifecycleKind(input.kind)) throw new AiCallLifecycleInputError('kind is invalid')
    if (!isLifecycleState(input.target)) throw new AiCallLifecycleInputError('target is invalid')
    return {
        eventId: input.eventId,
        source: input.source as AiCallLifecycleEventInput['source'],
        sourceSequence: input.sourceSequence as number,
        kind: input.kind,
        target: input.target,
    }
}

export function applyAiCallLifecycleEvent(
    journal: AiCallLifecycleJournalV1,
    rawEvent: unknown,
): ApplyAiCallLifecycleResult {
    const event = normalizeAiCallLifecycleEvent(rawEvent)
    const fingerprint = eventFingerprint(event)
    const existing = journal.receipts.find((receipt) => receipt.eventId === event.eventId)
    if (existing) {
        if (existing.fingerprint !== fingerprint) {
            throw new AiCallLifecycleConflictError('identity_collision', 'lifecycle event identity was reused')
        }
        return existing.disposition === 'stale_rejected'
            ? { kind: 'stale', journal, receipt: existing }
            : { kind: 'duplicate', journal, receipt: existing }
    }
    if (isTerminalJournal(journal)) {
        throw new AiCallLifecycleConflictError('terminal_state', 'terminal lifecycle cannot be overwritten')
    }
    if (journal.receipts.length >= AI_CALL_LIFECYCLE_MAX_RECEIPTS) {
        throw new AiCallLifecycleConflictError('receipt_limit', 'lifecycle receipt bound reached')
    }

    const watermark = journal.sourceWatermarks[event.source] ?? 0
    if (event.sourceSequence <= watermark) {
        const receipt: AiCallLifecycleReceiptV1 = {
            ...event,
            fingerprint,
            disposition: 'stale_rejected',
            revision: journal.revision,
            previousState: journal.state,
        }
        const updated = { ...journal, receipts: [...journal.receipts, receipt] }
        return { kind: 'stale', journal: updated, receipt }
    }
    if (!isLegalTransition(journal.state, event)) {
        throw new AiCallLifecycleConflictError(
            'invalid_transition',
            `${journal.state} cannot accept ${event.kind} -> ${event.target}`,
        )
    }

    const revision = journal.revision + 1
    const receipt: AiCallLifecycleReceiptV1 = {
        ...event,
        fingerprint,
        disposition: 'applied',
        revision,
        previousState: journal.state,
    }
    const updated: AiCallLifecycleJournalV1 = {
        ...journal,
        state: event.target,
        revision,
        sourceWatermarks: { ...journal.sourceWatermarks, [event.source]: event.sourceSequence },
        terminal: isTerminalEvent(event) ? {
            eventId: event.eventId,
            state: event.target,
            revision,
            kind: event.kind,
        } : null,
        receipts: [...journal.receipts, receipt],
    }
    return { kind: 'applied', journal: updated, receipt }
}

export function createAiCallLifecycleOperation(deps: { persistence: AiCallLifecyclePersistencePort }) {
    return async (callId: string, rawEvent: unknown): Promise<ChangeAiCallLifecycleResult> => {
        if (!callId) throw new AiCallLifecycleInputError('callId is required')
        return deps.persistence.apply(callId, normalizeAiCallLifecycleEvent(rawEvent))
    }
}

export function finalizationLifecycleEvent(input: {
    callId: string
    fingerprint: string
    target: 'ended' | 'failed' | 'transferring'
}): AiCallLifecycleEventInput {
    return {
        eventId: `ai-call-finalization-lifecycle:v1:${input.callId}:${input.fingerprint}`,
        source: 'calling_finalization',
        sourceSequence: 1,
        kind: input.target === 'failed' ? 'provider_failed' : 'finalized',
        target: input.target,
    }
}
