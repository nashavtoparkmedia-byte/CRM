export const ENSURE_CONVERSATION_CONTACT_LINK_COMMAND_V1 = 'messaging.EnsureConversationContactLinkCommand.v1' as const
export const ENSURE_CONVERSATION_CONTACT_LINK_RESULT_V1 = 'messaging.EnsureConversationContactLinkResult.v1' as const

export interface EnsureConversationContactLinkCommandV1 {
  contract: typeof ENSURE_CONVERSATION_CONTACT_LINK_COMMAND_V1
  chatId: string
  contactId: string
  contactIdentityId: string
}

export interface EnsureConversationContactLinkResultV1 {
  contract: typeof ENSURE_CONVERSATION_CONTACT_LINK_RESULT_V1
  completed: true
}

export class ConversationContactLinkCommandValidationError extends Error {
  readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'

  constructor(
    code: ConversationContactLinkCommandValidationError['code'],
    message: string,
  ) {
    super(message)
    this.name = 'ConversationContactLinkCommandValidationError'
    this.code = code
  }
}

function invalid(message: string): never {
  throw new ConversationContactLinkCommandValidationError('INVALID_CONTRACT', message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseEnsureConversationContactLinkCommandV1(
  input: unknown,
): EnsureConversationContactLinkCommandV1 {
  if (!isRecord(input)) invalid('command must be an object')

  const supportedFields = ['contract', 'chatId', 'contactId', 'contactIdentityId']
  const extraFields = Object.keys(input).filter((key) => !supportedFields.includes(key))
  if (extraFields.length > 0) {
    invalid(`unsupported field(s): ${extraFields.sort().join(', ')}`)
  }

  if (input.contract !== ENSURE_CONVERSATION_CONTACT_LINK_COMMAND_V1) {
    if (
      typeof input.contract === 'string'
      && input.contract.startsWith('messaging.EnsureConversationContactLinkCommand.')
    ) {
      throw new ConversationContactLinkCommandValidationError(
        'UNSUPPORTED_CONTRACT_VERSION',
        `unsupported contract version: ${input.contract}`,
      )
    }
    invalid(`contract must equal ${ENSURE_CONVERSATION_CONTACT_LINK_COMMAND_V1}`)
  }

  for (const field of ['chatId', 'contactId', 'contactIdentityId'] as const) {
    if (typeof input[field] !== 'string' || input[field].trim() === '') {
      invalid(`${field} is required`)
    }
  }

  return input as unknown as EnsureConversationContactLinkCommandV1
}
