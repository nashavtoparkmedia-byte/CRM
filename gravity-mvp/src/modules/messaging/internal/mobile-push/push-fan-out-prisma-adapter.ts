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
        if (events.length === 0) return 0
        const appended = await prisma.domainOutboxEvent.createMany({
            data: events.map((event) => ({
                eventId: event.eventId,
                eventType: event.eventType,
                eventVersion: event.eventVersion,
                aggregateType: event.aggregate.type,
                aggregateId: event.aggregate.id,
                payload: event as unknown as object,
                maxAttempts: OUTBOX_MAX_ATTEMPTS_V1,
                correlationId: event.correlationId,
                causationId: event.causationId,
            })),
            skipDuplicates: true,
        })
        return appended.count
    },
}
