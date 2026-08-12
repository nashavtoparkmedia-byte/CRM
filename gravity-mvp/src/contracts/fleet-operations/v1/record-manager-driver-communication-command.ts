export const RECORD_MANAGER_DRIVER_COMMUNICATION_COMMAND_V1 =
    'fleet_operations.RecordManagerDriverCommunicationCommand.v1' as const
export const RECORD_MANAGER_DRIVER_COMMUNICATION_RESULT_V1 =
    'fleet_operations.RecordManagerDriverCommunicationResult.v1' as const

export const MANAGER_DRIVER_COMMUNICATION_ACTIVITIES_V1 = ['call', 'message'] as const
export type ManagerDriverCommunicationActivityV1 =
    typeof MANAGER_DRIVER_COMMUNICATION_ACTIVITIES_V1[number]

export interface RecordManagerDriverCommunicationCommandV1 {
    contract: typeof RECORD_MANAGER_DRIVER_COMMUNICATION_COMMAND_V1
    driverId: string
    activity: ManagerDriverCommunicationActivityV1
}

export interface RecordManagerDriverCommunicationResultV1 {
    contract: typeof RECORD_MANAGER_DRIVER_COMMUNICATION_RESULT_V1
    logged: true
}

export class RecordManagerDriverCommunicationValidationError extends Error {
    readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'

    constructor(code: RecordManagerDriverCommunicationValidationError['code'], message: string) {
        super(message)
        this.name = 'RecordManagerDriverCommunicationValidationError'
        this.code = code
    }
}

const FIELDS = new Set(['contract', 'driverId', 'activity'])
const ACTIVITIES = new Set<string>(MANAGER_DRIVER_COMMUNICATION_ACTIVITIES_V1)
const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

function invalid(message: string): never {
    throw new RecordManagerDriverCommunicationValidationError('INVALID_CONTRACT', message)
}

export function parseRecordManagerDriverCommunicationCommandV1(
    input: unknown,
): RecordManagerDriverCommunicationCommandV1 {
    if (!isRecord(input)) invalid('command must be an object')

    const unexpected = Object.keys(input).filter((key) => !FIELDS.has(key))
    if (unexpected.length) invalid(`unsupported command field(s): ${unexpected.sort().join(', ')}`)

    if (input.contract !== RECORD_MANAGER_DRIVER_COMMUNICATION_COMMAND_V1) {
        if (
            typeof input.contract === 'string'
            && input.contract.startsWith('fleet_operations.RecordManagerDriverCommunicationCommand.')
        ) {
            throw new RecordManagerDriverCommunicationValidationError(
                'UNSUPPORTED_CONTRACT_VERSION',
                `unsupported contract version: ${input.contract}`,
            )
        }
        invalid(`contract must equal ${RECORD_MANAGER_DRIVER_COMMUNICATION_COMMAND_V1}`)
    }

    if (typeof input.driverId !== 'string' || input.driverId.trim() === '') {
        invalid('driverId is required')
    }
    if (typeof input.activity !== 'string' || !ACTIVITIES.has(input.activity)) {
        invalid('activity is invalid')
    }

    return input as unknown as RecordManagerDriverCommunicationCommandV1
}
