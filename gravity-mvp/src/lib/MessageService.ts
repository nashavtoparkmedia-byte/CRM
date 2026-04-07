import { prisma } from '@/lib/prisma'
import { sendMessage as sendWhatsAppMessage } from './whatsapp/WhatsAppService'
import { ChatChannel, MessageStatus } from '@prisma/client'

function serialize(obj: any): any {
    return JSON.parse(JSON.stringify(obj, (key, value) =>
        typeof value === 'bigint' ? value.toString() : value
    ));
}


export class MessageService {
    /**
     * Lists all conversations with their drivers and last messages.
     * Chats from the same driver are merged into a single entry.
     */
    static async listConversations() {
        try {
            // 1. Fetch all chats with basic data
            const chats = await (prisma.chat as any).findMany({
                select: {
                    id: true,
                    name: true,
                    channel: true,
                    externalChatId: true,
                    lastMessageAt: true,
                    unreadCount: true,
                    requiresResponse: true,
                    status: true,
                    driverId: true,
                    contactId: true,
                    contactIdentityId: true,
                    metadata: true,
                    driver: {
                        select: {
                            id: true,
                            fullName: true,
                            phone: true,
                            segment: true
                        }
                    },
                    messages: {
                        orderBy: { sentAt: 'desc' },
                        take: 1
                    }
                },
                orderBy: { lastMessageAt: 'desc' }
            })

            // 2. Group chats by contactId (priority) or driverId (fallback)
            // This ensures chats created via Contact API (with contactId but no driverId)
            // are grouped together with chats linked via Driver.
            const groups = new Map<string, any[]>()
            const ungroupedChats: any[] = []

            for (const chat of chats) {
                const key = chat.contactId || chat.driverId
                if (key) {
                    if (!groups.has(key)) groups.set(key, [])
                    groups.get(key)!.push(chat)
                } else {
                    ungroupedChats.push(chat)
                }
            }

            // 3. For each driver group, create a merged entry
            const mergedEntries: any[] = []

            for (const [, driverChats] of groups) {
                // Sort by last message, most recent first
                driverChats.sort((a: any, b: any) => {
                    const ta = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0
                    const tb = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0
                    return tb - ta
                })

                const primary = driverChats[0] // Most recently active chat
                const allUnread = driverChats.reduce((sum: number, c: any) => sum + (c.unreadCount || 0), 0)
                const requiresResponse = driverChats.some((c: any) => c.requiresResponse)
                const allChatIds = driverChats.map((c: any) => c.id)
                const channelMap = Object.fromEntries(driverChats.map((c: any) => [c.channel, c.id]))
                
                // Aggregate profiles from all chats for this driver
                const allProfiles = driverChats.map((c: any) => ({
                    channel: c.channel,
                    profileId: c.metadata?.connectionId || c.metadata?.profileId || null
                })).filter(p => p.profileId)

                mergedEntries.push({
                    ...primary,
                    unreadCount: allUnread,
                    requiresResponse,
                    allChatIds,
                    channelMap, // { whatsapp: chatId, telegram: chatId, max: chatId }
                    allProfiles, // List of { channel, profileId }
                    // For display in channel-filter tabs, keep all channels the driver has
                    allChannels: driverChats.map((c: any) => c.channel)
                })
            }

            // 4. Add ungrouped chats as-is
            for (const chat of ungroupedChats) {
                const profileId = chat.metadata?.connectionId || chat.metadata?.profileId || null
                mergedEntries.push({
                    ...chat,
                    allChatIds: [chat.id],
                    channelMap: { [chat.channel]: chat.id },
                    allProfiles: profileId ? [{ channel: chat.channel, profileId }] : [],
                    allChannels: [chat.channel]
                })
            }

            // 5. Sort by lastMessageAt
            mergedEntries.sort((a: any, b: any) => {
                const ta = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0
                const tb = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0
                return tb - ta
            })

            return serialize(mergedEntries)
        } catch (err: any) {
            console.error('[MessageService] listConversations Error:', err)
            throw err
        }
    }


