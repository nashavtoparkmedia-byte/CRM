import { Api } from 'telegram'

import { prisma } from '@/lib/prisma'
import { getClientForReaction, sendTelegramMedia, sendTelegramMessage } from '@/app/tg-actions'
import {
    registerTelegramChannelDeliveryV1,
    type TelegramChannelDeliveryV1,
} from '@/modules/messaging/public/v1/channel-delivery-runtime'

async function resolveConnectionId(connectionId?: string): Promise<string> {
    if (connectionId) return connectionId
    const connection = await prisma.telegramConnection.findFirst({
        where: { isActive: true },
        orderBy: { isDefault: 'desc' },
        select: { id: true },
    })
    if (!connection) throw new Error('No active Telegram connection')
    return connection.id
}

const capability: TelegramChannelDeliveryV1 = {
    async sendText(input) {
        return sendTelegramMessage(input.target, input.content, input.connectionId, input.metadata)
    },
    async sendMedia(input) {
        return sendTelegramMedia(input.target, input.base64, input.filename, input.mimeType, input.caption, input.connectionId)
    },
    async sendReaction(input) {
        const connectionId = await resolveConnectionId(input.connectionId)
        const client = await getClientForReaction(connectionId)
        if (!client) throw new Error(`Telegram client not found for connection ${connectionId}`)
        const peer = Number.parseInt(input.chatId.replace('telegram:', ''), 10)
        if (Number.isNaN(peer)) throw new Error(`Invalid Telegram peer ID: ${input.chatId}`)
        const messageId = Number.parseInt(input.messageId, 10)
        if (Number.isNaN(messageId)) throw new Error(`Invalid Telegram message ID: ${input.messageId}`)
        await client.invoke(new Api.messages.SendReaction({
            peer,
            msgId: messageId,
            reaction: input.remove ? [] : [new Api.ReactionEmoji({ emoticon: input.emoji })],
        }))
    },
}

export function registerTelegramMessagingDeliveryCapabilityV1(): void {
    registerTelegramChannelDeliveryV1(capability)
}
