'use server'

import { prisma } from '@/lib/prisma'
import { sendOperationalTelegramTextV1 } from '@/infrastructure/telegram/operational-capabilities'
import {
    GET_DRIVER_COMMUNICATION_TIMELINE_QUERY_V1,
    RECORD_DRIVER_COMMUNICATION_EVENT_COMMAND_V1,
    type DriverCommunicationTimelineEventV1,
    RECORD_DRIVER_DAILY_ACTIVITY_COMMAND_V1,
} from '@/contracts/fleet-operations/v1'
import {
    getDriverCommunicationTimelineV1,
    recordDriverCommunicationEventV1,
    recordDriverDailyActivityV1,
} from '@/modules/fleet-operations/public/v1'

export async function getDriverTimeline(driverId: string, limit: number = 50) {
    return (await getDriverCommunicationTimelineV1({
        contract: GET_DRIVER_COMMUNICATION_TIMELINE_QUERY_V1,
        driverId,
        limit,
    })).events
}

export type TimelineEvent = DriverCommunicationTimelineEventV1

function todayStartIso(): string {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    return today.toISOString()
}

/**
 * Send message to driver via Telegram and log to CommunicationEvent
 */
export async function sendDriverMessage(
    driverId: string,
    channel: string,
    message: string,
    connectionId?: string
) {
    // Get driver phone
    const driver = await prisma.driver.findUnique({
        where: { id: driverId },
        select: { phone: true, fullName: true },
    })

    if (!driver?.phone) {
        throw new Error('Нет номера телефона')
    }

    // Send via channel
    if (channel === 'telegram') {
        await sendOperationalTelegramTextV1(driver.phone, message, connectionId)
    }
    // WhatsApp would go here

    // Log the event
    const dayStart = todayStartIso()
    await recordDriverCommunicationEventV1({
        contract: RECORD_DRIVER_COMMUNICATION_EVENT_COMMAND_V1,
        driverId,
        activity: 'manager_message',
        channel,
        content: message,
        recipientPhone: driver.phone,
    })
    await recordDriverDailyActivityV1({
        contract: RECORD_DRIVER_DAILY_ACTIVITY_COMMAND_V1,
        driverId,
        dayStart,
        activity: 'manager_message',
    })

    return { success: true }
}

/**
 * Log a call and create CommunicationEvent
 */
export async function logDriverCall(driverId: string, note?: string) {
    const dayStart = todayStartIso()
    await recordDriverCommunicationEventV1({
        contract: RECORD_DRIVER_COMMUNICATION_EVENT_COMMAND_V1,
        driverId,
        activity: 'manager_call',
        channel: 'phone',
        content: note || 'Звонок менеджера',
    })
    await recordDriverDailyActivityV1({
        contract: RECORD_DRIVER_DAILY_ACTIVITY_COMMAND_V1,
        driverId,
        dayStart,
        activity: 'manager_call',
    })
    return { success: true }
}
