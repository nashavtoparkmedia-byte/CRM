import {
  FIND_AND_BACKFILL_CONTACT_CONVERSATION_RESULT_V1,
  OPEN_FALLBACK_CONTACT_CONVERSATION_RESULT_V1,
  parseFindAndBackfillContactConversationCommandV1,
  parseOpenFallbackContactConversationCommandV1,
  type ContactConversationV1,
  type FindAndBackfillContactConversationCommandV1,
  type FindAndBackfillContactConversationResultV1,
  type OpenFallbackContactConversationCommandV1,
  type OpenFallbackContactConversationResultV1,
} from '../../../../contracts/messaging/v1'

export interface ContactConversationPersistencePortV1 {
  findAndBackfill(
    input: Omit<FindAndBackfillContactConversationCommandV1, 'contract'>,
  ): Promise<ContactConversationV1 | null>
  openFallback(
    input: Omit<OpenFallbackContactConversationCommandV1, 'contract'>,
  ): Promise<{ conversation: ContactConversationV1; isNew: boolean }>
}

export function createFindAndBackfillContactConversationHandlerV1(
  port: ContactConversationPersistencePortV1,
) {
  return async function findAndBackfillContactConversationV1(
    command: FindAndBackfillContactConversationCommandV1 | unknown,
  ): Promise<FindAndBackfillContactConversationResultV1> {
    const parsed = parseFindAndBackfillContactConversationCommandV1(command)
    const conversation = await port.findAndBackfill({
      contactId: parsed.contactId,
      contactIdentityId: parsed.contactIdentityId,
      channel: parsed.channel,
    })
    return {
      contract: FIND_AND_BACKFILL_CONTACT_CONVERSATION_RESULT_V1,
      conversation,
    }
  }
}

export function createOpenFallbackContactConversationHandlerV1(
  port: ContactConversationPersistencePortV1,
) {
  return async function openFallbackContactConversationV1(
    command: OpenFallbackContactConversationCommandV1 | unknown,
  ): Promise<OpenFallbackContactConversationResultV1> {
    const parsed = parseOpenFallbackContactConversationCommandV1(command)
    const result = await port.openFallback({
      legacyDriverId: parsed.legacyDriverId,
      channel: parsed.channel,
      externalChatId: parsed.externalChatId,
      name: parsed.name,
      contactId: parsed.contactId,
      contactIdentityId: parsed.contactIdentityId,
    })
    return {
      contract: OPEN_FALLBACK_CONTACT_CONVERSATION_RESULT_V1,
      conversation: result.conversation,
      isNew: result.isNew,
    }
  }
}
