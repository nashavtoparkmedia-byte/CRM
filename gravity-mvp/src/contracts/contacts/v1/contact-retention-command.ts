export const DELETE_CONTACT_FOR_RETENTION_COMMAND_V1 = 'contacts.DeleteContactForRetentionCommand.v1' as const
export const DELETE_CONTACT_FOR_RETENTION_RESULT_V1 = 'contacts.DeleteContactForRetentionResult.v1' as const

export interface DeleteContactForRetentionCommandV1 {
  contract: typeof DELETE_CONTACT_FOR_RETENTION_COMMAND_V1
  contactId: string
}

export interface DeleteContactForRetentionResultV1 {
  contract: typeof DELETE_CONTACT_FOR_RETENTION_RESULT_V1
  completed: true
}

export const CONTACT_RETENTION_ELIGIBILITY_CHANGED_V1 = 'CONTACT_RETENTION_ELIGIBILITY_CHANGED' as const

/** The candidate became ineligible after preflight but before admitted deletion. */
export class ContactRetentionEligibilityChangedError extends Error {
  readonly code = CONTACT_RETENTION_ELIGIBILITY_CHANGED_V1

  constructor(message = 'Contact is no longer eligible for retention deletion') {
    super(message)
    this.name = 'ContactRetentionEligibilityChangedError'
  }
}

export class DeleteContactForRetentionCommandValidationError extends Error {
  readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'

  constructor(code: DeleteContactForRetentionCommandValidationError['code'], message: string) {
    super(message)
    this.name = 'DeleteContactForRetentionCommandValidationError'
    this.code = code
  }
}

export function parseDeleteContactForRetentionCommandV1(input: unknown): DeleteContactForRetentionCommandV1 {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new DeleteContactForRetentionCommandValidationError('INVALID_CONTRACT', 'command must be an object')
  }
  const value = input as Record<string, unknown>
  const extra = Object.keys(value).filter(key => !['contract', 'contactId'].includes(key))
  if (extra.length > 0) {
    throw new DeleteContactForRetentionCommandValidationError(
      'INVALID_CONTRACT',
      `unsupported field(s): ${extra.sort().join(', ')}`,
    )
  }
  if (value.contract !== DELETE_CONTACT_FOR_RETENTION_COMMAND_V1) {
    if (typeof value.contract === 'string' && value.contract.startsWith('contacts.DeleteContactForRetentionCommand.')) {
      throw new DeleteContactForRetentionCommandValidationError(
        'UNSUPPORTED_CONTRACT_VERSION',
        `unsupported contract version: ${value.contract}`,
      )
    }
    throw new DeleteContactForRetentionCommandValidationError(
      'INVALID_CONTRACT',
      `contract must equal ${DELETE_CONTACT_FOR_RETENTION_COMMAND_V1}`,
    )
  }
  if (typeof value.contactId !== 'string' || value.contactId.trim().length === 0) {
    throw new DeleteContactForRetentionCommandValidationError('INVALID_CONTRACT', 'contactId must be a non-empty string')
  }
  return value as unknown as DeleteContactForRetentionCommandV1
}
