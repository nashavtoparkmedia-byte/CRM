import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { OUTBOX_MAX_ATTEMPTS_V1 } from '@/infrastructure/outbox/v1'
import type { ReceiveMessagePersistencePortV1 } from './receive-message-handler'
import {
    inboundNotificationIntentV1,
    persistsWithNotificationIntentV1,
} from '../../internal/mobile-push/inbound-notification-intent'

export const legacyPrismaReceiveMessagePortV1: ReceiveMessagePersistencePortV1 = {
    async receive(input) {
        const existing = await prisma.message.findUnique({
            where: { externalId: input.externalId },
            select: { id: true },
        })
        if (existing) return { messageId: existing.id, created: false }

        // Mobile Push v1: a qualifying inbound message and its notification
        // intent commit in ONE transaction. Every other write keeps the
        // original single statement.
        if (!persistsWithNotificationIntentV1({ direction: 'inbound', type: 'text', channel: input.channel, metadata: input.metadata })) {
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
        }

        const message = await prisma.$transaction(async (transaction) => {
            const created = await transaction.message.create({
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
            })
            const intent = inboundNotificationIntentV1(created, new Date())
            if (intent) {
                await transaction.domainOutboxEvent.createMany({
                    data: [{
                        eventId: intent.eventId,
                        eventType: intent.eventType,
                        eventVersion: intent.eventVersion,
                        aggregateType: intent.aggregate.type,
                        aggregateId: intent.aggregate.id,
                        payload: intent as unknown as Prisma.InputJsonValue,
                        maxAttempts: OUTBOX_MAX_ATTEMPTS_V1,
                        correlationId: intent.correlationId,
                        causationId: intent.causationId,
                    }],
                    skipDuplicates: true,
                })
            }
            return created
        })
        return { messageId: message.id, created: true }
    },
}
