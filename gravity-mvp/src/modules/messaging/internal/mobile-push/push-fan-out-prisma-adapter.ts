import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { OUTBOX_MAX_ATTEMPTS_V1 } from '@/infrastructure/outbox/v1'
import type { MobilePushDeliveryRequestedEventV1 } from '../../../../contracts/messaging/v1'

/**
 * Mobile Push v1 fan-out storage: the one Messaging writer of per-device
 * delivery events into the shared outbox.
 *
 * Event ids are deterministic (Message × stable registration id) and the
 * append skips duplicates, so a fan-out retried after a partial failure, or a
 * duplicate intent, cannot create a second delivery for the same device.
 * Payloads carry identifiers and a session fingerprint only — never a device
 * token, never message content.
 */
export const prismaMobilePushFanOutStoreV1 = {
    async findChatForNotification(chatId: string): Promise<{ id: string, chatType: string } | null> {
        return prisma.chat.findUnique({ where: { id: chatId }, select: { id: true, chatType: true } })
    },

    async appendDeliveryEvents(events: readonly MobilePushDeliveryRequestedEventV1[]): Promise<number> {
        // One explicit row per statement: every stored field is visible at the
        // write, and each append is idempotent on its deterministic event id,
        // so a fan-out retried after a partial failure completes the rest.
        let appended = 0
        for (const event of events) {
            const result = await prisma.domainOutboxEvent.createMany({
                data: [{
                    eventId: event.eventId,
                    eventType: event.eventType,
                    eventVersion: event.eventVersion,
                    aggregateType: event.aggregate.type,
                    aggregateId: event.aggregate.id,
                    payload: event as unknown as Prisma.InputJsonValue,
                    maxAttempts: OUTBOX_MAX_ATTEMPTS_V1,
                    correlationId: event.correlationId,
                    causationId: event.causationId,
                }],
                skipDuplicates: true,
            })
            appended += result.count
        }
        return appended
    },
}
