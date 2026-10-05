export const RESOLVE_CONVERSATION_CONTACT_QUERY_V1 = 'messaging.ResolveConversationContactQuery.v1' as const
export const RESOLVE_CONVERSATION_CONTACT_RESULT_V1 = 'messaging.ResolveConversationContactResult.v1' as const

/** Which Contact one persisted conversation belongs to, by its exact `Chat.id`. Read-only. */
export interface ResolveConversationContactQueryV1 {
  contract: typeof RESOLVE_CONVERSATION_CONTACT_QUERY_V1
  chatId: string
}

/**
 * The provider-neutral answer for one conversation:
 *   resolved   — the conversation belongs to this Contact, the canonical one
 *                after Contacts' merge lineage;
 *   unresolved — the conversation exists but no Contact is linked to it;
 *   ambiguous  — the conversation's recorded contact resolution found more than
 *                one candidate person, so no Contact may be assumed;
 *   not_found  — no conversation has this id.
 * No provider, account, transport, route or runtime detail crosses this contract.
 */
export type ResolveConversationContactResultV1 =
  | { contract: typeof RESOLVE_CONVERSATION_CONTACT_RESULT_V1; status: 'resolved'; contactId: string }
  | { contract: typeof RESOLVE_CONVERSATION_CONTACT_RESULT_V1; status: 'unresolved' }
  | { contract: typeof RESOLVE_CONVERSATION_CONTACT_RESULT_V1; status: 'ambiguous' }
  | { contract: typeof RESOLVE_CONVERSATION_CONTACT_RESULT_V1; status: 'not_found' }

export class ResolveConversationContactQueryValidationError extends Error {
  readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'

  constructor(
    code: ResolveConversationContactQueryValidationError['code'],
    message: string,
  ) {
    super(message)
    this.name = 'ResolveConversationContactQueryValidationError'
    this.code = code
  }
}

function invalid(message: string): never {
  throw new ResolveConversationContactQueryValidationError('INVALID_CONTRACT', message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseResolveConversationContactQueryV1(
  input: unknown,
): ResolveConversationContactQueryV1 {
  if (!isRecord(input)) invalid('query must be an object')

  const supportedFields = ['contract', 'chatId']
  const extraFields = Object.keys(input).filter((key) => !supportedFields.includes(key))
  if (extraFields.length > 0) {
    invalid(`unsupported field(s): ${extraFields.sort().join(', ')}`)
  }

  if (input.contract !== RESOLVE_CONVERSATION_CONTACT_QUERY_V1) {
    if (
      typeof input.contract === 'string'
      && input.contract.startsWith('messaging.ResolveConversationContactQuery.')
    ) {
      throw new ResolveConversationContactQueryValidationError(
        'UNSUPPORTED_CONTRACT_VERSION',
        `unsupported contract version: ${input.contract}`,
      )
    }
    invalid(`contract must equal ${RESOLVE_CONVERSATION_CONTACT_QUERY_V1}`)
  }

  if (typeof input.chatId !== 'string' || input.chatId.trim() === '') {
    invalid('chatId is required')
  }

  return { contract: RESOLVE_CONVERSATION_CONTACT_QUERY_V1, chatId: input.chatId }
}
