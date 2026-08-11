import {
    LINK_MATCHED_DRIVER_TO_CONVERSATION_RESULT_V1,
    parseLinkMatchedDriverToConversationCommandV1,
    type LinkMatchedDriverToConversationCommandV1,
    type LinkMatchedDriverToConversationResultV1,
} from '../../../../contracts/messaging/v1'

export interface MatchedDriverConversationLinkPersistencePortV1 {
    linkMatchedDriverToConversation(input: Omit<LinkMatchedDriverToConversationCommandV1, 'contract'>): Promise<boolean>
}

export function createLinkMatchedDriverToConversationHandlerV1(
    port: MatchedDriverConversationLinkPersistencePortV1,
) {
    return async function linkMatchedDriverToConversationV1(
        command: LinkMatchedDriverToConversationCommandV1 | unknown,
    ): Promise<LinkMatchedDriverToConversationResultV1> {
        const parsed = parseLinkMatchedDriverToConversationCommandV1(command)
        const linked = await port.linkMatchedDriverToConversation({
            chatId: parsed.chatId,
            driverId: parsed.driverId,
        })
        return { contract: LINK_MATCHED_DRIVER_TO_CONVERSATION_RESULT_V1, linked }
    }
}
