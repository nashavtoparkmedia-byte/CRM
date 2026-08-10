import {
  DETACH_CONTACT_CONVERSATIONS_RESULT_V1,
  parseDetachContactConversationsCommandV1,
  type DetachContactConversationsCommandV1,
  type DetachContactConversationsResultV1,
} from '../../../../contracts/messaging/v1'

export interface ContactConversationRetentionPersistencePortV1 {
  detachContactConversations(contactId: string): Promise<void>
}

export function createDetachContactConversationsHandlerV1(
  port: ContactConversationRetentionPersistencePortV1,
) {
  return async function detachContactConversationsV1(
    command: DetachContactConversationsCommandV1 | unknown,
  ): Promise<DetachContactConversationsResultV1> {
    const parsed = parseDetachContactConversationsCommandV1(command)
    await port.detachContactConversations(parsed.contactId)
    return {
      contract: DETACH_CONTACT_CONVERSATIONS_RESULT_V1,
      completed: true,
    }
  }
}
