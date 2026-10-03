/**
 * One call alert, aimed at one registered device.
 *
 * The fan-out of a CallAlertRequested produces one of these per eligible
 * registration. It names the call, the kind, the registration and the session
 * binding the fan-out saw - never a device token, because a token is resolved at
 * send time from identity_access so a rotation is honoured and a stale session is
 * refused.
 *
 * The event id is derived from the call, the kind and the registration, so a
 * retried fan-out cannot produce a second delivery for the same device and the
 * same alert.
 */

import type { CallAlertKindV1 } from './call-alert-requested-event'
import { CALL_ALERT_REQUESTED_EVENT_V1 } from './call-alert-requested-event'

export const CALL_ALERT_DELIVERY_REQUESTED_EVENT_V1 = 'calling.CallAlertDeliveryRequested.v1' as const

export interface CallAlertDeliveryRequestedEventV1 {
    eventId: string
    eventType: typeof CALL_ALERT_DELIVERY_REQUESTED_EVENT_V1
    eventVersion: 1
    occurredAt: string
    aggregate: {
        type: 'Call'
        id: string
    }
    correlationId: string | null
    causationId: string | null
    data: {
        callId: string
        kind: CallAlertKindV1
        registrationId: string
        sessionBindingId: string
    }
}

export class CallAlertDeliveryRequestedEventValidationError extends Error {
    readonly code = 'INVALID_CALL_ALERT_DELIVERY_REQUESTED_EVENT'

    constructor(message: string) {
        super(message)
        this.name = 'CallAlertDeliveryRequestedEventValidationError'
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(message: string): never {
    throw new CallAlertDeliveryRequestedEventValidationError(message)
}

function hasOnly(value: Record<string, unknown>, fields: string[], scope: string): void {
    const allowed = new Set(fields)
    const unexpected = Object.keys(value).filter((key) => !allowed.has(key))
    if (unexpected.length > 0) fail(`${scope} has unsupported field(s): ${unexpected.sort().join(', ')}`)
}

/** Per-device identity: one delivery per (call, kind, registration). */
export function callAlertDeliveryEventIdV1(callId: string, kind: CallAlertKindV1, registrationId: string): string {
    return `${CALL_ALERT_DELIVERY_REQUESTED_EVENT_V1}:${callId}:${kind}:${registrationId}`
}

export function makeCallAlertDeliveryRequestedEventV1(input: {
    callId: string
    kind: CallAlertKindV1
    registrationId: string
    sessionBindingId: string
    occurredAt: string
    correlationId?: string | null
    causationId?: string | null
}): CallAlertDeliveryRequestedEventV1 {
    const event: CallAlertDeliveryRequestedEventV1 = {
        eventId: callAlertDeliveryEventIdV1(input.callId, input.kind, input.registrationId),
        eventType: CALL_ALERT_DELIVERY_REQUESTED_EVENT_V1,
        eventVersion: 1,
        occurredAt: input.occurredAt,
        aggregate: { type: 'Call', id: input.callId },
        correlationId: input.correlationId ?? input.callId,
        causationId: input.causationId ?? `${CALL_ALERT_REQUESTED_EVENT_V1}:${input.callId}:${input.kind}`,
        data: {
            callId: input.callId,
            kind: input.kind,
            registrationId: input.registrationId,
            sessionBindingId: input.sessionBindingId,
        },
    }
    return parseCallAlertDeliveryRequestedEventV1(event)
}

export function parseCallAlertDeliveryRequestedEventV1(input: unknown): CallAlertDeliveryRequestedEventV1 {
    if (!isRecord(input)) fail('event must be an object')
    hasOnly(input, [
        'eventId', 'eventType', 'eventVersion', 'occurredAt', 'aggregate',
        'correlationId', 'causationId', 'data',
    ], 'event')

    if (typeof input.eventId !== 'string' || input.eventId.length === 0) fail('eventId is required')
    if (input.eventType !== CALL_ALERT_DELIVERY_REQUESTED_EVENT_V1 || input.eventVersion !== 1) {
        fail(`event must be ${CALL_ALERT_DELIVERY_REQUESTED_EVENT_V1}`)
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
    if (input.aggregate.type !== 'Call' || typeof input.aggregate.id !== 'string' || input.aggregate.id.length === 0) {
        fail('aggregate must identify a Call')
    }
    if (!isRecord(input.data)) fail('data must be an object')
    hasOnly(input.data, ['callId', 'kind', 'registrationId', 'sessionBindingId'], 'data')
    if (typeof input.data.callId !== 'string' || input.data.callId.length === 0) fail('data.callId is required')
    if (input.data.kind !== 'call_incoming' && input.data.kind !== 'call_missed') {
        fail('data.kind must be call_incoming or call_missed')
    }
    if (typeof input.data.registrationId !== 'string' || input.data.registrationId.length === 0) {
        fail('data.registrationId is required')
    }
    if (typeof input.data.sessionBindingId !== 'string' || input.data.sessionBindingId.length === 0) {
        fail('data.sessionBindingId is required')
    }
    if (input.aggregate.id !== input.data.callId) fail('aggregate.id must equal data.callId')
    if (input.eventId !== callAlertDeliveryEventIdV1(input.data.callId, input.data.kind, input.data.registrationId)) {
        fail('eventId must be derived from data.callId, data.kind and data.registrationId')
    }

    return input as unknown as CallAlertDeliveryRequestedEventV1
}