    /**
     * Lists messages for one or more chats.
     * Used for unified driver history view.
     */
    static async listMessages(chatIds: string | string[], limit = 50) {
        const ids = Array.isArray(chatIds) ? chatIds : [chatIds]
        const messages = await prisma.message.findMany({
            where: { chatId: { in: ids } },
            orderBy: [{ sentAt: 'desc' }, { createdAt: 'desc' }],
            take: limit,
            include: { attachments: true }
        })
        // Return in ASC order for UI display
        return serialize(messages.reverse())
    }

    /**
     * Clean up outbound messages stuck in 'sent' status for longer than maxAgeMinutes.
     * These are messages where delivery was attempted but status was never updated
     * (e.g., server crash mid-delivery).
     * Marks them as 'failed' with metadata.error explaining the reason.
     */
    static async recoverStuckMessages(maxAgeMinutes = 5): Promise<number> {
        const cutoff = new Date(Date.now() - maxAgeMinutes * 60_000)
        const result = await (prisma.message as any).updateMany({
            where: {
                direction: 'outbound',
                status: 'sent',
                sentAt: { lt: cutoff },
            },
            data: {
                status: 'failed',
                metadata: { error: `Message stuck in 'sent' for >${maxAgeMinutes}min — marked failed by recovery` },
            },
        })
        if (result.count > 0) {
            console.log(`[MessageService] RECOVERY: marked ${result.count} stuck messages as failed`)
        }
        return result.count
    }

