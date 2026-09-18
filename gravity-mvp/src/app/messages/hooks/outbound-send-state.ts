import type { Message } from './useMessages'

/**
 * How one logical outbound send is reconciled on this device.
 *
 * A send has a single identity, its clientMessageId, from the tap to the
 * settled row. Three sources report on it, in any order: the answer to this
 * device's own request, the SSE stream (the created row, then the settled
 * row) and the history poll. Each of them is folded in here by
 * clientMessageId, never by content or time, so the optimistic row and the
 * canonical row can never both be shown, and a late or stale report can never
 * undo a newer one.
 */

const STATUS_RANK: Record<string, number> = {
    sending: 0,
    queued: 0,
    sent: 1,
    delivered: 2,
    failed: 2,
    read: 3,
}

const ANSWER_STATUSES = new Set<Message['status']>(['queued', 'sent', 'delivered', 'read', 'failed'])

function rank(status: string | undefined): number {
    return status !== undefined && status in STATUS_RANK ? STATUS_RANK[status] : STATUS_RANK.sent
}

/** An optimistic row this device created and the server has not echoed yet. */
export function isLocalOnlyRow(message: Message): boolean {
    return message.id.startsWith('cmid-')
}

/** This device's request failed without an answer, so nothing canonical is known. */
export function isLocalSendFailure(message: Message): boolean {
    return message.metadata?.localSendError === true
}

/**
 * The owner recorded, under the current taxonomy (error schema v2+), that
 * nothing was dispatched. A row the v1 taxonomy marked retryable has no such
 * proof and is never retried; neither is an unknown or terminal outcome.
 */
export function isPersistedSafeToRedeliver(message: Message): boolean {
    const metadata = message.metadata
    return message.status === 'failed'
        && metadata?.retryable === true
        && metadata?.deliveryOutcome === 'safe_to_redeliver'
        && typeof metadata?.errorSchemaVersion === 'number'
        && metadata.errorSchemaVersion >= 2
}

/** «Повторить» may be offered: an unanswered intent, or a failure the owner proved safe to redeliver. */
export function canRetryOutbound(message: Message): boolean {
    if (message.direction !== 'outbound' || message.status !== 'failed') return false
    return isLocalSendFailure(message) || isPersistedSafeToRedeliver(message)
}

/** The owner could not tell whether the provider delivered it; nothing may resend it blindly. */
export function hasUnknownDeliveryOutcome(message: Message): boolean {
    return message.status === 'failed' && message.metadata?.deliveryOutcome === 'unknown'
}

function withoutKeys(metadata: Message['metadata'], keys: readonly string[]): Message['metadata'] {
    if (!metadata || !keys.some(key => key in metadata)) return metadata
    const rest = { ...metadata }
    for (const key of keys) delete rest[key]
    return rest
}

function withoutLocalFailure(metadata: Message['metadata']): Message['metadata'] {
    return withoutKeys(metadata, ['localSendError'])
}

/** The row that is this logical send: by server id first, then by clientMessageId. */
export function findSendRow(
    list: Message[],
    key: { id?: string | null; clientMessageId?: string | null },
): number {
    if (key.id) {
        const byId = list.findIndex(m => m.id === key.id)
        if (byId >= 0) return byId
    }
    const cmid = key.clientMessageId
    if (!cmid) return -1
    return list.findIndex(m => m.clientMessageId === cmid || m.id === cmid || m.id === `cmid-${cmid}`)
}

export function updateSendRow(
    list: Message[],
    key: { id?: string | null; clientMessageId?: string | null },
    update: (row: Message) => Message,
): Message[] {
    const index = findSendRow(list, key)
    if (index < 0) return list
    const next = [...list]
    next[index] = update(list[index])
    return next
}

/**
 * Fold a canonical copy of a row (SSE or poll) into the local one.
 *
 * - A local-only failure yields to any canonical state: the server knows.
 * - While this device's request is in flight, a canonical 'sent' is the row
 *   being accepted, not settled, so it keeps showing as sending.
 * - A snapshot never moves a row backwards; it is older than what is shown.
 */
