import type { InboundNotificationChannelV1 } from '../../../../contracts/messaging/v1'

/**
 * Mobile Push v1 — PRODUCT RECENCY POLICY for inbound notifications.
 *
 * This is a product decision about which newly persisted messages are worth a
 * phone notification. It is NOT a detector of whether a message is "live" or
 * "replayed", and it must not be described as one:
 *
 *  - a history/catch-up row that carries a known replay marker is suppressed;
 *  - otherwise, only a message whose provider time (`sentAt`) is within
 *    15 minutes of when the CRM persisted it (`createdAt`) qualifies.
 *
 * Accepted consequences, both tested:
 *  - a recent imported message WITHOUT a replay marker may notify;
 *  - a genuinely live message that reaches the CRM more than 15 minutes late
 *    (provider or CRM outage) stays silent.
 *
 * Group chats are excluded later, at fan-out, where the chat is read.
 */

export const INBOUND_NOTIFICATION_RECENCY_WINDOW_MS_V1 = 15 * 60_000

/**
 * A row qualifies only within one minute of being persisted. This is a time
 * window, not a proof that the current call created the row: a re-observation
 * inside the minute qualifies again, and adds nothing only because the intent
 * id is derived from the message id and a duplicate insert is skipped. Any
 * later re-observation is outside the window.
 */
export const INBOUND_NOTIFICATION_CREATED_WITHIN_MS_V1 = 60_000

/** Replay markers providers already persist. Today only MAX sets one. */
const KNOWN_REPLAY_SOURCES = new Set(['history', 'catchup'])

const NOTIFYING_TYPES = new Set(['text', 'image', 'audio', 'video', 'sticker', 'voice', 'document'])
const NOTIFYING_CHANNELS = new Set<string>(['telegram', 'whatsapp', 'max', 'avito'])

export interface InboundNotificationCandidateV1 {
    direction: string
    type: string
    channel: string | null | undefined
    metadata: unknown
}

export interface PersistedInboundMessageV1 extends InboundNotificationCandidateV1 {
    id: string
    chatId: string
    sentAt: Date
    createdAt: Date
}

function knownReplaySource(metadata: unknown): boolean {
    if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return false
    const source = (metadata as Record<string, unknown>).source
    return typeof source === 'string' && KNOWN_REPLAY_SOURCES.has(source)
}

/**
 * Cheap pre-write filter from the persistence input alone. False means the
 * write can never qualify, so it keeps the plain (non-transactional) path.
 */
export function isInboundNotificationCandidateV1(input: InboundNotificationCandidateV1): boolean {
    return input.direction === 'inbound'
        && NOTIFYING_TYPES.has(input.type)
        && typeof input.channel === 'string'
        && NOTIFYING_CHANNELS.has(input.channel)
        && !knownReplaySource(input.metadata)
}

/**
 * The decision on the persisted row, inside the persistence transaction.
 * Returns the notification channel when the row qualifies, otherwise null.
 */
export function qualifiesForInboundNotificationV1(
    row: PersistedInboundMessageV1,
    now: Date,
): InboundNotificationChannelV1 | null {
    if (!isInboundNotificationCandidateV1(row)) return null
    const createdAt = row.createdAt.getTime()
    const sentAt = row.sentAt.getTime()
    if (!Number.isFinite(createdAt) || !Number.isFinite(sentAt)) return null
    if (now.getTime() - createdAt > INBOUND_NOTIFICATION_CREATED_WITHIN_MS_V1) return null
    if (createdAt - sentAt > INBOUND_NOTIFICATION_RECENCY_WINDOW_MS_V1) return null
    return row.channel as InboundNotificationChannelV1
}