    /**
     * Sends a message through the appropriate channel.
     */
    static async send(chatId: string, content: string, channelOverride?: ChatChannel, profileId?: string, clientMessageId?: string) {
        console.log(`[MessageService] START send: chatId=${chatId}, channelOverride=${channelOverride}, clientMessageId=${clientMessageId || 'none'}`)

        const chat = await (prisma.chat as any).findUnique({
            where: { id: chatId },
            select: { 
                id: true, 
                channel: true, 
                externalChatId: true,
                metadata: true,
                driver: {
                    select: {
                        id: true,
                        fullName: true,
                        phone: true
                    }
                }
            }
        })

        if (!chat) {
            console.error(`[MessageService] ERROR: Chat ${chatId} not found`)
            throw new Error(`Chat with ID ${chatId} not found`)
        }

        let targetChatId = chatId
        let targetChat = chat

        // If channel is overridden and differs from the current chat channel, we need to switch or create a chat
        if (channelOverride && channelOverride !== chat.channel) {
            console.log(`[MessageService] Channel mismatch: requested ${channelOverride}, chat has ${chat.channel}. Switching context...`)
            
            const rawDigits = chat.externalChatId?.replace(/\D/g, '') || ''
            const finalRawId = channelOverride === 'telegram' && chat.driver?.id 
                ? (await prisma.$queryRaw<{telegramId: bigint}[]>`SELECT "telegramId" FROM "DriverTelegram" WHERE "driverId" = ${chat.driver.id} LIMIT 1`)[0]?.telegramId.toString() || chat.driver.phone?.replace(/\D/g, '') || ''
                : (channelOverride === 'whatsapp' 
                    ? (chat.driver?.phone?.replace(/\D/g, '').length >= 10 ? '7' + chat.driver?.phone?.replace(/\D/g, '').slice(-10) : chat.driver?.phone?.replace(/\D/g, '') || rawDigits) 
                    : (chat.driver?.phone?.replace(/\D/g, '') || rawDigits))

            // Standardize ID format: always prefix with channel
            const prefixedId = channelOverride === 'whatsapp' 
                ? `whatsapp:${finalRawId}`
                : `${channelOverride}:${finalRawId}`

            const searchSuffix = finalRawId.length >= 10 ? finalRawId.slice(-10) : finalRawId
            const existingChat = await (prisma.chat as any).findFirst({
                where: { 
                    channel: channelOverride,
                    OR: [
                        { externalChatId: prefixedId },
                        { externalChatId: { endsWith: searchSuffix } },
                        ...(chat.driver?.id ? [{ driverId: chat.driver.id }] : [])
                    ]
                },
                select: { id: true, channel: true, externalChatId: true, metadata: true },
                orderBy: { driverId: 'desc' }
            })

            if (existingChat) {
                console.log(`[MessageService] Found existing chat for ${channelOverride}: ${existingChat.id}`)
                targetChatId = existingChat.id
                targetChat = { ...chat, ...existingChat, driver: chat.driver }
            } else {
                console.log(`[MessageService] No chat found for ${channelOverride}. Creating new one...`)
                const newChatId = `chat_${Date.now()}`

                try {
                    // Check again if one was created between our two lookups
                    const raceChat = await (prisma.chat as any).findFirst({
                        where: { externalChatId: prefixedId }
                    })
                    if (raceChat) {
                        targetChatId = raceChat.id
                        targetChat = { ...chat, ...raceChat, driver: chat.driver }
                    } else {
                        const createdChat = await (prisma.chat as any).create({
                            data: {
                                id: newChatId,
                                name: chat.driver?.fullName || 'Chat',
                                channel: channelOverride,
                                driverId: chat.driver?.id || null,
                                externalChatId: prefixedId,
                                lastMessageAt: new Date(),
                                unreadCount: 0,
                                status: 'active',
                                requiresResponse: false
                            }
                        })
                        targetChatId = createdChat.id
                        targetChat = { ...chat, ...createdChat, driver: chat.driver }
                        console.log(`[MessageService] New chat created for ${channelOverride}: ${newChatId} (external: ${prefixedId})`)
                    }
                } catch (createErr: any) {
                    console.error(`[MessageService] Failed to create new chat for ${channelOverride}:`, createErr)
                    throw new Error(`Не удалось инициализировать чат для ${channelOverride}: ${createErr.message}`)
                }
            }
        }

        const channel = targetChat.channel
        const currentChatId = targetChatId
        const getRawId = (id: string) => id.includes(':') ? id.split(':').slice(1).join(':') : id
        const rawExternalChatId = getRawId(targetChat.externalChatId)

        console.log(`[MessageService] PROCEEDING TO ROUTE:`, {
            requestedChannel: channelOverride,
            resolvedChannel: channel,
            targetChatId: currentChatId,
            rawExternalId: rawExternalChatId,
            profileId
        })

        // 1. Idempotency check: if clientMessageId provided, check for existing message
        if (clientMessageId) {
            const existing = await (prisma.message as any).findUnique({
                where: { clientMessageId },
                select: { id: true, status: true, chatId: true },
            })
            if (existing) {
                console.log(`[MessageService] IDEMPOTENT: clientMessageId=${clientMessageId} already exists as ${existing.id} (status=${existing.status})`)
                return { success: existing.status !== 'failed', chatId: existing.chatId, id: existing.id, error: null, duplicate: true }
            }
        }

        // 2. Save message to DB first (Optimistic)
        const messageId = `msg_${Date.now()}`
        const now = new Date()

        await (prisma.message as any).create({
            data: {
                id: messageId,
                clientMessageId: clientMessageId || null,
                chatId: chatId,
                content,
                direction: 'outbound',
                status: 'sent',
                channel: channel,
                sentAt: now,
                type: 'text'
            }
        })

        // 2. Deliver via Provider
        let deliveryStatus: MessageStatus = 'sent'
        let errorMessage: string | null = null
        let deliveryExternalId: string | null = null

        try {
            switch (channel) {
                case 'whatsapp':
                    const { sendWhatsAppMessage: deliverWA } = await import('@/app/settings/integrations/whatsapp/whatsapp-actions')
                    const connId = profileId || (targetChat.metadata as any)?.connectionId
                    console.log(`[MessageService] WA Send: connId=${connId}, target=${rawExternalChatId}`)
                    if (connId) {
                        await deliverWA(connId, rawExternalChatId, content)
                    } else {
                        const conn = await prisma.whatsAppConnection.findFirst({ where: { status: 'ready' } })
                        console.log(`[MessageService] WA Fallback: found ready conn=${conn?.id}`)
                        if (!conn) throw new Error('No ready WhatsApp connection available.')
                        await deliverWA(conn.id, rawExternalChatId, content)
                    }
                    deliveryStatus = 'delivered'
                    break
                
                case 'max':
                    const { sendMaxMessage: deliverMax } = await import('@/app/max-actions')
                    const isPersonal = profileId === 'scraper' || !profileId
                    console.log(`[MessageService] MAX Send: isPersonal=${isPersonal}, profileId=${profileId}, target=${rawExternalChatId}`)
                    await deliverMax(rawExternalChatId, content, { 
                        isPersonal,
                        connectionId: isPersonal ? undefined : profileId,
                        name: chat.driver?.fullName
                    })
                    deliveryStatus = 'delivered'
                    break

                case 'telegram':
                    try {
                        const isPhone = rawExternalChatId?.length >= 10 && (rawExternalChatId.startsWith('7') || rawExternalChatId.startsWith('+') || rawExternalChatId.startsWith('8'));
                        
                        // Refined lookup: ALWAYS prefer a TelegramConnection (user profile) if available
                        let activeProfileId = profileId;
                        if (!activeProfileId) {
                            const defaultConns: any[] = await prisma.$queryRaw`SELECT id FROM "TelegramConnection" WHERE "isActive" = true ORDER BY "isDefault" DESC LIMIT 1`;
                            if (defaultConns.length > 0) {
                                activeProfileId = defaultConns[0].id;
                                console.log(`[MessageService] Auto-selected TG profile ${activeProfileId} for target ${rawExternalChatId}`);
                            }
                        }

                        if (activeProfileId) {
                            const { sendTelegramMessage: deliverTG } = await import('@/app/tg-actions')
                            const target = rawExternalChatId || chat.driver?.phone?.replace(/\D/g, '')
                            if (!target) throw new Error('No target for TG')
                            
                            try {
                                const res = await deliverTG(target, content, activeProfileId, { 
                                    // @ts-ignore - dynamic type mismatch
                                    messageId: messageId,
                                    chatId: targetChat.id,
                                    driverId: chat.driver?.id
                                })
                                if (res.externalId) deliveryExternalId = res.externalId
                                deliveryStatus = 'delivered'
                                break // Success with personal profile
                            } catch (gramErr: any) {
                                console.warn(`[MessageService] GramJS delivery failed, falling back to bot if target is NOT a phone: ${gramErr.message}`)
                                if (isPhone) throw gramErr; // Phone targets MUST use GramJS
                                // Proceed to bot fallback below
                            }
                        }

                        // Webhook/Bot Fallback (only for non-phone targets, e.g. bot chats)
                        if (isPhone) throw new Error('Telegram Bot cannot send to phone numbers. Please connect a Telegram Profile.');
                        
                        const tgRes = await fetch('http://localhost:3001/api/bot/send-message', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ chatId: rawExternalChatId, text: content })
                        })
                        if (!tgRes.ok) throw new Error(`TG Bot Error: ${tgRes.status}`)
                        deliveryStatus = 'delivered'
                    } catch (tgErr: any) {
                        deliveryStatus = 'failed'
                        errorMessage = tgErr.message
                        console.error(`[MessageService] TG Delivery FAILED: ${errorMessage}`);
                    }
                    break
            }
        } catch (provErr: any) {
            deliveryStatus = 'failed'
            errorMessage = provErr.message
        }

        // Guarantee metadata.error is always set for failed messages
        if (deliveryStatus === 'failed' && !errorMessage) {
            errorMessage = 'Ошибка доставки'
        }

        // 3. Update status
        try {
            await (prisma.message as any).update({
                where: { id: messageId },
                data: { 
                    status: deliveryStatus, 
                    externalId: deliveryExternalId || undefined,
                    metadata: errorMessage ? { error: errorMessage } : undefined 
                }
            })
            await (prisma.chat as any).update({
                where: { id: chatId },
                data: { lastMessageAt: new Date() }
            })
        } catch (updErr) {
            console.error(`Final Update FAILED`, updErr)
        }

        // 4. Update reachability status based on delivery outcome
        try {
            const { updateReachabilityByChatId } = await import('@/lib/ReachabilityService')
            if (deliveryStatus === 'failed') {
                await updateReachabilityByChatId(chatId, 'unreachable')
            } else if (deliveryStatus === 'delivered' || deliveryStatus === 'sent') {
                await updateReachabilityByChatId(chatId, 'confirmed')
            }
        } catch (reachErr: any) {
            // Non-critical — don't break send flow
            console.error(`[MessageService] Reachability update failed: ${reachErr.message}`)
        }

        return { success: deliveryStatus !== 'failed', chatId: currentChatId, id: messageId, error: errorMessage }
    }
}
