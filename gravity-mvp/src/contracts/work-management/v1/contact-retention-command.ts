export const DETACH_CONTACT_TASKS_COMMAND_V1 = 'work_management.DetachContactTasksCommand.v1' as const
export const DETACH_CONTACT_TASKS_RESULT_V1 = 'work_management.DetachContactTasksResult.v1' as const

export interface DetachContactTasksCommandV1 {
  contract: typeof DETACH_CONTACT_TASKS_COMMAND_V1
  contactId: string
}

export interface DetachContactTasksResultV1 {
  contract: typeof DETACH_CONTACT_TASKS_RESULT_V1
  completed: true
}

export class DetachContactTasksCommandValidationError extends Error {
  readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'

  constructor(code: DetachContactTasksCommandValidationError['code'], message: string) {
    super(message)
    this.name = 'DetachContactTasksCommandValidationError'
    this.code = code
  }
}

export function parseDetachContactTasksCommandV1(input: unknown): DetachContactTasksCommandV1 {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new DetachContactTasksCommandValidationError('INVALID_CONTRACT', 'command must be an object')
  }
  const value = input as Record<string, unknown>
  const extra = Object.keys(value).filter(key => !['contract', 'contactId'].includes(key))
  if (extra.length > 0) {
    throw new DetachContactTasksCommandValidationError(
      'INVALID_CONTRACT',
      `unsupported field(s): ${extra.sort().join(', ')}`,
    )
  }
  if (value.contract !== DETACH_CONTACT_TASKS_COMMAND_V1) {
    if (typeof value.contract === 'string' && value.contract.startsWith('work_management.DetachContactTasksCommand.')) {
      throw new DetachContactTasksCommandValidationError(
        'UNSUPPORTED_CONTRACT_VERSION',
        `unsupported contract version: ${value.contract}`,
      )
    }
    throw new DetachContactTasksCommandValidationError(
      'INVALID_CONTRACT',
      `contract must equal ${DETACH_CONTACT_TASKS_COMMAND_V1}`,
    )
  }
  if (typeof value.contactId !== 'string' || value.contactId.trim().length === 0) {
    throw new DetachContactTasksCommandValidationError('INVALID_CONTRACT', 'contactId must be a non-empty string')
  }
  return value as unknown as DetachContactTasksCommandV1
}
