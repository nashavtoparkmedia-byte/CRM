import { prisma } from '@/lib/prisma'
import { sendMessage as sendWhatsAppMessage } from './whatsapp/WhatsAppService'
import { ConversationWorkflowService } from '@/lib/ConversationWorkflowService'
import { opsLog } from '@/lib/opsLog'
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

            // 1b. Enrich with fields not in Prisma client types (chatType, workflow fields)
            const extraRows = await (prisma as any).$queryRaw`
                SELECT id, "chatType", "assignedToUserId", "lastInboundAt", "lastOutboundAt"
                FROM "Chat"
            `
            const extraMap = new Map<string, any>()
            for (const row of extraRows) {
                extraMap.set(row.id, row)
            }
            for (const chat of chats) {
                const extra = extraMap.get(chat.id)
                if (extra) {
                    chat.chatType = extra.chatType || 'private'
                    chat.assignedToUserId = extra.assignedToUserId
                    chat.lastInboundAt = extra.lastInboundAt
                    chat.lastOutboundAt = extra.lastOutboundAt
                }
            }

            // 2. Group chats by contactId (priority) or driverId (fallback)
            // This ensures chats created via Contact API (with contactId but no driverId)
            // are grouped together with chats linked via Driver.
            const ungroupedChats: any[] = []

            // Union-Find merge: chats sharing contactId OR driverId end up in the same group
            const chatToGroup = new Map<string, string>() // chatId → groupKey
            const keyToGroup = new Map<string, string>()   // contactId/driverId → groupKey
            const groupChats = new Map<string, any[]>()    // groupKey → chats

            for (const chat of chats) {
                if (chat.chatType && chat.chatType !== 'private') {
                    ungroupedChats.push(chat)
                    continue
                }
                const keys = [
                    chat.contactId ? `c:${chat.contactId}` : null,
                    chat.driverId ? `d:${chat.driverId}` : null,
                ].filter(Boolean) as string[]

                if (keys.length === 0) {
                    ungroupedChats.push(chat)
                    continue
                }

                // Find existing group for any of the keys
                let groupKey: string | null = null
                for (const k of keys) {
                    if (keyToGroup.has(k)) {
                        groupKey = keyToGroup.get(k)!
                        break
                    }
                }

                if (!groupKey) {
                    groupKey = keys[0]
                    groupChats.set(groupKey, [])
                }

                // If chat has multiple keys, merge groups
                for (const k of keys) {
                    const existingGroup = keyToGroup.get(k)
                    if (existingGroup && existingGroup !== groupKey) {
                        // Merge existingGroup into groupKey
                        const chatsToMove = groupChats.get(existingGroup) || []
                        const targetChats = groupChats.get(groupKey) || []
                        targetChats.push(...chatsToMove)
                        groupChats.delete(existingGroup)
                        // Re-point all keys from old group
                        for (const [mk, mv] of keyToGroup) {
                            if (mv === existingGroup) keyToGroup.set(mk, groupKey)
                        }
                    }
                    keyToGroup.set(k, groupKey)
                }

                groupChats.get(groupKey)!.push(chat)
            }

            const groups = groupChats

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
                // Ownership: use primary chat's assignee (most recent activity = authoritative)
                const assignedToUserId = primary.assignedToUserId || driverChats.find((c: any) => c.assignedToUserId)?.assignedToUserId || null
                const allChatIds = driverChats.map((c: any) => c.id)
                const channelMap = Object.fromEntries(driverChats.map((c: any) => [c.channel, c.id]))
                const channelUnread = Object.fromEntries(driverChats.map((c: any) => [c.channel, c.unreadCount || 0]))
                
                // Aggregate profiles from all chats for this driver
                const allProfiles = driverChats.map((c: any) => ({
                    channel: c.channel,
                    profileId: c.metadata?.connectionId || c.metadata?.profileId || null
                })).filter(p => p.profileId)

                mergedEntries.push({
                    ...primary,
                    unreadCount: allUnread,
                    requiresResponse,
                    assignedToUserId,
                    allChatIds,
                    channelMap, // { whatsapp: chatId, telegram: chatId, max: chatId }
                    channelUnread, // { whatsapp: 3, telegram: 1, ... }
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
                    channelUnread: { [chat.channel]: chat.unreadCount || 0 },
                    allProfiles: profileId ? [{ channel: chat.channel, profileId }] : [],
                    allChannels: [chat.channel]
                })
            }

            // 5. Sort: unread first (by lastMessageAt desc), then read (by lastMessageAt desc).
            // Telegram-like ordering — attention items bubble to the top.
            mergedEntries.sort((a: any, b: any) => {
                const aUnread = (a.unreadCount || 0) > 0 ? 1 : 0
                const bUnread = (b.unreadCount || 0) > 0 ? 1 : 0
                if (aUnread !== bUnread) return bUnread - aUnread
                const ta = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0
                const tb = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0
                return tb - ta
            })

            return serialize(mergedEntries)
        } catch (err: any) {
            opsLog('error', 'list_conversations_failed', { operation: 'listConversations', error: err.message })
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
            // Phase 2: do NOT return MessageAttachment.url here. Each
            // attachment.url can be a base64 data URL up to 25MB; multiple
            // such rows in one chat ballooned JSON to >1MB and made every
            // chat-open feel sluggish. We now return only id + meta and
            // let the UI lazy-load each binary via /api/attachments/[id]
            // (browser caches it after first request).
            include: {
                attachments: {
                    select: {
                        id: true,
                        type: true,
                        mimeType: true,
                        fileName: true,
                        fileSize: true,
                    },
                },
            },
        })
        // Return in ASC order for UI display
        return serialize(messages.reverse())
    }

    /**
     * Clean up outbound messages stuck in 'sent' status for longer than maxAgeMinutes.
     * These are messages where OUR OWN send attempt never got acknowledged by
     * the provider (server crash mid-delivery, WA/TG/MAX gateway timeout).
     * Marks them 'failed' with a metadata.error explaining the reason.
     *
     * externalId IS NULL guard: messages that already have an externalId came
     * back confirmed from the provider — they are not stuck. In particular,
     * history-backfill paths (WA importWhatsAppHistory, TG importTelegramHistory,
     * MAX webhook) store the provider's id in externalId. Without this guard,
     * backfilled outbound (whose sentAt is legitimately old — hours, days, weeks)
     * would be mis-flagged as failed after 5 min, producing spurious "Повторить"
     * buttons on historical messages. The WA backfill works around this by
     * writing status='delivered' directly, but that's defensive; the correct
     * long-term fix is here in the recovery filter.
     */
    static async recoverStuckMessages(maxAgeMinutes = 5): Promise<number> {
        const cutoff = new Date(Date.now() - maxAgeMinutes * 60_000)
        const result = await (prisma.message as any).updateMany({
            where: {
                direction: 'outbound',
                status: 'sent',
                externalId: null, // NEW — skip anything that already has a provider id
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
            opsLog('error', 'chat_not_found', { operation: 'send', chatId })
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
                                status: 'new'
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

        const created = await (prisma.message as any).create({
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

        // Phase 4 SSE: push outbound to other CRM tabs / operator-on-phone
        // mirror so they see the reply without waiting for a poll tick.
        try {
            const { broadcastChatMessage } = await import('@/lib/messageStreamBus')
            broadcastChatMessage(chatId, created)
        } catch { /* bus must never break send */ }

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
                        
                        const tgBotUrl = process.env.TELEGRAM_BOT_URL || 'http://localhost:3001'
                        const tgRes = await fetch(`${tgBotUrl}/api/bot/send-message`, {
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

        // 3. Update status + retry classification
        try {
            const metadata: any = {}
            if (errorMessage) {
                metadata.error = errorMessage
                metadata.errorCode = getErrorCode(errorMessage)
                metadata.errorSchemaVersion = ERROR_SCHEMA_VERSION
                const retryable = classifyError(errorMessage)
                metadata.retryable = retryable
                metadata.retryAttempt = 0
                metadata.maxRetries = 3
                metadata.lastFailedAt = new Date().toISOString()
                if (retryable) {
                    opsLog('info', 'message_retry_classified', { messageId, chatId, channel, retryable: true, errorCode: metadata.errorCode })
                } else {
                    opsLog('info', 'message_retry_terminal', { messageId, chatId, channel, error: errorMessage, errorCode: metadata.errorCode })
                }
            }

            await (prisma.message as any).update({
                where: { id: messageId },
                data: {
                    status: deliveryStatus,
                    externalId: deliveryExternalId || undefined,
                    metadata: Object.keys(metadata).length > 0 ? metadata : undefined
                }
            })
            const now = new Date()
            await (prisma.chat as any).update({
                where: { id: chatId },
                data: { lastMessageAt: now }
            })

            // Workflow: outbound message state update
            if (deliveryStatus !== 'failed') {
                await ConversationWorkflowService.onOutboundMessage(chatId, now)
            }
        } catch (updErr) {
            opsLog('error', 'message_status_update_failed', { operation: 'send', chatId, error: (updErr as any)?.message })
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

    /**
     * Retry a previously failed message. Reuses same message record (idempotent).
     * Does NOT create a new Message — updates existing one.
     */
    static async retrySend(messageId: string): Promise<{ success: boolean; error?: string }> {
        const message = await (prisma.message as any).findUnique({
            where: { id: messageId },
            include: { chat: { include: { driver: true } } },
        })

        if (!message) return { success: false, error: 'Message not found' }
        if (message.status !== 'failed') return { success: false, error: `Status is ${message.status}, not failed` }

        const meta = (message.metadata as any) || {}
        if (!meta.retryable) return { success: false, error: 'Not retryable' }

        const attempt = (meta.retryAttempt || 0) + 1
        if (attempt > (meta.maxRetries || 3)) return { success: false, error: 'Max retries exceeded' }

        // Backoff check: skip if too soon. Delay = min(2^attempt * 30s, 10min)
        const backoffMs = Math.min(Math.pow(2, attempt) * 30000, 10 * 60 * 1000)
        const lastFailed = meta.lastFailedAt ? new Date(meta.lastFailedAt).getTime() : 0
        if (Date.now() - lastFailed < backoffMs) {
            return { success: false, error: 'Backoff not elapsed' }
        }

        opsLog('info', 'message_retry_attempt', {
            messageId, chatId: message.chatId, channel: message.channel, retryAttempt: attempt,
        })

        // Reset to 'sent' for delivery attempt
        await (prisma.message as any).update({
            where: { id: messageId },
            data: { status: 'sent', metadata: { ...meta, retryAttempt: attempt } },
        })

        // Re-dispatch through channel
        let deliveryStatus = 'failed'
        let errorMessage: string | null = null
        let deliveryExternalId: string | null = null

        try {
            const chat = message.chat
            const rawExternalId = chat.externalChatId?.split(':').slice(1).join(':') || chat.externalChatId
            const connId = (chat.metadata as any)?.connectionId

            switch (message.channel) {
                case 'whatsapp': {
                    const { sendWhatsAppMessage: deliverWA } = await import('@/app/settings/integrations/whatsapp/whatsapp-actions')
                    const waConn = connId || (await prisma.whatsAppConnection.findFirst({ where: { status: 'ready' }, select: { id: true } }))?.id
                    if (!waConn) throw new Error('No ready WhatsApp connection available.')
                    await deliverWA(waConn, rawExternalId, message.content)
                    deliveryStatus = 'delivered'
                    break
                }
                case 'max': {
                    const { sendMaxMessage: deliverMax } = await import('@/app/max-actions')
                    await deliverMax(rawExternalId, message.content, { isPersonal: true, name: chat.driver?.fullName })
                    deliveryStatus = 'delivered'
                    break
                }
                case 'telegram': {
                    const { sendTelegramMessage: deliverTG } = await import('@/app/tg-actions')
                    const target = rawExternalId || chat.driver?.phone?.replace(/\D/g, '')
                    if (!target) throw new Error('No target for TG')
                    const defaultConns: any[] = await prisma.$queryRaw`SELECT id FROM "TelegramConnection" WHERE "isActive" = true ORDER BY "isDefault" DESC LIMIT 1`
                    const profileId = defaultConns[0]?.id
                    if (!profileId) throw new Error('No active TG connection')
                    const res = await deliverTG(target, message.content, profileId, {})
                    if (res.externalId) deliveryExternalId = res.externalId
                    deliveryStatus = 'delivered'
                    break
                }
            }
        } catch (err: any) {
            errorMessage = err.message || 'Retry delivery failed'
        }

        // Update final status
        const retryMeta: any = { ...meta, retryAttempt: attempt, lastFailedAt: new Date().toISOString() }
        if (deliveryStatus === 'failed') {
            retryMeta.error = errorMessage
            retryMeta.retryable = classifyError(errorMessage || '')
            opsLog('warn', 'message_retry_failed', { messageId, channel: message.channel, retryAttempt: attempt, error: errorMessage || undefined })
        } else {
            opsLog('info', 'message_retry_success', { messageId, channel: message.channel, retryAttempt: attempt })
        }

        await (prisma.message as any).update({
            where: { id: messageId },
            data: {
                status: deliveryStatus,
                externalId: deliveryExternalId || undefined,
                metadata: retryMeta,
            },
        })

        if (deliveryStatus !== 'failed') {
            await ConversationWorkflowService.onOutboundMessage(message.chatId, new Date())
        }

        return { success: deliveryStatus !== 'failed', error: errorMessage || undefined }
    }
}

// ── Error classification ─────────────────────────────────────────────────

// ── Error Taxonomy (v1) ──────────────────────────────────────────────────

const ERROR_SCHEMA_VERSION = 1

type ErrorCode =
    | 'TRANSPORT_UNAVAILABLE'
    | 'TIMEOUT'
    | 'NETWORK_ERROR'
    | 'TRANSPORT_CRASH'
    | 'RECIPIENT_NOT_FOUND'
    | 'AUTH_FAILURE'
    | 'VALIDATION_ERROR'
    | 'UNKNOWN'

const RETRYABLE_PATTERNS: Array<{ pattern: string; code: ErrorCode }> = [
    { pattern: 'timeout', code: 'TIMEOUT' },
    { pattern: 'no ready whatsapp connection', code: 'TRANSPORT_UNAVAILABLE' },
    { pattern: 'client not connected', code: 'TRANSPORT_UNAVAILABLE' },
    { pattern: 'client not found', code: 'TRANSPORT_UNAVAILABLE' },
    { pattern: 'stale client', code: 'TRANSPORT_CRASH' },
    { pattern: 'puppeteer crash', code: 'TRANSPORT_CRASH' },
    { pattern: 'telegram is not connected', code: 'TRANSPORT_UNAVAILABLE' },
    { pattern: 'no active max bot', code: 'TRANSPORT_UNAVAILABLE' },
    { pattern: 'failed to send message via scraper', code: 'NETWORK_ERROR' },
    { pattern: 'failed to call scraper', code: 'NETWORK_ERROR' },
    { pattern: 'protocol error', code: 'TRANSPORT_CRASH' },
    { pattern: 'target closed', code: 'TRANSPORT_CRASH' },
    { pattern: 'session closed', code: 'TRANSPORT_CRASH' },
    { pattern: 'detached frame', code: 'TRANSPORT_CRASH' },
    { pattern: 'econnrefused', code: 'NETWORK_ERROR' },
    { pattern: 'econnreset', code: 'NETWORK_ERROR' },
    { pattern: 'epipe', code: 'NETWORK_ERROR' },
    { pattern: 'network', code: 'NETWORK_ERROR' },
    { pattern: 'tg bot error', code: 'NETWORK_ERROR' },
]

const TERMINAL_PATTERNS: Array<{ pattern: string; code: ErrorCode }> = [
    { pattern: 'cannot find or import user', code: 'RECIPIENT_NOT_FOUND' },
    { pattern: 'contact import returned empty', code: 'RECIPIENT_NOT_FOUND' },
    { pattern: 'auth_failure', code: 'AUTH_FAILURE' },
    { pattern: 'logout', code: 'AUTH_FAILURE' },
    { pattern: 'no target', code: 'VALIDATION_ERROR' },
    { pattern: 'telegram bot cannot send to phone', code: 'VALIDATION_ERROR' },
    { pattern: 'invalid', code: 'VALIDATION_ERROR' },
    { pattern: 'token is required', code: 'VALIDATION_ERROR' },
]

function classifyError(error: string): boolean {
    const lower = error.toLowerCase()
    for (const { pattern } of TERMINAL_PATTERNS) {
        if (lower.includes(pattern)) return false
    }
    for (const { pattern } of RETRYABLE_PATTERNS) {
        if (lower.includes(pattern)) return true
    }
    return false // safe default: terminal
}

function getErrorCode(error: string): ErrorCode {
    const lower = error.toLowerCase()
    for (const { pattern, code } of TERMINAL_PATTERNS) {
        if (lower.includes(pattern)) return code
    }
    for (const { pattern, code } of RETRYABLE_PATTERNS) {
        if (lower.includes(pattern)) return code
    }
    return 'UNKNOWN'
}
