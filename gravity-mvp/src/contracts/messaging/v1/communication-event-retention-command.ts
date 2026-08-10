export const RUN_COMMUNICATION_EVENT_RETENTION_COMMAND_V1 = 'messaging.RunCommunicationEventRetentionCommand.v1' as const
export const RUN_COMMUNICATION_EVENT_RETENTION_RESULT_V1 = 'messaging.RunCommunicationEventRetentionResult.v1' as const

export interface RunCommunicationEventRetentionCommandV1 {
  contract: typeof RUN_COMMUNICATION_EVENT_RETENTION_COMMAND_V1
  dryRun: boolean
}

export interface RunCommunicationEventRetentionResultV1 {
  contract: typeof RUN_COMMUNICATION_EVENT_RETENTION_RESULT_V1
  selectedCount: number
}

export class CommunicationEventRetentionCommandValidationError extends Error {
  readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'

  constructor(code: CommunicationEventRetentionCommandValidationError['code'], message: string) {
    super(message)
    this.name = 'CommunicationEventRetentionCommandValidationError'
    this.code = code
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function invalid(message: string): never {
  throw new CommunicationEventRetentionCommandValidationError('INVALID_CONTRACT', message)
}

export function parseRunCommunicationEventRetentionCommandV1(
  input: unknown,
): RunCommunicationEventRetentionCommandV1 {
  if (!isRecord(input)) invalid('command must be an object')

  const extra = Object.keys(input).filter(key => !['contract', 'dryRun'].includes(key))
  if (extra.length > 0) invalid(`unsupported field(s): ${extra.sort().join(', ')}`)

  if (input.contract !== RUN_COMMUNICATION_EVENT_RETENTION_COMMAND_V1) {
    if (
      typeof input.contract === 'string' &&
      input.contract.startsWith('messaging.RunCommunicationEventRetentionCommand.')
    ) {
      throw new CommunicationEventRetentionCommandValidationError(
        'UNSUPPORTED_CONTRACT_VERSION',
        `unsupported contract version: ${input.contract}`,
      )
    }
    invalid(`contract must equal ${RUN_COMMUNICATION_EVENT_RETENTION_COMMAND_V1}`)
  }

  if (typeof input.dryRun !== 'boolean') invalid('dryRun must be a boolean')
  return input as unknown as RunCommunicationEventRetentionCommandV1
}
