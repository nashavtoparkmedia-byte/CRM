import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import type { ReceiveMessagePersistencePortV1 } from './receive-message-handler'
import {
    inboundNotificationOutboxRowV1,
    persistsWithNotificationIntentV1,
} from '../../internal/mobile-push/inbound-notification-intent'

export const legacyPrismaReceiveMessagePortV1: ReceiveMessagePersistencePortV1 = {
    async receive(input) {
        const existing = await prisma.message.findUnique({
            where: { externalId: input.externalId },
            select: { id: true },
        })
        if (existing) return { messageId: existing.id, created: false }

        const data = {
            chatId: input.chatId,
            direction: 'inbound' as const,
            type: 'text' as const,
            content: input.content,
            status: 'delivered' as const,
            sentAt: new Date(input.sentAt),
            externalId: input.externalId,
            channel: input.channel,
            metadata: input.metadata as Prisma.InputJsonValue,
        }

        // Mobile Push v1: a qualifying inbound message and its notification
        // intent commit in ONE transaction. Every other write keeps the
        // original single statement.
        if (!persistsWithNotificationIntentV1({ direction: 'inbound', type: 'text', channel: input.channel, metadata: input.metadata })) {
            const message = await prisma.message.create({
                data,
                select: { id: true },
            })
            return { messageId: message.id, created: true }
        }

        const message = await prisma.$transaction(async (transaction) => {
            const created = await transaction.message.create({ data })
            const intent = inboundNotificationOutboxRowV1(created, new Date())
            if (intent) await transaction.domainOutboxEvent.createMany({ data: [intent], skipDuplicates: true })
            return created
        })
        return { messageId: message.id, created: true }
    },
}
