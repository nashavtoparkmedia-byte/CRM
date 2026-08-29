import { prisma } from '@/lib/prisma'

import type { DriverCommunicationEventPersistencePortV1 } from './driver-communication-event-handler'

export const legacyPrismaDriverCommunicationEventPortV1:
    DriverCommunicationEventPersistencePortV1 = {
    async record(input) {
        await prisma.communicationEvent.create({
            data: input.activity === 'manager_call'
                ? {
                    driverId: input.driverId,
                    channel: 'phone',
                    direction: 'outbound',
                    eventType: 'call',
                    content: input.content,
                    createdBy: 'manager',
                }
                : {
                    driverId: input.driverId,
                    channel: input.channel,
                    direction: 'outbound',
                    eventType: 'message',
                    content: input.content,
                    metadata: { recipientPhone: input.recipientPhone },
                    createdBy: 'manager',
                },
        })
    },
    async timeline(driverId, limit) {
        const events = await prisma.communicationEvent.findMany({
            where: { driverId },
            orderBy: { createdAt: 'desc' },
            take: limit,
        })
        return events.map((event) => ({
            id: event.id,
            channel: event.channel,
            direction: event.direction,
            eventType: event.eventType,
            content: event.content,
            createdBy: event.createdBy,
            createdAt: event.createdAt.toISOString(),
            metadata: event.metadata as Record<string, unknown> | null,
        }))
    },
}
