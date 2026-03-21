'use server'

import { prisma } from '@/lib/prisma'
import { sendTelegramBotMessage } from './tg-bot-actions'

/**
 * Broadcasts a single message to all verified drivers connected via the Telegram Bot.
 * 
 * @param text The message content to broadcast
 * @param filterByParkId Optional parameter to only broadcast to drivers of a specific park
 */
export async function broadcastToVerifiedDrivers(text: string) {
    console.log(`[CRM BROADCAST] Starting broadcast: ${text.substring(0, 30)}...`)

    try {
        // Find all drivers who have verified their Telegram phone number
        const recipients = await prisma.driverTelegram.findMany({
            where: {
                phoneVerified: true,
            }
        })

        if (recipients.length === 0) {
            return {
                success: true,
                count: 0,
                message: "No verified drivers found to broadcast."
            }
        }

        let successCount = 0
        let failureCount = 0

        // In a real production system, this should likely be sent to a queue
        // or processed in batches to not overwhelm the Bot API or hit Telegram limits.
        // For MVP, we use Promise.allSettled for parallel execution.
        const broadcastPromises = recipients.map(driver =>
            sendTelegramBotMessage(driver.telegramId.toString(), text, driver.driverId)
        )

        const results = await Promise.allSettled(broadcastPromises)

        results.forEach(result => {
            if (result.status === 'fulfilled' && result.value.success) {
                successCount++
            } else {
                failureCount++
            }
        })

        console.log(`[CRM BROADCAST] Complete. Sent: ${successCount}, Failed: ${failureCount}`)

        return {
            success: true,
            count: successCount,
            failures: failureCount
        }

    } catch (error: any) {
        console.error('[CRM BROADCAST] Error:', error)
        return {
            success: false,
            error: error.message
        }
    }
}
