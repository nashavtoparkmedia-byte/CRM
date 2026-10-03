import { describe, expect, it } from 'vitest'
import {
    CALL_ALERT_DELIVERY_REQUESTED_EVENT_V1,
    CALL_ALERT_REQUESTED_EVENT_V1,
    CallAlertDeliveryRequestedEventValidationError,
    CallAlertRequestedEventValidationError,
    callAlertDeliveryEventIdV1,
    callAlertRequestedEventIdV1,
    makeCallAlertDeliveryRequestedEventV1,
    makeCallAlertRequestedEventV1,
    parseCallAlertDeliveryRequestedEventV1,
    parseCallAlertRequestedEventV1,
} from './index'

const AT = '2026-09-27T10:00:00.000Z'

describe('CallAlertRequested', () => {
    it('identity is the call and the kind, so a retry collapses', () => {
        const a = makeCallAlertRequestedEventV1({ callId: 'c1', kind: 'call_incoming', occurredAt: AT })
        const b = makeCallAlertRequestedEventV1({ callId: 'c1', kind: 'call_incoming', occurredAt: '2026-09-27T11:00:00.000Z' })
        expect(a.eventId).toBe(b.eventId)
        expect(a.eventId).toBe(callAlertRequestedEventIdV1('c1', 'call_incoming'))
    })

    it('one call may produce both kinds, and they are distinct rows', () => {
        const incoming = makeCallAlertRequestedEventV1({ callId: 'c1', kind: 'call_incoming', occurredAt: AT })
        const missed = makeCallAlertRequestedEventV1({ callId: 'c1', kind: 'call_missed', occurredAt: AT })
        expect(incoming.eventId).not.toBe(missed.eventId)
    })

    it('carries the call and the kind, and nothing that could identify a person', () => {
        const event = makeCallAlertRequestedEventV1({ callId: 'c1', kind: 'call_incoming', occurredAt: AT })
        expect(Object.keys(event.data).sort()).toEqual(['callId', 'kind'])
        expect(event.aggregate).toEqual({ type: 'Call', id: 'c1' })
        expect(event.eventType).toBe(CALL_ALERT_REQUESTED_EVENT_V1)
    })

    it('refuses an unknown kind', () => {
        expect(() => parseCallAlertRequestedEventV1({
            ...makeCallAlertRequestedEventV1({ callId: 'c1', kind: 'call_incoming', occurredAt: AT }),
            data: { callId: 'c1', kind: 'call_answered' },
        })).toThrow(CallAlertRequestedEventValidationError)
    })

    it('refuses a smuggled extra field', () => {
        expect(() => parseCallAlertRequestedEventV1({
            ...makeCallAlertRequestedEventV1({ callId: 'c1', kind: 'call_incoming', occurredAt: AT }),
            data: { callId: 'c1', kind: 'call_incoming', fromNumber: '+79990000000' },
        })).toThrow(/unsupported field/)
    })

    it('refuses an event id that does not derive from its own data', () => {
        expect(() => parseCallAlertRequestedEventV1({
            ...makeCallAlertRequestedEventV1({ callId: 'c1', kind: 'call_incoming', occurredAt: AT }),
            eventId: 'anything-else',
        })).toThrow(/derived/)
    })

    it('refuses an aggregate that disagrees with the payload', () => {
        expect(() => parseCallAlertRequestedEventV1({
            ...makeCallAlertRequestedEventV1({ callId: 'c1', kind: 'call_incoming', occurredAt: AT }),
            aggregate: { type: 'Call', id: 'c2' },
        })).toThrow(/aggregate.id must equal/)
    })
})

describe('CallAlertDeliveryRequested', () => {
    const base = { callId: 'c1', kind: 'call_incoming' as const, sessionBindingId: 'b1', occurredAt: AT }

    it('identity is the call, the kind and the registration', () => {
        const a = makeCallAlertDeliveryRequestedEventV1({ ...base, registrationId: 'r1' })
        const b = makeCallAlertDeliveryRequestedEventV1({ ...base, registrationId: 'r1', occurredAt: '2026-09-27T12:00:00.000Z' })
        expect(a.eventId).toBe(b.eventId)
        expect(a.eventId).toBe(callAlertDeliveryEventIdV1('c1', 'call_incoming', 'r1'))
    })

    it('two devices for one alert are two distinct deliveries', () => {
        const one = makeCallAlertDeliveryRequestedEventV1({ ...base, registrationId: 'r1' })
        const two = makeCallAlertDeliveryRequestedEventV1({ ...base, registrationId: 'r2' })
        expect(one.eventId).not.toBe(two.eventId)
    })

    it('names the registration and binding, never a device token', () => {
        const event = makeCallAlertDeliveryRequestedEventV1({ ...base, registrationId: 'r1' })
        expect(Object.keys(event.data).sort()).toEqual(['callId', 'kind', 'registrationId', 'sessionBindingId'])
        expect(JSON.stringify(event)).not.toMatch(/token/i)
        expect(event.eventType).toBe(CALL_ALERT_DELIVERY_REQUESTED_EVENT_V1)
    })

    it('is caused by the semantic alert it came from', () => {
        const event = makeCallAlertDeliveryRequestedEventV1({ ...base, registrationId: 'r1' })
        expect(event.causationId).toBe(callAlertRequestedEventIdV1('c1', 'call_incoming'))
    })

    it('requires a registration and a binding', () => {
        for (const field of ['registrationId', 'sessionBindingId']) {
            const event = makeCallAlertDeliveryRequestedEventV1({ ...base, registrationId: 'r1' })
            expect(() => parseCallAlertDeliveryRequestedEventV1({
                ...event,
                data: { ...event.data, [field]: '' },
            })).toThrow(CallAlertDeliveryRequestedEventValidationError)
        }
    })
})
