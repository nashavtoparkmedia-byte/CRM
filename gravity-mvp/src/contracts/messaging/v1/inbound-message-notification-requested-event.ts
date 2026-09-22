/**
 * Mobile Push v1 — durable notification intent for one inbound Message.
 *
 * Appended in the SAME database transaction as the Message it names, so a
 * persisted qualifying message always has its intent and a rolled-back one
 * never does. The event carries identifiers only: no message text, no customer
 * name or phone, and never a device token.
 *
 * Identity is the message: one intent per Message, however many times the
 * provider re-delivers it.
 */
export const INBOUND_MESSAGE_NOTIFICATION_REQUESTED_EVENT_V1 = 'messaging.InboundMessageNotificationRequested.v1' as const

/** Channels a notification may name. `phone` rows are call timeline and never notify. */
export const INBOUND_NOTIFICATION_CHANNELS_V1 = ['telegram', 'whatsapp', 'max', 'avito'] as const
export type InboundNotificationChannelV1 = typeof INBOUND_NOTIFICATION_CHANNELS_V1[number]

export interface InboundMessageNotificationRequestedEventV1 {
    eventId: string
    eventType: typeof INBOUND_MESSAGE_NOTIFICATION_REQUESTED_EVENT_V1
    eventVersion: 1
    occurredAt: string
    aggregate: {
        type: 'Message'
        id: string
    }
    correlationId: string | null
    causationId: string | null
    data: {
        messageId: string
        chatId: string
        channel: InboundNotificationChannelV1
    }
}

export class InboundMessageNotificationRequestedEventValidationError extends Error {
    readonly code = 'INVALID_INBOUND_MESSAGE_NOTIFICATION_REQUESTED_EVENT'

    constructor(message: string) {
        super(message)
        this.name = 'InboundMessageNotificationRequestedEventValidationError'
    }
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/
const CHANNELS = new Set<string>(INBOUND_NOTIFICATION_CHANNELS_V1)

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(message: string): never {
    throw new InboundMessageNotificationRequestedEventValidationError(message)
}

function hasOnly(value: Record<string, unknown>, fields: string[], scope: string): void {
    const allowed = new Set(fields)
    const unexpected = Object.keys(value).filter((key) => !allowed.has(key))
    if (unexpected.length > 0) fail(`${scope} has unsupported field(s): ${unexpected.sort().join(', ')}`)
}

export function inboundMessageNotificationEventIdV1(messageId: string): string {
    return `${INBOUND_MESSAGE_NOTIFICATION_REQUESTED_EVENT_V1}:${messageId}`
}

export function makeInboundMessageNotificationRequestedEventV1(input: {
    messageId: string
    chatId: string
    channel: InboundNotificationChannelV1
    occurredAt: string
}): InboundMessageNotificationRequestedEventV1 {
    return parseInboundMessageNotificationRequestedEventV1({
        eventId: inboundMessageNotificationEventIdV1(input.messageId),
        eventType: INBOUND_MESSAGE_NOTIFICATION_REQUESTED_EVENT_V1,
        eventVersion: 1,
        occurredAt: input.occurredAt,
        aggregate: { type: 'Message', id: input.messageId },
        correlationId: input.messageId,
        causationId: null,
        data: {
            messageId: input.messageId,
            chatId: input.chatId,
            channel: input.channel,
        },
    })
}

export function parseInboundMessageNotificationRequestedEventV1(input: unknown): InboundMessageNotificationRequestedEventV1 {
    if (!isRecord(input)) fail('event must be an object')
    hasOnly(input, [
        'eventId', 'eventType', 'eventVersion', 'occurredAt', 'aggregate',
        'correlationId', 'causationId', 'data',
    ], 'event')

    if (input.eventType !== INBOUND_MESSAGE_NOTIFICATION_REQUESTED_EVENT_V1 || input.eventVersion !== 1) {
        fail(`event must be ${INBOUND_MESSAGE_NOTIFICATION_REQUESTED_EVENT_V1}`)
    }
    if (typeof input.occurredAt !== 'string' || Number.isNaN(Date.parse(input.occurredAt))) {
        fail('occurredAt must be an ISO timestamp')
    }
    if (input.correlationId !== null && typeof input.correlationId !== 'string') {
        fail('correlationId must be a string or null')
    }
    if (input.causationId !== null && typeof input.causationId !== 'string') {
        fail('causationId must be a string or null')
    }
    if (!isRecord(input.aggregate)) fail('aggregate must be an object')
    hasOnly(input.aggregate, ['type', 'id'], 'aggregate')
    if (!isRecord(input.data)) fail('data must be an object')
    hasOnly(input.data, ['messageId', 'chatId', 'channel'], 'data')

    const { messageId, chatId, channel } = input.data
    if (typeof messageId !== 'string' || !SAFE_ID.test(messageId)) fail('data.messageId is invalid')
    if (typeof chatId !== 'string' || !SAFE_ID.test(chatId)) fail('data.chatId is invalid')
    if (typeof channel !== 'string' || !CHANNELS.has(channel)) fail('data.channel is invalid')
    if (input.aggregate.type !== 'Message' || input.aggregate.id !== messageId) {
        fail('aggregate must identify data.messageId')
    }
    if (input.eventId !== inboundMessageNotificationEventIdV1(messageId)) {
        fail('eventId must be derived from data.messageId')
    }

    return input as unknown as InboundMessageNotificationRequestedEventV1
}
