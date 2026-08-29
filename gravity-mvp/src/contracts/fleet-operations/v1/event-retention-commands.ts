export const RUN_DRIVER_EVENT_RETENTION_COMMAND_V1 = 'fleet_operations.RunDriverEventRetentionCommand.v1' as const
export const RUN_DRIVER_EVENT_RETENTION_RESULT_V1 = 'fleet_operations.RunDriverEventRetentionResult.v1' as const
export const RUN_API_LOG_RETENTION_COMMAND_V1 = 'fleet_operations.RunApiLogRetentionCommand.v1' as const
export const RUN_API_LOG_RETENTION_RESULT_V1 = 'fleet_operations.RunApiLogRetentionResult.v1' as const

export interface RunDriverEventRetentionCommandV1 {
  contract: typeof RUN_DRIVER_EVENT_RETENTION_COMMAND_V1
  dryRun: boolean
}

export interface RunDriverEventRetentionResultV1 {
  contract: typeof RUN_DRIVER_EVENT_RETENTION_RESULT_V1
  selectedCount: number
}

export interface RunApiLogRetentionCommandV1 {
  contract: typeof RUN_API_LOG_RETENTION_COMMAND_V1
  dryRun: boolean
}

export interface RunApiLogRetentionResultV1 {
  contract: typeof RUN_API_LOG_RETENTION_RESULT_V1
  selectedCount: number
}

export class EventRetentionCommandValidationError extends Error {
  readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'

  constructor(code: EventRetentionCommandValidationError['code'], message: string) {
    super(message)
    this.name = 'EventRetentionCommandValidationError'
    this.code = code
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function invalid(message: string): never {
  throw new EventRetentionCommandValidationError('INVALID_CONTRACT', message)
}

function parseRetentionCommand(
  input: unknown,
  expectedContract: string,
  contractPrefix: string,
): { contract: string; dryRun: boolean } {
  if (!isRecord(input)) invalid('command must be an object')

  const extra = Object.keys(input).filter(key => !['contract', 'dryRun'].includes(key))
  if (extra.length > 0) invalid(`unsupported field(s): ${extra.sort().join(', ')}`)

  if (input.contract !== expectedContract) {
    if (typeof input.contract === 'string' && input.contract.startsWith(contractPrefix)) {
      throw new EventRetentionCommandValidationError(
        'UNSUPPORTED_CONTRACT_VERSION',
        `unsupported contract version: ${input.contract}`,
      )
    }
    invalid(`contract must equal ${expectedContract}`)
  }

  if (typeof input.dryRun !== 'boolean') invalid('dryRun must be a boolean')
  return input as { contract: string; dryRun: boolean }
}

export function parseRunDriverEventRetentionCommandV1(input: unknown): RunDriverEventRetentionCommandV1 {
  parseRetentionCommand(
    input,
    RUN_DRIVER_EVENT_RETENTION_COMMAND_V1,
    'fleet_operations.RunDriverEventRetentionCommand.',
  )
  return input as RunDriverEventRetentionCommandV1
}

export function parseRunApiLogRetentionCommandV1(input: unknown): RunApiLogRetentionCommandV1 {
  parseRetentionCommand(
    input,
    RUN_API_LOG_RETENTION_COMMAND_V1,
    'fleet_operations.RunApiLogRetentionCommand.',
  )
  return input as RunApiLogRetentionCommandV1
}
