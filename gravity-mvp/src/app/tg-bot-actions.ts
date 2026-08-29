'use server'

import { prisma } from '@/lib/prisma'
import { CREATE_CHANNEL_MESSAGE_COMMAND_V1, PATCH_CHANNEL_CONVERSATION_COMMAND_V1, UPSERT_CHANNEL_CONVERSATION_COMMAND_V1 } from '@/contracts/messaging/v1'
import { createChannelMessageV1, patchChannelConversationV1, upsertChannelConversationV1 } from '@/modules/messaging/public/v1'

// Configuration for the external Telegram Bot Microservice
const BOT_API_URL = process.env.BOT_API_URL || 'http://localhost:4000/api/bot'

/**
 * Send a message to a Telegram user from the CRM via the Telegram Bot Microservice.
 * This function also records the message in the CRM's local database.
 * 
 * @param telegramId The Telegram user ID to send the message to
 * @param text The text content of the message
 * @param driverId Optional. The associated Yandex driver ID if known
 */
export async function sendTelegramBotMessage(telegramId: string, text: string, driverId?: string, inlineKeyboard?: any[]) {
    console.log(`[CRM -> TG BOT] Sending message to ${telegramId}: ${text.substring(0, 30)}...`)

    try {
        const payload: any = {
            chatId: telegramId,
            text: text
        }

        if (inlineKeyboard && inlineKeyboard.length > 0) {
            payload.replyMarkup = JSON.stringify({
                inline_keyboard: inlineKeyboard
            })
        }

        // 1. Send the HTTP request to the independent Telegram Bot microservice
        const response = await fetch(`${BOT_API_URL}/send-message`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload)
        })

        if (!response.ok) {
            const errorText = await response.text()
            console.error(`[CRM -> TG BOT] Failed to send via Bot API. Status: ${response.status}`, errorText)
            throw new Error(`Bot API returned status ${response.status}: ${errorText}`)
        }

        // 2. If successful, log the outgoing message in our local DB (Legacy table)
        const dbMessage = await prisma.botChatMessage.create({
            data: {
                telegramId: BigInt(telegramId),
                text: text,
                direction: 'OUTGOING',
                driverId: driverId || null
            }
        })

        // 3. Also log to the unified Message table for the Messenger UI
        try {
            const externalChatId = `telegram:${telegramId}`
            let unifiedChat = await (prisma.chat as any).findUnique({ where: { externalChatId } })
            
            if (!unifiedChat) {
                unifiedChat = (await upsertChannelConversationV1({ contract: UPSERT_CHANNEL_CONVERSATION_COMMAND_V1, externalChatId, channel: 'telegram', name: `TG ${telegramId}`, chatType: 'private', metadata: {} })).conversation as any
                await patchChannelConversationV1({ contract: PATCH_CHANNEL_CONVERSATION_COMMAND_V1, selector: { chatId: unifiedChat.id }, patch: { lastMessageAt: new Date(), ...(driverId ? { driverId } : {}) } })
            } else {
                await patchChannelConversationV1({ contract: PATCH_CHANNEL_CONVERSATION_COMMAND_V1, selector: { chatId: unifiedChat.id }, patch: { lastMessageAt: new Date() } })
            }

            await createChannelMessageV1({ contract: CREATE_CHANNEL_MESSAGE_COMMAND_V1, chatId: unifiedChat.id, direction: 'outbound', content: text, channel: 'telegram', type: 'text', sentAt: new Date(), status: 'delivered', externalId: `telegram:bot:${telegramId}:${Date.now()}` })
        } catch (syncErr: any) {
            console.error('[TG-BOT-SYNC] Failed to sync outbound message to unified table:', syncErr.message)
        }

        return {
            success: true,
            messageId: dbMessage.id
        }

    } catch (error: any) {
        console.error('[CRM -> TG BOT] Exception sending message:', error)
        return {
            success: false,
            error: error.message
        }
    }
}

/**
 * Get a list of recent Bot Chat Messages from unrecognized Telegram accounts 
 * that are not yet linked to a Yandex driver profile.
 */
export async function getUnlinkedTelegramUsers() {
    // 1. Get all unique telegram IDs from BotChatMessage
    const recentMessages = await prisma.botChatMessage.findMany({
        where: { driverId: null, direction: 'INCOMING' },
        orderBy: { createdAt: 'desc' },
        distinct: ['telegramId'],
        take: 50
    })

    const result = []

    for (const msg of recentMessages) {
        // Check if there's already a link in DriverTelegram (even if it's missing the actual driverId via some bug)
        const existingLink = await prisma.driverTelegram.findUnique({
            where: { telegramId: msg.telegramId }
        })

        if (!existingLink || !existingLink.driverId) {
            result.push({
                telegramId: msg.telegramId.toString(),
                text: msg.text,
                date: msg.createdAt
            })
        }
    }

    return result
}

/**
 * Manually link a Telegram User ID to a Yandex Driver ID.
 */
export async function linkTelegramUserToDriver(telegramId: string, driverId: string) {
    try {
        const tgBigInt = BigInt(telegramId)

        // Upsert the driver telegram link
        await prisma.driverTelegram.upsert({
            where: { telegramId: tgBigInt },
            create: {
                telegramId: tgBigInt,
                driverId: driverId,
                phoneVerified: true // Assumption by admin
            },
            update: {
                driverId: driverId,
                phoneVerified: true
            }
        })

        return { success: true }
    } catch (error: any) {
        console.error('[CRM] Manual link error:', error)
        return { success: false, error: 'Ошибка привязке. Убедитесь, что водитель существует.' }
    }
}
