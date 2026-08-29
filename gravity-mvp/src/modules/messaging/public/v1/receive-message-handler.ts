import {
    RECEIVE_MESSAGE_RESULT_V1,
    parseReceiveMessageCommandV1,
    type ReceiveMessageChannelV1,
    type ReceiveMessageCommandV1,
    type ReceiveMessageResultV1,
} from '../../../../contracts/messaging/v1'

export interface ReceiveMessagePersistencePortV1 {
    receive(input: {
        chatId: string
        content: string
        sentAt: string
        externalId: string
        channel: ReceiveMessageChannelV1
        metadata: Record<string, unknown>
    }): Promise<{ messageId: string; created: boolean }>
}

export function createReceiveMessageHandlerV1(port: ReceiveMessagePersistencePortV1) {
    return async function receiveMessageV1(
        command: ReceiveMessageCommandV1 | unknown,
    ): Promise<ReceiveMessageResultV1> {
        const parsed = parseReceiveMessageCommandV1(command)
        const result = await port.receive({
            chatId: parsed.chatId,
            content: parsed.content,
            sentAt: parsed.sentAt,
            externalId: parsed.externalId,
            channel: parsed.channel,
            metadata: parsed.metadata,
        })
        return { contract: RECEIVE_MESSAGE_RESULT_V1, ...result }
    }
}
