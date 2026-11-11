import {
  CONVERSATION_BINDING_AUDIT_RESULT_V1,
  CONVERSATION_BINDING_AUDIT_SAMPLE_LIMIT_V1,
  parseConversationBindingAuditQueryV1,
  type ConversationBindingAuditPeerStatusV1,
  type ConversationBindingAuditQueryV1,
  type ConversationBindingAuditResultV1,
} from '../../../../contracts/messaging/v1'
import {
  conversationPersonBindingStateV1,
  telegramConversationPeerV1,
  type ConversationBindingFactsV1,
} from './conversation-binding-trust-policy'

export interface AuditedConversationV1 extends ConversationBindingFactsV1 {
  id: string
}

export interface ConversationBindingAuditPortV1 {
  /** Private Telegram conversations with a contact binding, by ascending id, after `afterChatId`. */
  listBoundTelegramConversations(input: { afterChatId: string | null; limit: number }): Promise<AuditedConversationV1[]>
  /** Contacts' answer for the conversation's peer under its bound contact. Read-only. */
  resolvePeer(input: { contactId: string; peerExternalId: string; linkedIdentityId: string }): Promise<Exclude<ConversationBindingAuditPeerStatusV1, 'not_asked'>>
}

const DEFAULT_LIMIT = 200

export function createConversationBindingAuditHandlerV1(port: ConversationBindingAuditPortV1) {
  return async function auditConversationBindingsV1(
    query: ConversationBindingAuditQueryV1 | unknown,
  ): Promise<ConversationBindingAuditResultV1> {
    const parsed = parseConversationBindingAuditQueryV1(query)
    const limit = parsed.limit ?? DEFAULT_LIMIT
    const page = await port.listBoundTelegramConversations({ afterChatId: parsed.afterChatId ?? null, limit })
    const result: ConversationBindingAuditResultV1 = {
      contract: CONVERSATION_BINDING_AUDIT_RESULT_V1,
      checked: 0,
      states: { consistent: 0, unverifiable: 0, contradicted: 0 },
      peer: { ready: 0, contact_not_found: 0, peer_identity_not_found: 0, peer_identity_conflicted: 0, linked_identity_not_found: 0, not_asked: 0 },
      contradictedChatIds: [],
      peerNotOfContactChatIds: [],
      nextAfterChatId: page.length === limit ? page[page.length - 1].id : null,
    }
    for (const conversation of page) {
      const state = conversationPersonBindingStateV1(conversation)
      // The port lists bound conversations only; an unbound row is a port defect.
      if (state === 'unbound') throw new Error('CONVERSATION_BINDING_AUDIT_UNBOUND_ROW')
      result.checked += 1
      result.states[state] += 1
      if (state === 'contradicted' && result.contradictedChatIds.length < CONVERSATION_BINDING_AUDIT_SAMPLE_LIMIT_V1) {
        result.contradictedChatIds.push(conversation.id)
      }
      const peerExternalId = telegramConversationPeerV1(conversation)
      if (peerExternalId === null || conversation.contactId === null || conversation.contactIdentityId === null) {
        result.peer.not_asked += 1
        continue
      }
      const peer = await port.resolvePeer({ contactId: conversation.contactId, peerExternalId, linkedIdentityId: conversation.contactIdentityId })
      result.peer[peer] += 1
      if ((peer === 'peer_identity_not_found' || peer === 'linked_identity_not_found' || peer === 'contact_not_found')
        && result.peerNotOfContactChatIds.length < CONVERSATION_BINDING_AUDIT_SAMPLE_LIMIT_V1) {
        result.peerNotOfContactChatIds.push(conversation.id)
      }
    }
    return result
  }
}
