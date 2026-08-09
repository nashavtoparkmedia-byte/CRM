import {
    UPDATE_CONVERSATION_RESULT_V1,
    parseUpdateConversationCommandV1,
    type UpdateConversationCommandV1,
    type UpdateConversationResultV1,
} from '../../../../contracts/messaging/v1'

export interface UpdateConversationPersistencePortV1 {
    markRequiresResponse(input: {
        chatId: string
        lastMessageAt: string
    }): Promise<{ chatId: string }>
}

export function createUpdateConversationHandlerV1(port: UpdateConversationPersistencePortV1) {
    return async function updateConversationV1(
        command: UpdateConversationCommandV1 | unknown,
    ): Promise<UpdateConversationResultV1> {
        const parsed = parseUpdateConversationCommandV1(command)
        const result = await port.markRequiresResponse({
            chatId: parsed.chatId,
            lastMessageAt: parsed.lastMessageAt,
        })
        return { contract: UPDATE_CONVERSATION_RESULT_V1, chatId: result.chatId }
    }
}
