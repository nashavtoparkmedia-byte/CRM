// CC-1 Contact Card read model (Contact Identity).
//
// One Contacts-owned, read-only query: the card a verified CRM principal may see
// for one persisted conversation, addressed only by its exact Chat.id. Which
// Contact a conversation belongs to is answered by Messaging's
// ResolveConversationContactQuery.v1 (RCQ1) at the composition site; this
// contract never accepts a Contact id, a phone, a name, a username or a provider
// id, so no caller can steer it to another person.

export const CONTACT_CARD_FOR_CONVERSATION_QUERY_V1 = 'contacts.ContactCardForConversationQuery.v1' as const
export const CONTACT_CARD_FOR_CONVERSATION_RESULT_V1 = 'contacts.ContactCardForConversationResult.v1' as const

export type ContactCardForConversationQueryV1 = {
  contract: typeof CONTACT_CARD_FOR_CONVERSATION_QUERY_V1
  /** The exact persisted Chat.id. It is never trimmed, normalized or matched loosely. */
  chatId: string
}

/** One channel of the Contact, counted. No provider id, account, transport or conversation crosses it. */
export type ContactCardChannelV1 = {
  channel: string
  identityCount: number
  hasActiveIdentity: boolean
  /** An open conflict is recorded for one of this channel's identities (journal or identity latch). */
  hasOpenIdentityConflict: boolean
}

/** The minimum the first Contact card shows. Everything else stays out of the contract. */
export type ContactCardV1 = {
  /** The canonical Contact this conversation belongs to. */
  contactId: string
  /** ContactDisplayPolicy's name; a confirmed person name only when Contacts-owned evidence proves it. */
  displayName: string
  primaryPhone: string | null
  phoneCount: number
  channels: ContactCardChannelV1[]
  /** Any open identity conflict recorded for this Contact, in either Contacts conflict store. */
  hasOpenIdentityConflict: boolean
  mergedFromCount: number
}

/**
 * confirmed  — the conversation belongs to exactly this Contact, held stable for the whole read;
 * unresolved — the conversation is linked to no Contact;
 * conflict   — the conversation's recorded resolution matched more than one person;
 * refused    — the association could not be held stable for the read, or a source answer was not exact;
 * missing    — no conversation has this id, or its Contact is gone or archived;
 * forbidden  — no verified server-side principal, or it may not read this conversation or this Contact.
 * Only `confirmed` carries data. No other answer names a Contact, another conversation or a reason.
 */
export type ContactCardForConversationStatusV1 =
  | 'confirmed'
  | 'unresolved'
  | 'conflict'
  | 'refused'
  | 'missing'
  | 'forbidden'

export type ContactCardForConversationResultV1 =
  | { contract: typeof CONTACT_CARD_FOR_CONVERSATION_RESULT_V1; status: 'confirmed'; card: ContactCardV1 }
  | { contract: typeof CONTACT_CARD_FOR_CONVERSATION_RESULT_V1; status: Exclude<ContactCardForConversationStatusV1, 'confirmed'> }

export class ContactCardForConversationValidationError extends Error {
  readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'

  constructor(code: ContactCardForConversationValidationError['code'], message: string) {
    super(message)
    this.name = 'ContactCardForConversationValidationError'
    this.code = code
  }
}

function invalid(message: string): never {
  throw new ContactCardForConversationValidationError('INVALID_CONTRACT', message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseContactCardForConversationQueryV1(input: unknown): ContactCardForConversationQueryV1 {
  if (!isRecord(input)) invalid('query must be an object')
  const extraFields = Object.keys(input).filter(key => key !== 'contract' && key !== 'chatId')
  if (extraFields.length > 0) invalid(`unsupported field(s): ${extraFields.sort().join(', ')}`)
  if (input.contract !== CONTACT_CARD_FOR_CONVERSATION_QUERY_V1) {
    if (typeof input.contract === 'string' && input.contract.startsWith('contacts.ContactCardForConversationQuery.')) {
      throw new ContactCardForConversationValidationError(
        'UNSUPPORTED_CONTRACT_VERSION',
        `unsupported contract version: ${input.contract}`,
      )
    }
    invalid(`contract must equal ${CONTACT_CARD_FOR_CONVERSATION_QUERY_V1}`)
  }
  if (typeof input.chatId !== 'string' || input.chatId === '' || input.chatId.trim() !== input.chatId) {
    invalid('chatId must be an exact, non-empty Chat.id')
  }
  return { contract: CONTACT_CARD_FOR_CONVERSATION_QUERY_V1, chatId: input.chatId }
}