export function mergeCanonicalRow(current: Message, incoming: Message): Message {
    const channel = incoming.channel || current.channel || 'whatsapp'
    // A partial update (a reaction, a metadata patch) says nothing about delivery.
    if (incoming.status === undefined) return { ...current, ...incoming, status: current.status, channel }
    if (!isLocalSendFailure(current)) {
        if (current.status === 'sending' && incoming.status === 'sent') {
            return { ...current, ...incoming, channel, status: 'sending' }
        }
        if (rank(incoming.status) < rank(current.status)) {
            return { ...current, id: incoming.id || current.id, clientMessageId: current.clientMessageId ?? incoming.clientMessageId }
        }
    }
    return {
        ...current,
        ...incoming,
        channel,
        metadata: withoutLocalFailure(incoming.metadata ?? current.metadata),
    }
}

export interface SendAnswer {
    success?: boolean
    id?: string | null
    status?: string | null
    externalId?: string | null
    error?: string | null
    retryable?: boolean
    deliveryOutcome?: string | null
    errorSchemaVersion?: number | null
}

/**
 * The answer to this device's own request (a send or a retry). It ends the
 * in-flight state. If the row was already settled meanwhile by a newer
 * canonical report, the answer cannot move it backwards.
 */
export function applySendAnswer(current: Message, answer: SendAnswer): Message {
    const status: Message['status'] = answer.success === false || answer.status === 'failed'
        ? 'failed'
        : ANSWER_STATUSES.has(answer.status as Message['status']) ? answer.status as Message['status'] : 'sent'
    const id = answer.id || current.id
    if (current.status !== 'sending' && !isLocalSendFailure(current) && rank(status) < rank(current.status)) {
        return { ...current, id }
    }
    const rest = withoutKeys(current.metadata, ['localSendError', 'error', 'retryable', 'deliveryOutcome', 'errorSchemaVersion']) ?? {}
    const metadata = status === 'failed'
        ? {
            ...rest,
            error: answer.error || 'Ошибка доставки',
            retryable: answer.retryable === true,
            ...(answer.deliveryOutcome ? { deliveryOutcome: answer.deliveryOutcome } : {}),
            ...(typeof answer.errorSchemaVersion === 'number' ? { errorSchemaVersion: answer.errorSchemaVersion } : {}),
        }
        : rest
    return {
        ...current,
        id,
        status,
        ...(answer.externalId ? { externalId: answer.externalId } : {}),
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    }
}

/**
 * This device's request ended without a trustworthy answer (network loss, an
 * error status, an unreadable body). The canonical state is unknown, so the row
 * becomes a local failure that «Повторить» resends as the SAME intent — unless
 * a canonical report already settled it meanwhile, which then stands.
 */
export function applySendFailure(current: Message, errorText: string): Message {
    if (current.status !== 'sending') return current
    return {
        ...current,
        status: 'failed',
        metadata: { ...current.metadata, error: errorText, localSendError: true },
    }
}

/**
 * Merge a fresh history read with what this device shows. Server rows are
 * canonical; each is folded into its local copy by clientMessageId. Local rows
 * the server has not echoed yet — sends in flight and unanswered intents —
 * stay. A server row without a clientMessageId (a legacy path) can still
 * absorb an optimistic row by content and time, as before.
 */
export function mergeHistorySnapshot(server: Message[], local: Message[]): Message[] {
    const merged = server.map(row => {
        const index = findSendRow(local, { id: row.id, clientMessageId: row.clientMessageId })
        return index >= 0 ? mergeCanonicalRow(local[index], row) : row
    })
    const pending = local.filter(row => {
        if (!isLocalOnlyRow(row)) return false
        if (findSendRow(server, { clientMessageId: row.clientMessageId ?? null }) >= 0) return false
        return !server.some(srv =>
            !srv.clientMessageId &&
            srv.direction === 'outbound' &&
            srv.content === row.content &&
            Math.abs(new Date(srv.sentAt).getTime() - new Date(row.sentAt).getTime()) < 60000,
        )
    })
    return [...merged, ...pending]
}
