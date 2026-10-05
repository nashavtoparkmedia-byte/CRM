import {
  RESOLVE_CONVERSATION_CONTACT_RESULT_V1,
  parseResolveConversationContactQueryV1,
  type ResolveConversationContactQueryV1,
  type ResolveConversationContactResultV1,
} from '../../../../contracts/messaging/v1'

/** What the persisted conversation itself records about its Contact. */
export interface ConversationContactRecordV1 {
  /** The Contact the conversation is linked to, or null when none is. */
  contactId: string | null
  /** The status of the conversation's last recorded contact resolution, or null when none was recorded. */
  contactResolutionStatus: string | null
}

export interface ResolveConversationContactPortV1 {
  /** The exact persisted conversation, or null when no conversation has this id. Reads only. */
  findConversationContact(chatId: string): Promise<ConversationContactRecordV1 | null>
  /** The canonical Contact for a linked one, as Contacts' merge lineage defines it; null when no such Contact exists. */
  canonicalContactId(contactId: string): Promise<string | null>
}

/**
 * Resolves one persisted conversation (`Chat.id`) to its Contact, read-only.
 *
 * The decision, in order:
 *   1. no conversation with this id               → not_found;
 *   2. its recorded resolution is ambiguous       → ambiguous, whatever link it carries:
 *      the conversation is known to match more than one person;
 *   3. no linked Contact                          → unresolved;
 *   4. the linked Contact, made canonical by Contacts' own merge lineage
 *      (a merged-away Contact answers with its survivor) → resolved;
 *      a link to a Contact that no longer exists      → unresolved.
 * Only the exact conversation is read: other conversations of the same person
 * are never consulted, and nothing is written.
 */
export function createResolveConversationContactHandlerV1(port: ResolveConversationContactPortV1) {
  return async function resolveConversationContactV1(
    query: ResolveConversationContactQueryV1 | unknown,
  ): Promise<ResolveConversationContactResultV1> {
    const parsed = parseResolveConversationContactQueryV1(query)
    const conversation = await port.findConversationContact(parsed.chatId)
    if (!conversation) return { contract: RESOLVE_CONVERSATION_CONTACT_RESULT_V1, status: 'not_found' }
    if (conversation.contactResolutionStatus === 'ambiguous') {
      return { contract: RESOLVE_CONVERSATION_CONTACT_RESULT_V1, status: 'ambiguous' }
    }
    if (!conversation.contactId) return { contract: RESOLVE_CONVERSATION_CONTACT_RESULT_V1, status: 'unresolved' }
    const contactId = await port.canonicalContactId(conversation.contactId)
    return contactId
      ? { contract: RESOLVE_CONVERSATION_CONTACT_RESULT_V1, status: 'resolved', contactId }
      : { contract: RESOLVE_CONVERSATION_CONTACT_RESULT_V1, status: 'unresolved' }
  }
}
