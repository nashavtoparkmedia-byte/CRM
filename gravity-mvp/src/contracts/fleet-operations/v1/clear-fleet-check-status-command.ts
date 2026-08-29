export const CLEAR_FLEET_CHECK_STATUS_COMMAND_V1 = 'fleet_operations.ClearFleetCheckStatusCommand.v1' as const
export const CLEAR_FLEET_CHECK_STATUS_RESULT_V1 = 'fleet_operations.ClearFleetCheckStatusResult.v1' as const
export const CLEAR_ALL_DRIVER_FLEET_CHECK_STATUSES_V1 = 'clear_all_driver_fleet_check_statuses' as const

export interface ClearFleetCheckStatusCommandV1 {
    contract: typeof CLEAR_FLEET_CHECK_STATUS_COMMAND_V1
    operation: typeof CLEAR_ALL_DRIVER_FLEET_CHECK_STATUSES_V1
}

export interface ClearFleetCheckStatusResultV1 {
    contract: typeof CLEAR_FLEET_CHECK_STATUS_RESULT_V1
    clearedCount: number
}

export class ClearFleetCheckStatusValidationError extends Error {
    readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'

    constructor(code: ClearFleetCheckStatusValidationError['code'], message: string) {
        super(message)
        this.name = 'ClearFleetCheckStatusValidationError'
        this.code = code
    }
}

const FIELDS = new Set(['contract', 'operation'])
const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
function invalid(message: string): never {
    throw new ClearFleetCheckStatusValidationError('INVALID_CONTRACT', message)
}

export function parseClearFleetCheckStatusCommandV1(input: unknown): ClearFleetCheckStatusCommandV1 {
    if (!isRecord(input)) invalid('command must be an object')
    const unexpected = Object.keys(input).filter((key) => !FIELDS.has(key))
    if (unexpected.length) invalid(`unsupported command field(s): ${unexpected.sort().join(', ')}`)
    if (input.contract !== CLEAR_FLEET_CHECK_STATUS_COMMAND_V1) {
        if (typeof input.contract === 'string' && input.contract.startsWith('fleet_operations.ClearFleetCheckStatusCommand.')) {
            throw new ClearFleetCheckStatusValidationError(
                'UNSUPPORTED_CONTRACT_VERSION',
                `unsupported contract version: ${input.contract}`,
            )
        }
        invalid(`contract must equal ${CLEAR_FLEET_CHECK_STATUS_COMMAND_V1}`)
    }
    if (input.operation !== CLEAR_ALL_DRIVER_FLEET_CHECK_STATUSES_V1) invalid('operation is invalid')
    return input as unknown as ClearFleetCheckStatusCommandV1
}
