import { prisma } from '@/lib/prisma'
import { getClient, sendMedia, sendMessage } from '@/lib/whatsapp/WhatsAppService'
import {
    registerWhatsAppChannelDeliveryV1,
    type WhatsAppChannelDeliveryV1,
} from '@/modules/messaging/public/v1/channel-delivery-runtime'

async function resolveConnectionId(connectionId?: string): Promise<string> {
    if (connectionId) return connectionId
    const connection = await prisma.whatsAppConnection.findFirst({
        where: { status: 'ready' },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
    })
    if (!connection) throw new Error('No ready WhatsApp connection')
    return connection.id
}

const capability: WhatsAppChannelDeliveryV1 = {
    async sendText(input) {
        const connectionId = await resolveConnectionId(input.connectionId)
        return sendMessage(connectionId, input.chatId, input.content, input.quotedMessageId)
    },
    async sendMedia(input) {
        const connectionId = await resolveConnectionId(input.connectionId)
        return sendMedia(connectionId, input.chatId, input.base64, input.filename, input.mimeType, input.caption, {
            sendAsVoice: input.sendAsVoice,
            sendAsDocument: input.sendAsDocument,
        })
    },
    async sendReaction(input) {
        const connectionId = await resolveConnectionId(input.connectionId)
        const client = getClient(connectionId)
        if (!client) throw new Error(`WhatsApp client not found for connection ${connectionId}`)
        const chat = await client.getChatById(input.chatId)
        const messages = await chat.fetchMessages({ limit: 50 })
        const message = messages.find((candidate: any) => candidate.id._serialized === input.messageId)
        if (!message) throw new Error(`WhatsApp message ${input.messageId} not found in chat ${input.chatId}`)
        await message.react(input.remove ? '' : input.emoji)
    },
}

export function registerWhatsAppMessagingDeliveryCapabilityV1(): void {
    registerWhatsAppChannelDeliveryV1(capability)
}
