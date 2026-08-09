export const LOG_MANAGER_CALL_COMMAND_V1 = 'fleet_operations.LogManagerCallCommand.v1' as const
export const LOG_MANAGER_CALL_RESULT_V1 = 'fleet_operations.LogManagerCallResult.v1' as const

export interface LogManagerCallCommandV1 {
    contract: typeof LOG_MANAGER_CALL_COMMAND_V1
    driverId: string
}

export interface LogManagerCallResultV1 {
    contract: typeof LOG_MANAGER_CALL_RESULT_V1
    logged: true
}

export class LogManagerCallValidationError extends Error {
    readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'

    constructor(code: LogManagerCallValidationError['code'], message: string) {
        super(message)
        this.name = 'LogManagerCallValidationError'
        this.code = code
    }
}

const FIELDS = new Set(['contract', 'driverId'])
const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
function invalid(message: string): never {
    throw new LogManagerCallValidationError('INVALID_CONTRACT', message)
}

export function parseLogManagerCallCommandV1(input: unknown): LogManagerCallCommandV1 {
    if (!isRecord(input)) invalid('command must be an object')
    const unexpected = Object.keys(input).filter((key) => !FIELDS.has(key))
    if (unexpected.length) invalid(`unsupported command field(s): ${unexpected.sort().join(', ')}`)
    if (input.contract !== LOG_MANAGER_CALL_COMMAND_V1) {
        if (typeof input.contract === 'string' && input.contract.startsWith('fleet_operations.LogManagerCallCommand.')) {
            throw new LogManagerCallValidationError(
                'UNSUPPORTED_CONTRACT_VERSION',
                `unsupported contract version: ${input.contract}`,
            )
        }
        invalid(`contract must equal ${LOG_MANAGER_CALL_COMMAND_V1}`)
    }
    if (typeof input.driverId !== 'string' || input.driverId.trim() === '') invalid('driverId is required')
    return input as unknown as LogManagerCallCommandV1
}
