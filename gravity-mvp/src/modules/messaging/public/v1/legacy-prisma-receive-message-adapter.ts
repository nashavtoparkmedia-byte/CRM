import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import type { ReceiveMessagePersistencePortV1 } from './receive-message-handler'

export const legacyPrismaReceiveMessagePortV1: ReceiveMessagePersistencePortV1 = {
    async receive(input) {
        const existing = await prisma.message.findUnique({
            where: { externalId: input.externalId },
            select: { id: true },
        })
        if (existing) return { messageId: existing.id, created: false }

        const message = await prisma.message.create({
            data: {
                chatId: input.chatId,
                direction: 'inbound',
                type: 'text',
                content: input.content,
                status: 'delivered',
                sentAt: new Date(input.sentAt),
                externalId: input.externalId,
                channel: input.channel,
                metadata: input.metadata as Prisma.InputJsonValue,
            },
            select: { id: true },
        })
        return { messageId: message.id, created: true }
    },
}
