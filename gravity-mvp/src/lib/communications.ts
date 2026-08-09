// Communications — unified event logging helpers

import { prisma } from '@/lib/prisma'
import {
    RECORD_DRIVER_DAILY_ACTIVITY_COMMAND_V1,
    type DriverDailyActivityV1,
} from '@/contracts/fleet-operations/v1'
import { recordDriverDailyActivityV1 } from '@/modules/fleet-operations/public/v1'

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
    let dailyActivity: DriverDailyActivityV1 | null = null

    if (eventType === 'message' && direction === 'outbound') {
        if (channel === 'auto') {
            dailyActivity = 'auto_message'
        } else {
            dailyActivity = 'manager_message'
        }
    } else if (eventType === 'call') {
        dailyActivity = 'manager_call'
    } else if (eventType === 'auto_message') {
        dailyActivity = 'auto_message'
    } else if (eventType === 'goal_achieved') {
        dailyActivity = 'goal_achieved'
    }

    if (dailyActivity) {
        await recordDriverDailyActivityV1({
            contract: RECORD_DRIVER_DAILY_ACTIVITY_COMMAND_V1,
            driverId,
            dayStart: today.toISOString(),
            activity: dailyActivity,
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
