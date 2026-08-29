export const RECORDING_READY_EVENT_V1 = 'calling.RecordingReady.v1' as const

export interface RecordingReadyEventV1 {
    eventId: string
    eventType: typeof RECORDING_READY_EVENT_V1
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
        recordingPath: string
    }
}

export class RecordingReadyEventValidationError extends Error {
    readonly code = 'INVALID_RECORDING_READY_EVENT'

    constructor(message: string) {
        super(message)
        this.name = 'RecordingReadyEventValidationError'
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(message: string): never {
    throw new RecordingReadyEventValidationError(message)
}

function hasOnly(value: Record<string, unknown>, fields: string[], scope: string): void {
    const allowed = new Set(fields)
    const unexpected = Object.keys(value).filter((key) => !allowed.has(key))
    if (unexpected.length > 0) fail(`${scope} has unsupported field(s): ${unexpected.sort().join(', ')}`)
}

export function makeRecordingReadyEventV1(input: {
    callId: string
    recordingPath: string
    occurredAt: string
    correlationId?: string | null
    causationId?: string | null
}): RecordingReadyEventV1 {
    const event: RecordingReadyEventV1 = {
        eventId: `${RECORDING_READY_EVENT_V1}:${input.callId}:${input.recordingPath}`,
        eventType: RECORDING_READY_EVENT_V1,
        eventVersion: 1,
        occurredAt: input.occurredAt,
        aggregate: { type: 'Call', id: input.callId },
        correlationId: input.correlationId ?? input.callId,
        causationId: input.causationId ?? null,
        data: {
            callId: input.callId,
            recordingPath: input.recordingPath,
        },
    }
    return parseRecordingReadyEventV1(event)
}

export function parseRecordingReadyEventV1(input: unknown): RecordingReadyEventV1 {
    if (!isRecord(input)) fail('event must be an object')
    hasOnly(input, [
        'eventId', 'eventType', 'eventVersion', 'occurredAt', 'aggregate',
        'correlationId', 'causationId', 'data',
    ], 'event')

    if (typeof input.eventId !== 'string' || input.eventId.length === 0) fail('eventId is required')
    if (input.eventType !== RECORDING_READY_EVENT_V1 || input.eventVersion !== 1) {
        fail(`event must be ${RECORDING_READY_EVENT_V1}`)
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
    hasOnly(input.data, ['callId', 'recordingPath'], 'data')
    if (typeof input.data.callId !== 'string' || input.data.callId.length === 0) fail('data.callId is required')
    if (typeof input.data.recordingPath !== 'string' || input.data.recordingPath.length === 0) {
        fail('data.recordingPath is required')
    }
    if (input.aggregate.id !== input.data.callId) fail('aggregate.id must equal data.callId')

    return input as unknown as RecordingReadyEventV1
}
