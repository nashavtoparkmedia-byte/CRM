export const DETACH_CONTACT_CONVERSATIONS_COMMAND_V1 = 'messaging.DetachContactConversationsCommand.v1' as const
export const DETACH_CONTACT_CONVERSATIONS_RESULT_V1 = 'messaging.DetachContactConversationsResult.v1' as const

export interface DetachContactConversationsCommandV1 {
  contract: typeof DETACH_CONTACT_CONVERSATIONS_COMMAND_V1
  contactId: string
}

export interface DetachContactConversationsResultV1 {
  contract: typeof DETACH_CONTACT_CONVERSATIONS_RESULT_V1
  completed: true
}

export class DetachContactConversationsCommandValidationError extends Error {
  readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'

  constructor(code: DetachContactConversationsCommandValidationError['code'], message: string) {
    super(message)
    this.name = 'DetachContactConversationsCommandValidationError'
    this.code = code
  }
}

export function parseDetachContactConversationsCommandV1(input: unknown): DetachContactConversationsCommandV1 {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new DetachContactConversationsCommandValidationError('INVALID_CONTRACT', 'command must be an object')
  }
  const value = input as Record<string, unknown>
  const extra = Object.keys(value).filter(key => !['contract', 'contactId'].includes(key))
  if (extra.length > 0) {
    throw new DetachContactConversationsCommandValidationError(
      'INVALID_CONTRACT',
      `unsupported field(s): ${extra.sort().join(', ')}`,
    )
  }
  if (value.contract !== DETACH_CONTACT_CONVERSATIONS_COMMAND_V1) {
    if (
      typeof value.contract === 'string' &&
      value.contract.startsWith('messaging.DetachContactConversationsCommand.')
    ) {
      throw new DetachContactConversationsCommandValidationError(
        'UNSUPPORTED_CONTRACT_VERSION',
        `unsupported contract version: ${value.contract}`,
      )
    }
    throw new DetachContactConversationsCommandValidationError(
      'INVALID_CONTRACT',
      `contract must equal ${DETACH_CONTACT_CONVERSATIONS_COMMAND_V1}`,
    )
  }
  if (typeof value.contactId !== 'string' || value.contactId.trim().length === 0) {
    throw new DetachContactConversationsCommandValidationError('INVALID_CONTRACT', 'contactId must be a non-empty string')
  }
  return value as unknown as DetachContactConversationsCommandV1
}
