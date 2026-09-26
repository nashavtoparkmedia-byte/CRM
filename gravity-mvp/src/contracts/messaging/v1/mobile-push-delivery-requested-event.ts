import {
    INBOUND_NOTIFICATION_CHANNELS_V1,
    inboundMessageNotificationEventIdV1,
    type InboundNotificationChannelV1,
} from './inbound-message-notification-requested-event'

/**
 * Mobile Push v1 — one push delivery for one Message to one device registration.
 *
 * Identity is Message × stable registration id. The registration id does not
 * change when the provider rotates the device token, so an event created
 * before a rotation still addresses the same device and is sent to its current
 * token, which is resolved at send time and never stored here.
 *
 * `sessionBindingId` snapshots the mobile session the registration belonged to
 * when this delivery was fanned out. If the device logs out and back in before
 * the delivery runs, the binding no longer matches and the delivery is skipped
 * rather than resurrected under the new session.
 */
export const MOBILE_PUSH_DELIVERY_REQUESTED_EVENT_V1 = 'messaging.MobilePushDeliveryRequested.v1' as const

export interface MobilePushDeliveryRequestedEventV1 {
    eventId: string
    eventType: typeof MOBILE_PUSH_DELIVERY_REQUESTED_EVENT_V1
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
        registrationId: string
        sessionBindingId: string
    }
}

export class MobilePushDeliveryRequestedEventValidationError extends Error {
    readonly code = 'INVALID_MOBILE_PUSH_DELIVERY_REQUESTED_EVENT'

    constructor(message: string) {
        super(message)
        this.name = 'MobilePushDeliveryRequestedEventValidationError'
    }
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/
const SESSION_BINDING_ID = /^[0-9a-f]{64}$/
const CHANNELS = new Set<string>(INBOUND_NOTIFICATION_CHANNELS_V1)

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(message: string): never {
    throw new MobilePushDeliveryRequestedEventValidationError(message)
}

function hasOnly(value: Record<string, unknown>, fields: string[], scope: string): void {
    const allowed = new Set(fields)
    const unexpected = Object.keys(value).filter((key) => !allowed.has(key))
    if (unexpected.length > 0) fail(`${scope} has unsupported field(s): ${unexpected.sort().join(', ')}`)
}

export function mobilePushDeliveryEventIdV1(messageId: string, registrationId: string): string {
    return `${MOBILE_PUSH_DELIVERY_REQUESTED_EVENT_V1}:${messageId}:${registrationId}`
}

export function makeMobilePushDeliveryRequestedEventV1(input: {
    messageId: string
    chatId: string
    channel: InboundNotificationChannelV1
    registrationId: string
    sessionBindingId: string
    occurredAt: string
}): MobilePushDeliveryRequestedEventV1 {
    return parseMobilePushDeliveryRequestedEventV1({
        eventId: mobilePushDeliveryEventIdV1(input.messageId, input.registrationId),
        eventType: MOBILE_PUSH_DELIVERY_REQUESTED_EVENT_V1,
        eventVersion: 1,
        occurredAt: input.occurredAt,
        aggregate: { type: 'Message', id: input.messageId },
        correlationId: input.messageId,
        causationId: inboundMessageNotificationEventIdV1(input.messageId),
        data: {
            messageId: input.messageId,
            chatId: input.chatId,
            channel: input.channel,
            registrationId: input.registrationId,
            sessionBindingId: input.sessionBindingId,
        },
    })
}

export function parseMobilePushDeliveryRequestedEventV1(input: unknown): MobilePushDeliveryRequestedEventV1 {
    if (!isRecord(input)) fail('event must be an object')
    hasOnly(input, [
        'eventId', 'eventType', 'eventVersion', 'occurredAt', 'aggregate',
        'correlationId', 'causationId', 'data',
    ], 'event')

    if (input.eventType !== MOBILE_PUSH_DELIVERY_REQUESTED_EVENT_V1 || input.eventVersion !== 1) {
        fail(`event must be ${MOBILE_PUSH_DELIVERY_REQUESTED_EVENT_V1}`)
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
    hasOnly(input.data, ['messageId', 'chatId', 'channel', 'registrationId', 'sessionBindingId'], 'data')

    const { messageId, chatId, channel, registrationId, sessionBindingId } = input.data
    if (typeof messageId !== 'string' || !SAFE_ID.test(messageId)) fail('data.messageId is invalid')
    if (typeof chatId !== 'string' || !SAFE_ID.test(chatId)) fail('data.chatId is invalid')
    if (typeof channel !== 'string' || !CHANNELS.has(channel)) fail('data.channel is invalid')
    if (typeof registrationId !== 'string' || !SAFE_ID.test(registrationId)) fail('data.registrationId is invalid')
    if (typeof sessionBindingId !== 'string' || !SESSION_BINDING_ID.test(sessionBindingId)) {
        fail('data.sessionBindingId is invalid')
    }
    if (input.aggregate.type !== 'Message' || input.aggregate.id !== messageId) {
        fail('aggregate must identify data.messageId')
    }
    if (input.eventId !== mobilePushDeliveryEventIdV1(messageId, registrationId)) {
        fail('eventId must be derived from data.messageId and data.registrationId')
    }

    return input as unknown as MobilePushDeliveryRequestedEventV1
}
