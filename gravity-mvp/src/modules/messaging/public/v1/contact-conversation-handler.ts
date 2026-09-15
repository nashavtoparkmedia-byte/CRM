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
  ): Promise<
    | { status: 'ready'; conversation: ContactConversationV1; isNew: boolean }
    | {
        status: 'provider_account_unproven' | 'transport_unbound' | 'conversation_target_unproven'
      }
  >
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
      identityExternalId: parsed.identityExternalId,
      exactExternalChatIds: parsed.exactExternalChatIds,
      providerAccountId: parsed.providerAccountId,
      allowContactFallback: parsed.allowContactFallback,
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
      identityExternalId: parsed.identityExternalId,
      exactExternalChatIds: parsed.exactExternalChatIds,
      name: parsed.name,
      contactId: parsed.contactId,
      contactIdentityId: parsed.contactIdentityId,
      providerAccountId: parsed.providerAccountId,
    })
    if (result.status !== 'ready') {
      return {
        contract: OPEN_FALLBACK_CONTACT_CONVERSATION_RESULT_V1,
        status: result.status,
      }
    }
    return {
      contract: OPEN_FALLBACK_CONTACT_CONVERSATION_RESULT_V1,
      status: 'ready',
      conversation: result.conversation,
      isNew: result.isNew,
    }
  }
}
