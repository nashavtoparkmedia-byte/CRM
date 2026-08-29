export const AI_CALL_FINALIZATION_FOLLOW_UP_REQUESTED_EVENT_V1 =
    'calling.AiCallFinalizationFollowUpRequested.v1' as const

export interface AiCallFinalizationFollowUpRequestedEventV1 {
    eventId: string
    eventType: typeof AI_CALL_FINALIZATION_FOLLOW_UP_REQUESTED_EVENT_V1
    eventVersion: 1
    occurredAt: string
    aggregate: {
        type: 'Call'
        id: string
    }
    correlationId: string
    causationId: string
    data: {
        callId: string
        finalizationId: string
        finalizationFingerprint: string
    }
}

export class AiCallFinalizationFollowUpRequestedEventValidationError extends Error {
    readonly code = 'INVALID_AI_CALL_FINALIZATION_FOLLOW_UP_REQUESTED_EVENT'

    constructor(message: string) {
        super(message)
        this.name = 'AiCallFinalizationFollowUpRequestedEventValidationError'
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(message: string): never {
    throw new AiCallFinalizationFollowUpRequestedEventValidationError(message)
}

function hasOnly(value: Record<string, unknown>, fields: string[], scope: string): void {
    const allowed = new Set(fields)
    const unexpected = Object.keys(value).filter((key) => !allowed.has(key))
    if (unexpected.length > 0) fail(`${scope} has unsupported field(s): ${unexpected.sort().join(', ')}`)
}

export function makeAiCallFinalizationFollowUpRequestedEventV1(input: {
    callId: string
    finalizationId: string
    finalizationFingerprint: string
    occurredAt: string
}): AiCallFinalizationFollowUpRequestedEventV1 {
    return parseAiCallFinalizationFollowUpRequestedEventV1({
        eventId: `${AI_CALL_FINALIZATION_FOLLOW_UP_REQUESTED_EVENT_V1}:${input.callId}`,
        eventType: AI_CALL_FINALIZATION_FOLLOW_UP_REQUESTED_EVENT_V1,
        eventVersion: 1,
        occurredAt: input.occurredAt,
        aggregate: { type: 'Call', id: input.callId },
        correlationId: input.callId,
        causationId: input.finalizationId,
        data: {
            callId: input.callId,
            finalizationId: input.finalizationId,
            finalizationFingerprint: input.finalizationFingerprint,
        },
    })
}

export function parseAiCallFinalizationFollowUpRequestedEventV1(
    input: unknown,
): AiCallFinalizationFollowUpRequestedEventV1 {
    if (!isRecord(input)) fail('event must be an object')
    hasOnly(input, [
        'eventId', 'eventType', 'eventVersion', 'occurredAt', 'aggregate',
        'correlationId', 'causationId', 'data',
    ], 'event')
    if (input.eventType !== AI_CALL_FINALIZATION_FOLLOW_UP_REQUESTED_EVENT_V1 || input.eventVersion !== 1) {
        fail(`event must be ${AI_CALL_FINALIZATION_FOLLOW_UP_REQUESTED_EVENT_V1}`)
    }
    if (typeof input.eventId !== 'string' || input.eventId.length === 0) fail('eventId is required')
    if (typeof input.occurredAt !== 'string' || Number.isNaN(Date.parse(input.occurredAt))) {
        fail('occurredAt must be an ISO timestamp')
    }
    if (!isRecord(input.aggregate)) fail('aggregate must be an object')
    hasOnly(input.aggregate, ['type', 'id'], 'aggregate')
    if (input.aggregate.type !== 'Call' || typeof input.aggregate.id !== 'string' || !input.aggregate.id) {
        fail('aggregate must identify a Call')
    }
    if (typeof input.correlationId !== 'string' || typeof input.causationId !== 'string') {
        fail('correlationId and causationId are required')
    }
    if (!isRecord(input.data)) fail('data must be an object')
    hasOnly(input.data, ['callId', 'finalizationId', 'finalizationFingerprint'], 'data')
    if (typeof input.data.callId !== 'string' || !input.data.callId) fail('data.callId is required')
    if (typeof input.data.finalizationId !== 'string' || !input.data.finalizationId) {
        fail('data.finalizationId is required')
    }
    if (typeof input.data.finalizationFingerprint !== 'string'
        || !/^[0-9a-f]{64}$/.test(input.data.finalizationFingerprint)) {
        fail('data.finalizationFingerprint must be a SHA-256 digest')
    }
    if (input.aggregate.id !== input.data.callId || input.correlationId !== input.data.callId) {
        fail('aggregate and correlation must identify data.callId')
    }
    if (input.causationId !== input.data.finalizationId) fail('causationId must identify finalizationId')
    if (input.data.finalizationId !== `ai-call-finalization:v1:${input.data.callId}`) {
        fail('finalizationId does not belong to data.callId')
    }
    if (input.eventId !== `${AI_CALL_FINALIZATION_FOLLOW_UP_REQUESTED_EVENT_V1}:${input.data.callId}`) {
        fail('eventId is not deterministic for data.callId')
    }
    return input as unknown as AiCallFinalizationFollowUpRequestedEventV1
}
