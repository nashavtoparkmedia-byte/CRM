// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
    INBOUND_MESSAGE_NOTIFICATION_REQUESTED_EVENT_V1,
    MOBILE_PUSH_DELIVERY_REQUESTED_EVENT_V1,
    makeInboundMessageNotificationRequestedEventV1,
    makeMobilePushDeliveryRequestedEventV1,
    parseInboundMessageNotificationRequestedEventV1,
    parseMobilePushDeliveryRequestedEventV1,
} from '../../../../contracts/messaging/v1'
import { parseRegisterMobilePushDeviceBodyV1 } from '../../../../contracts/identity-access/v1'

const BINDING = 'a'.repeat(64)
const OCCURRED = '2026-09-22T12:00:00.000Z'

describe('Mobile Push v1 outbox contracts', () => {
    const intent = makeInboundMessageNotificationRequestedEventV1({ messageId: 'msg_1', chatId: 'chat_1', channel: 'max', occurredAt: OCCURRED })
    const delivery = makeMobilePushDeliveryRequestedEventV1({
        messageId: 'msg_1', chatId: 'chat_1', channel: 'max', registrationId: 'reg_1', sessionBindingId: BINDING, occurredAt: OCCURRED,
    })

    it('derives deterministic identities: one intent per message, one delivery per message and stable registration', () => {
        expect(intent.eventId).toBe(`${INBOUND_MESSAGE_NOTIFICATION_REQUESTED_EVENT_V1}:msg_1`)
        expect(delivery.eventId).toBe(`${MOBILE_PUSH_DELIVERY_REQUESTED_EVENT_V1}:msg_1:reg_1`)
        expect(delivery.causationId).toBe(intent.eventId)
        expect(makeInboundMessageNotificationRequestedEventV1({ messageId: 'msg_1', chatId: 'chat_1', channel: 'max', occurredAt: '2026-09-22T13:00:00.000Z' }).eventId)
            .toBe(intent.eventId)
    })

    it('carries identifiers only: exactly these payload fields, no token and no content', () => {
        expect(Object.keys(intent.data).sort()).toEqual(['channel', 'chatId', 'messageId'])
        expect(Object.keys(delivery.data).sort()).toEqual(['channel', 'chatId', 'messageId', 'registrationId', 'sessionBindingId'])
    })

    it('refuses extra fields, including a token or message content smuggled into the payload', () => {
        for (const extra of [{ token: 'x'.repeat(40) }, { fcmToken: 'x'.repeat(40) }, { content: 'hello' }, { text: 'hi' }]) {
            expect(() => parseInboundMessageNotificationRequestedEventV1({ ...intent, data: { ...intent.data, ...extra } })).toThrow(/unsupported field/)
            expect(() => parseMobilePushDeliveryRequestedEventV1({ ...delivery, data: { ...delivery.data, ...extra } })).toThrow(/unsupported field/)
        }
        expect(() => parseInboundMessageNotificationRequestedEventV1({ ...intent, extra: 1 })).toThrow(/unsupported field/)
    })

    it('fails closed on another version, a forged identity or a malformed binding', () => {
        expect(() => parseInboundMessageNotificationRequestedEventV1({ ...intent, eventVersion: 2 })).toThrow()
        expect(() => parseInboundMessageNotificationRequestedEventV1({ ...intent, eventType: 'messaging.InboundMessageNotificationRequested.v2' })).toThrow()
        expect(() => parseInboundMessageNotificationRequestedEventV1({ ...intent, eventId: `${intent.eventId}x` })).toThrow(/derived/)
        expect(() => parseMobilePushDeliveryRequestedEventV1({ ...delivery, eventId: `${MOBILE_PUSH_DELIVERY_REQUESTED_EVENT_V1}:msg_1:reg_2` })).toThrow(/derived/)
        expect(() => parseMobilePushDeliveryRequestedEventV1({ ...delivery, data: { ...delivery.data, sessionBindingId: 'not-a-digest' } })).toThrow(/sessionBindingId/)
        expect(() => parseMobilePushDeliveryRequestedEventV1({ ...delivery, aggregate: { type: 'Message', id: 'msg_2' } })).toThrow(/aggregate/)
        expect(() => parseInboundMessageNotificationRequestedEventV1({ ...intent, data: { ...intent.data, channel: 'phone' } })).toThrow(/channel/)
        expect(() => parseInboundMessageNotificationRequestedEventV1({ ...intent, data: { ...intent.data, chatId: '../x' } })).toThrow(/chatId/)
    })
})

describe('Mobile Push v1 registration body', () => {
    const token = 'fcm-token_ABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789'

    it('is exactly { token }', () => {
        expect(parseRegisterMobilePushDeviceBodyV1({ token })).toEqual({ token })
    })

    it('refuses any authority the client might try to claim', () => {
        for (const extra of ['deviceId', 'operatorId', 'runtimeOperatorId', 'credentialSubject', 'expiresAt', 'epoch', 'sessionBindingId']) {
            expect(() => parseRegisterMobilePushDeviceBodyV1({ token, [extra]: 'x' })).toThrow(/unsupported field/)
        }
    })

    it('refuses a malformed token or body', () => {
        for (const body of [null, [], 'token', {}, { token: '' }, { token: 'short' }, { token: 'x'.repeat(513) }, { token: 'has space and more characters here' }, { token: 42 }]) {
            expect(() => parseRegisterMobilePushDeviceBodyV1(body)).toThrow()
        }
    })
})
