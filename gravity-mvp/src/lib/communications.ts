// Communications — unified event logging helpers

import { prisma } from '@/lib/prisma'

/**
 * Log a communication event and update DriverDaySummary flags
 */
export async function logCommunicationEvent(
    driverId: string,
    channel: string,
    direction: string,
    eventType: string,
    content?: string,
    metadata?: Record<string, any>,
    createdBy?: string
) {
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    // Create the event record
    const event = await prisma.communicationEvent.create({
        data: {
            driverId,
            channel,
            direction,
            eventType,
            content,
            metadata: metadata ?? undefined,
            createdBy: createdBy ?? 'system',
        },
    })

    // Update DriverDaySummary flags based on event type
    const summaryUpdate: Record<string, boolean> = {}

    if (eventType === 'message' && direction === 'outbound') {
        if (channel === 'auto') {
            summaryUpdate.hadAutoMessage = true
        } else {
            summaryUpdate.hadManagerMessage = true
        }
    } else if (eventType === 'call') {
        summaryUpdate.hadManagerCall = true
    } else if (eventType === 'auto_message') {
        summaryUpdate.hadAutoMessage = true
    } else if (eventType === 'goal_achieved') {
        summaryUpdate.hadGoalAchieved = true
    }

    if (Object.keys(summaryUpdate).length > 0) {
        await prisma.driverDaySummary.upsert({
            where: { driverId_date: { driverId, date: today } },
            update: summaryUpdate,
            create: {
                driverId,
                date: today,
                ...summaryUpdate,
            },
        })
    }

    return event
}

/**
 * Get combined timeline for a driver
 */
export async function getDriverTimeline(driverId: string, limit: number = 50) {
    const events = await prisma.communicationEvent.findMany({
        where: { driverId },
        orderBy: { createdAt: 'desc' },
        take: limit,
    })

    return events.map(e => ({
        id: e.id,
        channel: e.channel,
        direction: e.direction,
        eventType: e.eventType,
        content: e.content,
        createdBy: e.createdBy,
        createdAt: e.createdAt.toISOString(),
        metadata: e.metadata as Record<string, any> | null,
    }))
}

export type TimelineEvent = Awaited<ReturnType<typeof getDriverTimeline>>[number]
