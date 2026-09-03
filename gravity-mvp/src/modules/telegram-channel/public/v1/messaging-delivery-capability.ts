import { sendTelegramMedia, sendTelegramMessage, sendTelegramReaction } from '@/app/tg-actions'
import {
    registerTelegramChannelDeliveryV1,
    type TelegramChannelDeliveryV1,
} from '@/modules/messaging/public/v1/channel-delivery-runtime'

const capability: TelegramChannelDeliveryV1 = {
    async sendText(input) {
        return sendTelegramMessage(input.target, input.content, input.connectionId, input.metadata)
    },
    async sendMedia(input) {
        return sendTelegramMedia(
            input.target,
            input.base64,
            input.filename,
            input.mimeType,
            input.caption,
            input.connectionId,
            {
                chatId: input.internalChatId,
                providerAccountId: input.providerAccountId,
                identityTarget: input.identityTarget,
            },
        )
    },
    async sendReaction(input) {
        await sendTelegramReaction({
            target: input.chatId,
            messageId: input.messageId,
            emoji: input.emoji,
            remove: input.remove,
            connectionId: input.connectionId,
            proof: {
                chatId: input.internalChatId,
                providerAccountId: input.providerAccountId,
                identityTarget: input.identityTarget,
            },
        })
    },
}

export function registerTelegramMessagingDeliveryCapabilityV1(): void {
    registerTelegramChannelDeliveryV1(capability)
}
