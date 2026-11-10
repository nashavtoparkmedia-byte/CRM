/**
 * Messaging read-only audit of stored Telegram conversation bindings (R-22).
 *
 * Counts, for one page of private Telegram conversations that carry a contact
 * binding, how many are consistent, unverifiable or contradicted by Messaging's
 * own facts, and what Contacts' `contacts.ResolveInboundConversationPeerIdentityQuery.v1`
 * says about the conversation's peer. It writes nothing, links nothing and
 * resolves no person: it is the read-only count that tells whether stored
 * conversations still merge different people.
 */
export const CONVERSATION_BINDING_AUDIT_QUERY_V1 = 'messaging.ConversationBindingAuditQuery.v1' as const
export const CONVERSATION_BINDING_AUDIT_RESULT_V1 = 'messaging.ConversationBindingAuditResult.v1' as const

export interface ConversationBindingAuditQueryV1 {
  contract: typeof CONVERSATION_BINDING_AUDIT_QUERY_V1
  /** Conversations in this page (1..500, default 200), by ascending `Chat.id`. */
  limit?: number
  /** Continue after this `Chat.id`; omitted, from the start. */
  afterChatId?: string
}

export type ConversationBindingAuditStateV1 = 'consistent' | 'unverifiable' | 'contradicted'
export type ConversationBindingAuditPeerStatusV1 =
  | 'ready'
  | 'contact_not_found'
  | 'peer_identity_not_found'
  | 'peer_identity_conflicted'
  | 'linked_identity_not_found'
  /** No numeric peer key or no linked identity, so Contacts was not asked. */
  | 'not_asked'

export const CONVERSATION_BINDING_AUDIT_SAMPLE_LIMIT_V1 = 50

/** Counts and conversation ids only: no content, name, phone or provider identifier crosses it. */
export interface ConversationBindingAuditResultV1 {
  contract: typeof CONVERSATION_BINDING_AUDIT_RESULT_V1
  checked: number
  states: Record<ConversationBindingAuditStateV1, number>
  peer: Record<ConversationBindingAuditPeerStatusV1, number>
  /** Conversations Messaging's own facts contradict, at most 50. */
  contradictedChatIds: string[]
  /** Conversations whose peer Contacts does not place under the bound contact, at most 50. */
  peerNotOfContactChatIds: string[]
  /** The last `Chat.id` of this page when more may follow; null at the end. */
  nextAfterChatId: string | null
}

export class ConversationBindingAuditQueryValidationError extends Error {
  readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'

  constructor(code: ConversationBindingAuditQueryValidationError['code'], message: string) {
    super(message)
    this.name = 'ConversationBindingAuditQueryValidationError'
    this.code = code
  }
}

const MAX_LIMIT = 500

function invalid(message: string): never {
  throw new ConversationBindingAuditQueryValidationError('INVALID_CONTRACT', message)
}

export function parseConversationBindingAuditQueryV1(input: unknown): ConversationBindingAuditQueryV1 {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) invalid('query must be an object')
  const value = input as Record<string, unknown>
  const extra = Object.keys(value).filter(key => !['contract', 'limit', 'afterChatId'].includes(key))
  if (extra.length > 0) invalid(`unsupported field(s): ${extra.sort().join(', ')}`)
  if (value.contract !== CONVERSATION_BINDING_AUDIT_QUERY_V1) {
    if (typeof value.contract === 'string' && value.contract.startsWith('messaging.ConversationBindingAuditQuery.')) {
      throw new ConversationBindingAuditQueryValidationError('UNSUPPORTED_CONTRACT_VERSION', `unsupported contract version: ${value.contract}`)
    }
    invalid(`contract must equal ${CONVERSATION_BINDING_AUDIT_QUERY_V1}`)
  }
  if (value.limit !== undefined && (typeof value.limit !== 'number' || !Number.isInteger(value.limit) || value.limit < 1 || value.limit > MAX_LIMIT)) {
    invalid(`limit must be an integer from 1 to ${MAX_LIMIT}`)
  }
  if (value.afterChatId !== undefined && (typeof value.afterChatId !== 'string' || value.afterChatId.trim() === '' || value.afterChatId !== value.afterChatId.trim())) {
    invalid('afterChatId must be a non-empty id')
  }
  return {
    contract: CONVERSATION_BINDING_AUDIT_QUERY_V1,
    ...(value.limit !== undefined ? { limit: value.limit as number } : {}),
    ...(value.afterChatId !== undefined ? { afterChatId: value.afterChatId as string } : {}),
  }
}
