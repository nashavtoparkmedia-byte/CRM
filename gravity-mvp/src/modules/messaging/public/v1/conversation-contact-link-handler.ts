import {
  ENSURE_CONVERSATION_CONTACT_LINK_RESULT_V1,
  parseEnsureConversationContactLinkCommandV1,
  type EnsureConversationContactLinkCommandV1,
  type EnsureConversationContactLinkResultV1,
} from '../../../../contracts/messaging/v1'

export interface ConversationContactLinkPersistencePortV1 {
  ensure(input: Omit<EnsureConversationContactLinkCommandV1, 'contract'>): Promise<void>
}

export function createEnsureConversationContactLinkHandlerV1(
  port: ConversationContactLinkPersistencePortV1,
) {
  return async function ensureConversationContactLinkV1(
    command: EnsureConversationContactLinkCommandV1 | unknown,
  ): Promise<EnsureConversationContactLinkResultV1> {
    const parsed = parseEnsureConversationContactLinkCommandV1(command)
    await port.ensure({
      chatId: parsed.chatId,
      contactId: parsed.contactId,
      contactIdentityId: parsed.contactIdentityId,
    })
    return {
      contract: ENSURE_CONVERSATION_CONTACT_LINK_RESULT_V1,
      completed: true,
    }
  }
}
