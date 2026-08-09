import {
    SEND_MESSAGE_RESULT_V1,
    parseSendMessageCommandV1,
    type SendMessageChannelV1,
    type SendMessageCommandV1,
    type SendMessageResultV1,
} from '../../../../contracts/messaging/v1'

export interface SendMessagePersistencePortV1 {
    appendSystemNotification(input: {
        chatId: string
        content: string
        sentAt: string
        externalId: string
        channel: SendMessageChannelV1
    }): Promise<{ messageId: string }>
}

export function createSendMessageHandlerV1(port: SendMessagePersistencePortV1) {
    return async function sendMessageV1(
        command: SendMessageCommandV1 | unknown,
    ): Promise<SendMessageResultV1> {
        const parsed = parseSendMessageCommandV1(command)
        const result = await port.appendSystemNotification({
            chatId: parsed.chatId,
            content: parsed.content,
            sentAt: parsed.sentAt,
            externalId: parsed.externalId,
            channel: parsed.channel,
        })
        return { contract: SEND_MESSAGE_RESULT_V1, messageId: result.messageId }
    }
}
