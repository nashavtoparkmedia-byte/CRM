'use server'

import { prisma } from '@/lib/prisma'
import { logCommunicationEvent, getDriverTimeline } from '@/lib/communications'
import { sendTelegramMessage } from '@/app/tg-actions'

export { getDriverTimeline }

export type { TimelineEvent } from '@/lib/communications'

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
        await sendTelegramMessage(driver.phone, message, connectionId)
    }
    // WhatsApp would go here

    // Log the event
    await logCommunicationEvent(
        driverId,
        channel,
        'outbound',
        'message',
        message,
        { recipientPhone: driver.phone },
        'manager'
    )

    return { success: true }
}

/**
 * Log a call and create CommunicationEvent
 */
export async function logDriverCall(driverId: string, note?: string) {
    await logCommunicationEvent(
        driverId,
        'phone',
        'outbound',
        'call',
        note || 'Звонок менеджера',
        undefined,
        'manager'
    )
    return { success: true }
}
