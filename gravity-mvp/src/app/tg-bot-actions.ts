'use server'

import { prisma } from '@/lib/prisma'
import { SAVE_MANUAL_DRIVER_TELEGRAM_LINK_COMMAND_V1 } from '@/contracts/telegram-channel/v1'
import { requireIntegrationAdminAccess } from '@/modules/identity-access/public/v1'
import { prepareOutboundConversationV1 } from '@/modules/messaging/public/v1/outbound-conversation-identity-runtime'
import { saveManualDriverTelegramLinkV1 } from '@/modules/telegram-channel/public/v1'
import {
    sendExactTelegramBotMessageV1,
    type TelegramBotInlineKeyboardV1,
} from '@/modules/telegram-channel/public/v1/bot-message-delivery'

function exactTelegramPeer(value: unknown): string | null {
    if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) return null
    return /^\d+$/.test(value) && value !== '0' ? value : null
}

/**
 * Send a message only through an already-admitted Telegram conversation.
 * The persisted ContactIdentity/account/connection binding, not this function's
 * telegramId argument, selects both the provider peer and transport.
 * 
 * @param telegramId Selects the existing conversation; it is never sent directly
 * @param text The text content of the message
 * @param _driverId Deprecated compatibility input; persisted Chat ownership wins
 */
export async function sendTelegramBotMessage(
    telegramId: string,
    text: string,
    _driverId?: string,
    inlineKeyboard?: TelegramBotInlineKeyboardV1,
) {
    console.log(`[CRM -> TG BOT] Sending message to ${telegramId}: ${text.substring(0, 30)}...`)

    try {
        const requestedPeer = exactTelegramPeer(telegramId)
        if (!requestedPeer) throw new Error('TELEGRAM_OUTBOUND_PEER_INVALID')

        const chat = await prisma.chat.findUnique({
            where: { externalChatId: `telegram:${requestedPeer}` },
            select: {
                id: true,
                driverId: true,
                contactId: true,
                contactIdentityId: true,
                channel: true,
                externalChatId: true,
                chatType: true,
                metadata: true,
            },
        })
        if (!chat) throw new Error('CONTACT_CONVERSATION_IDENTITY_REQUIRED')

        // Re-read Contacts-owned reachability plus the exact provider account,
        // transport and peer binding immediately before the provider mutation.
        const outbound = await prepareOutboundConversationV1(chat)
        if (
            outbound.channel !== 'telegram'
            || outbound.chatId !== chat.id
            || outbound.identityTarget !== requestedPeer
            || outbound.target !== requestedPeer
        ) {
            throw new Error('CONTACT_CONVERSATION_IDENTITY_BINDING_MISMATCH')
        }

        await sendExactTelegramBotMessageV1({
            peerId: outbound.target,
            text,
            providerAccountId: outbound.providerAccountId,
            connectionId: outbound.connectionId,
            ...(inlineKeyboard ? { inlineKeyboard } : {}),
        })

        // Retain the Telegram-owned legacy projection, but never accept a
        // caller-selected driver association over the admitted Chat.
        const dbMessage = await prisma.botChatMessage.create({
            data: {
                telegramId: BigInt(outbound.target),
                text: text,
                direction: 'OUTGOING',
                driverId: chat.driverId || null,
            }
        })

        return {
            success: true,
            messageId: dbMessage.id
        }

    } catch (error: unknown) {
        console.error('[CRM -> TG BOT] Exception sending message:', error)
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
        }
    }
}

/**
 * Get a list of recent Bot Chat Messages from unrecognized Telegram accounts 
 * that are not yet linked to a Yandex driver profile.
 */
export async function getUnlinkedTelegramUsers() {
    await requireIntegrationAdminAccess()

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
        await requireIntegrationAdminAccess()
        const tgBigInt = BigInt(telegramId)

        await saveManualDriverTelegramLinkV1({
            contract: SAVE_MANUAL_DRIVER_TELEGRAM_LINK_COMMAND_V1,
            driverId,
            telegramId: tgBigInt,
        })

        return { success: true }
    } catch (error: unknown) {
        console.error('[CRM] Manual link error:', error)
        return { success: false, error: 'Ошибка привязке. Убедитесь, что водитель существует.' }
    }
}
