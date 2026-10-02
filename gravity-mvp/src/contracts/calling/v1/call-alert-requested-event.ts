/**
 * A call needs an alert on the operators' phones.
 *
 * Calling is the authority for whether a call is ringing or was missed; this
 * event carries that decision and nothing else. It names a call and a kind, so a
 * consumer can neither learn who called nor reconstruct the conversation: no
 * phone number, no contact name, no fsUuid, no SIP or provider data, no URL, no
 * recording, no transcript.
 *
 * The event id is derived from the call and the kind, which is what makes the
 * semantics idempotent: a retry, or a second emission from another path into the
 * same domain transition, collapses onto the same row. One call may legitimately
 * produce one call_incoming and later one call_missed - two kinds, two ids.
 */

export const CALL_ALERT_REQUESTED_EVENT_V1 = 'calling.CallAlertRequested.v1' as const

export type CallAlertKindV1 = 'call_incoming' | 'call_missed'

export const CALL_ALERT_KINDS_V1: readonly CallAlertKindV1[] = ['call_incoming', 'call_missed']

export interface CallAlertRequestedEventV1 {
    eventId: string
    eventType: typeof CALL_ALERT_REQUESTED_EVENT_V1
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
    }
}

export class CallAlertRequestedEventValidationError extends Error {
    readonly code = 'INVALID_CALL_ALERT_REQUESTED_EVENT'

    constructor(message: string) {
        super(message)
        this.name = 'CallAlertRequestedEventValidationError'
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(message: string): never {
    throw new CallAlertRequestedEventValidationError(message)
}

function hasOnly(value: Record<string, unknown>, fields: string[], scope: string): void {
    const allowed = new Set(fields)
    const unexpected = Object.keys(value).filter((key) => !allowed.has(key))
    if (unexpected.length > 0) fail(`${scope} has unsupported field(s): ${unexpected.sort().join(', ')}`)
}

/** Semantic identity: one alert per (call, kind), however many times it is asked for. */
export function callAlertRequestedEventIdV1(callId: string, kind: CallAlertKindV1): string {
    return `${CALL_ALERT_REQUESTED_EVENT_V1}:${callId}:${kind}`
}

export function makeCallAlertRequestedEventV1(input: {
    callId: string
    kind: CallAlertKindV1
    occurredAt: string
    correlationId?: string | null
    causationId?: string | null
}): CallAlertRequestedEventV1 {
    const event: CallAlertRequestedEventV1 = {
        eventId: callAlertRequestedEventIdV1(input.callId, input.kind),
        eventType: CALL_ALERT_REQUESTED_EVENT_V1,
        eventVersion: 1,
        occurredAt: input.occurredAt,
        aggregate: { type: 'Call', id: input.callId },
        correlationId: input.correlationId ?? input.callId,
        causationId: input.causationId ?? null,
        data: { callId: input.callId, kind: input.kind },
    }
    return parseCallAlertRequestedEventV1(event)
}

export function parseCallAlertRequestedEventV1(input: unknown): CallAlertRequestedEventV1 {
    if (!isRecord(input)) fail('event must be an object')
    hasOnly(input, [
        'eventId', 'eventType', 'eventVersion', 'occurredAt', 'aggregate',
        'correlationId', 'causationId', 'data',
    ], 'event')

    if (typeof input.eventId !== 'string' || input.eventId.length === 0) fail('eventId is required')
    if (input.eventType !== CALL_ALERT_REQUESTED_EVENT_V1 || input.eventVersion !== 1) {
        fail(`event must be ${CALL_ALERT_REQUESTED_EVENT_V1}`)
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
    hasOnly(input.data, ['callId', 'kind'], 'data')
    if (typeof input.data.callId !== 'string' || input.data.callId.length === 0) fail('data.callId is required')
    if (input.data.kind !== 'call_incoming' && input.data.kind !== 'call_missed') {
        fail('data.kind must be call_incoming or call_missed')
    }
    if (input.aggregate.id !== input.data.callId) fail('aggregate.id must equal data.callId')
    if (input.eventId !== callAlertRequestedEventIdV1(input.data.callId, input.data.kind)) {
        fail('eventId must be derived from data.callId and data.kind')
    }

    return input as unknown as CallAlertRequestedEventV1
}
