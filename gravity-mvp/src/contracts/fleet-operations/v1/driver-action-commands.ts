export const RECORD_DRIVER_ACTION_COMMAND_V1 = 'fleet_operations.RecordDriverActionCommand.v1' as const
export const RECORD_DRIVER_ACTION_RESULT_V1 = 'fleet_operations.RecordDriverActionResult.v1' as const
export const MIRROR_DRIVER_ACTION_RESULT_COMMAND_V1 = 'fleet_operations.MirrorDriverActionResultCommand.v1' as const
export const MIRROR_DRIVER_ACTION_RESULT_RESULT_V1 = 'fleet_operations.MirrorDriverActionResultResult.v1' as const

export const DRIVER_ACTION_KINDS_V1 = ['GET_PRICE', 'COMPLETE_ORDER', 'CANCEL_ORDER'] as const
export const DRIVER_ACTION_STATUSES_V1 = ['PENDING', 'DONE', 'FAILED', 'TIMEOUT', 'NEEDS_REASON_PROBE', 'ESCALATED_TO_MANAGER'] as const
export type DriverActionKindV1 = typeof DRIVER_ACTION_KINDS_V1[number]
export type DriverActionStatusV1 = typeof DRIVER_ACTION_STATUSES_V1[number]

export interface DriverActionCreateV1 {
    driverId: string
    kind: DriverActionKindV1
    requestedBy: string
    status: DriverActionStatusV1
    errorMessage?: string
    scraperTaskId?: string
}

export interface RecordDriverActionCommandV1 {
    contract: typeof RECORD_DRIVER_ACTION_COMMAND_V1
    data: DriverActionCreateV1
}

export interface RecordDriverActionResultV1 {
    contract: typeof RECORD_DRIVER_ACTION_RESULT_V1
    action: { id: string }
}

export interface MirrorDriverActionResultCommandV1 {
    contract: typeof MIRROR_DRIVER_ACTION_RESULT_COMMAND_V1
    scraperTaskId: string
    status: DriverActionStatusV1
    result?: unknown
    errorMessage: string | null
    shortOrderId?: string
    orderId?: string
    completedAt: Date
}

export interface MirrorDriverActionResultResultV1 {
    contract: typeof MIRROR_DRIVER_ACTION_RESULT_RESULT_V1
    updatedCount: number
}

export class DriverActionCommandValidationError extends Error {
    readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'
    constructor(code: DriverActionCommandValidationError['code'], message: string) {
        super(message)
        this.name = 'DriverActionCommandValidationError'
        this.code = code
    }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
const isNonEmptyString = (value: unknown): value is string =>
    typeof value === 'string' && value.trim() !== ''
const isKind = (value: unknown): value is DriverActionKindV1 =>
    DRIVER_ACTION_KINDS_V1.includes(value as DriverActionKindV1)
const isStatus = (value: unknown): value is DriverActionStatusV1 =>
    DRIVER_ACTION_STATUSES_V1.includes(value as DriverActionStatusV1)
function invalid(message: string): never {
    throw new DriverActionCommandValidationError('INVALID_CONTRACT', message)
}
function exactFields(input: Record<string, unknown>, fields: string[]) {
    const extra = Object.keys(input).filter(key => !fields.includes(key))
    if (extra.length) invalid(`unsupported field(s): ${extra.sort().join(', ')}`)
}
function envelope(input: unknown, expected: string, prefix: string, fields: string[]) {
    if (!isRecord(input)) invalid('command must be an object')
    exactFields(input, fields)
    if (input.contract !== expected) {
        if (typeof input.contract === 'string' && input.contract.startsWith(prefix)) {
            throw new DriverActionCommandValidationError('UNSUPPORTED_CONTRACT_VERSION', `unsupported contract version: ${input.contract}`)
        }
        invalid(`contract must equal ${expected}`)
    }
    return input
}

export function parseRecordDriverActionCommandV1(input: unknown): RecordDriverActionCommandV1 {
    const value = envelope(input, RECORD_DRIVER_ACTION_COMMAND_V1, 'fleet_operations.RecordDriverActionCommand.', ['contract', 'data'])
    if (!isRecord(value.data)) invalid('data must be an object')
    exactFields(value.data, ['driverId', 'kind', 'requestedBy', 'status', 'errorMessage', 'scraperTaskId'])
    for (const key of ['driverId', 'requestedBy']) if (!isNonEmptyString(value.data[key])) invalid(`data.${key} is required`)
    if (!isKind(value.data.kind)) invalid('data.kind is invalid')
    if (!isStatus(value.data.status)) invalid('data.status is invalid')
    for (const key of ['errorMessage', 'scraperTaskId']) {
        if (value.data[key] !== undefined && typeof value.data[key] !== 'string') invalid(`data.${key} must be a string`)
    }
    return value as unknown as RecordDriverActionCommandV1
}

export function parseMirrorDriverActionResultCommandV1(input: unknown): MirrorDriverActionResultCommandV1 {
    const value = envelope(input, MIRROR_DRIVER_ACTION_RESULT_COMMAND_V1, 'fleet_operations.MirrorDriverActionResultCommand.', [
        'contract', 'scraperTaskId', 'status', 'result', 'errorMessage', 'shortOrderId', 'orderId', 'completedAt',
    ])
    if (!isNonEmptyString(value.scraperTaskId)) invalid('scraperTaskId is required')
    if (!isStatus(value.status) || value.status === 'PENDING') invalid('status must be terminal or escalated')
    if (value.errorMessage !== null && typeof value.errorMessage !== 'string') invalid('errorMessage must be a string or null')
    for (const key of ['shortOrderId', 'orderId']) {
        if (value[key] !== undefined && typeof value[key] !== 'string') invalid(`${key} must be a string`)
    }
    if (!(value.completedAt instanceof Date)) invalid('completedAt must be a Date')
    return value as unknown as MirrorDriverActionResultCommandV1
}
