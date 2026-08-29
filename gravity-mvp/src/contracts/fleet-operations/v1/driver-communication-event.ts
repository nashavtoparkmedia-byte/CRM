export const RECORD_DRIVER_COMMUNICATION_EVENT_COMMAND_V1 =
    'fleet_operations.RecordDriverCommunicationEventCommand.v1' as const
export const RECORD_DRIVER_COMMUNICATION_EVENT_RESULT_V1 =
    'fleet_operations.RecordDriverCommunicationEventResult.v1' as const
export const GET_DRIVER_COMMUNICATION_TIMELINE_QUERY_V1 =
    'fleet_operations.GetDriverCommunicationTimelineQuery.v1' as const
export const GET_DRIVER_COMMUNICATION_TIMELINE_RESULT_V1 =
    'fleet_operations.GetDriverCommunicationTimelineResult.v1' as const

export type DriverCommunicationActivityV1 = 'manager_message' | 'manager_call'

export interface RecordDriverCommunicationEventCommandV1 {
    contract: typeof RECORD_DRIVER_COMMUNICATION_EVENT_COMMAND_V1
    driverId: string
    activity: DriverCommunicationActivityV1
    channel: string
    content: string
    recipientPhone?: string
}

export interface RecordDriverCommunicationEventResultV1 {
    contract: typeof RECORD_DRIVER_COMMUNICATION_EVENT_RESULT_V1
    logged: true
}

export interface GetDriverCommunicationTimelineQueryV1 {
    contract: typeof GET_DRIVER_COMMUNICATION_TIMELINE_QUERY_V1
    driverId: string
    limit?: number
}

export interface DriverCommunicationTimelineEventV1 {
    id: string
    channel: string
    direction: string
    eventType: string
    content: string | null
    createdBy: string | null
    createdAt: string
    metadata: Record<string, unknown> | null
}

export interface GetDriverCommunicationTimelineResultV1 {
    contract: typeof GET_DRIVER_COMMUNICATION_TIMELINE_RESULT_V1
    events: DriverCommunicationTimelineEventV1[]
}

export class DriverCommunicationEventValidationError extends Error {
    readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'

    constructor(code: DriverCommunicationEventValidationError['code'], message: string) {
        super(message)
        this.name = 'DriverCommunicationEventValidationError'
        this.code = code
    }
}

const RECORD_FIELDS = new Set(['contract', 'driverId', 'activity', 'channel', 'content', 'recipientPhone'])
const QUERY_FIELDS = new Set(['contract', 'driverId', 'limit'])
const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
function invalid(message: string): never {
    throw new DriverCommunicationEventValidationError('INVALID_CONTRACT', message)
}
function requireString(value: unknown, field: string): asserts value is string {
    if (typeof value !== 'string' || value.trim() === '') invalid(`${field} is required`)
}
function requireEnvelope(
    input: unknown,
    expected: string,
    prefix: string,
    fields: Set<string>,
): Record<string, unknown> {
    if (!isRecord(input)) invalid('input must be an object')
    const unexpected = Object.keys(input).filter((field) => !fields.has(field))
    if (unexpected.length) invalid(`unsupported field(s): ${unexpected.sort().join(', ')}`)
    if (input.contract !== expected) {
        if (typeof input.contract === 'string' && input.contract.startsWith(prefix)) {
            throw new DriverCommunicationEventValidationError(
                'UNSUPPORTED_CONTRACT_VERSION',
                `unsupported contract version: ${input.contract}`,
            )
        }
        invalid(`contract must equal ${expected}`)
    }
    return input
}

export function parseRecordDriverCommunicationEventCommandV1(
    input: unknown,
): RecordDriverCommunicationEventCommandV1 {
    const value = requireEnvelope(
        input,
        RECORD_DRIVER_COMMUNICATION_EVENT_COMMAND_V1,
        'fleet_operations.RecordDriverCommunicationEventCommand.',
        RECORD_FIELDS,
    )
    requireString(value.driverId, 'driverId')
    requireString(value.channel, 'channel')
    if (typeof value.content !== 'string') invalid('content must be a string')
    if (value.activity !== 'manager_message' && value.activity !== 'manager_call') {
        invalid('activity is invalid')
    }
    if (value.activity === 'manager_call') {
        if (value.channel !== 'phone') invalid('manager_call channel must be phone')
        if (value.recipientPhone !== undefined) invalid('manager_call must not include recipientPhone')
    } else {
        requireString(value.recipientPhone, 'recipientPhone')
    }
    return value as unknown as RecordDriverCommunicationEventCommandV1
}

export function parseGetDriverCommunicationTimelineQueryV1(
    input: unknown,
): GetDriverCommunicationTimelineQueryV1 {
    const value = requireEnvelope(
        input,
        GET_DRIVER_COMMUNICATION_TIMELINE_QUERY_V1,
        'fleet_operations.GetDriverCommunicationTimelineQuery.',
        QUERY_FIELDS,
    )
    requireString(value.driverId, 'driverId')
    if (
        value.limit !== undefined
        && (!Number.isInteger(value.limit) || (value.limit as number) < 1 || (value.limit as number) > 100)
    ) invalid('limit must be an integer from 1 to 100')
    return value as unknown as GetDriverCommunicationTimelineQueryV1
}
