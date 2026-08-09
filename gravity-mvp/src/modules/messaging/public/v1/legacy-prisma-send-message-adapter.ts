import { prisma } from '@/lib/prisma'
import type { SendMessagePersistencePortV1 } from './send-message-handler'

export const legacyPrismaSendMessagePortV1: SendMessagePersistencePortV1 = {
    async appendSystemNotification(input) {
        const message = await prisma.message.create({
            data: {
                chatId: input.chatId,
                direction: 'system',
                type: 'system',
                channel: input.channel,
                content: input.content,
                status: 'sent',
                externalId: input.externalId,
                sentAt: new Date(input.sentAt),
            },
            select: { id: true },
        })
        return { messageId: message.id }
    },
}
