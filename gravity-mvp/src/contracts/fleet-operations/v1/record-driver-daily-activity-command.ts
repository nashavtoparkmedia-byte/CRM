export const RECORD_DRIVER_DAILY_ACTIVITY_COMMAND_V1 = 'fleet_operations.RecordDriverDailyActivityCommand.v1' as const
export const RECORD_DRIVER_DAILY_ACTIVITY_RESULT_V1 = 'fleet_operations.RecordDriverDailyActivityResult.v1' as const

export const DRIVER_DAILY_ACTIVITIES_V1 = [
    'manager_message',
    'manager_call',
    'auto_message',
    'goal_achieved',
] as const
export type DriverDailyActivityV1 = typeof DRIVER_DAILY_ACTIVITIES_V1[number]

export interface RecordDriverDailyActivityCommandV1 {
    contract: typeof RECORD_DRIVER_DAILY_ACTIVITY_COMMAND_V1
    driverId: string
    dayStart: string
    activity: DriverDailyActivityV1
}

export interface RecordDriverDailyActivityResultV1 {
    contract: typeof RECORD_DRIVER_DAILY_ACTIVITY_RESULT_V1
    recorded: true
}

export class RecordDriverDailyActivityValidationError extends Error {
    readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'

    constructor(code: RecordDriverDailyActivityValidationError['code'], message: string) {
        super(message)
        this.name = 'RecordDriverDailyActivityValidationError'
        this.code = code
    }
}

const FIELDS = new Set(['contract', 'driverId', 'dayStart', 'activity'])
const ACTIVITIES = new Set<string>(DRIVER_DAILY_ACTIVITIES_V1)
const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
function invalid(message: string): never {
    throw new RecordDriverDailyActivityValidationError('INVALID_CONTRACT', message)
}

export function parseRecordDriverDailyActivityCommandV1(input: unknown): RecordDriverDailyActivityCommandV1 {
    if (!isRecord(input)) invalid('command must be an object')
    const unexpected = Object.keys(input).filter((key) => !FIELDS.has(key))
    if (unexpected.length) invalid(`unsupported command field(s): ${unexpected.sort().join(', ')}`)
    if (input.contract !== RECORD_DRIVER_DAILY_ACTIVITY_COMMAND_V1) {
        if (typeof input.contract === 'string' && input.contract.startsWith('fleet_operations.RecordDriverDailyActivityCommand.')) {
            throw new RecordDriverDailyActivityValidationError(
                'UNSUPPORTED_CONTRACT_VERSION',
                `unsupported contract version: ${input.contract}`,
            )
        }
        invalid(`contract must equal ${RECORD_DRIVER_DAILY_ACTIVITY_COMMAND_V1}`)
    }
    if (typeof input.driverId !== 'string' || input.driverId.trim() === '') invalid('driverId is required')
    if (typeof input.dayStart !== 'string' || !Number.isFinite(Date.parse(input.dayStart))) invalid('dayStart must be an ISO date-time string')
    if (typeof input.activity !== 'string' || !ACTIVITIES.has(input.activity)) invalid('activity is invalid')
    return input as unknown as RecordDriverDailyActivityCommandV1
}
