import { prisma } from '@/lib/prisma'
import { ConversationWorkflowService } from '@/lib/ConversationWorkflowService'
import { operationalLogV1 as opsLog } from '@/infrastructure/operations/operational-log'
import { ChatChannel, MessageStatus } from '@prisma/client'
import { buildCanonicalContactSummary } from '@/modules/contacts/public/v1/contact-display-policy'
import { getMaxChannelDeliveryV1, getTelegramChannelDeliveryV1, getWhatsAppChannelDeliveryV1 } from '@/modules/messaging/public/v1/channel-delivery-runtime'
import { prepareOutboundConversationV1 } from '@/modules/messaging/public/v1/outbound-conversation-identity-runtime'

function serialize(obj: any): any {
    return JSON.parse(JSON.stringify(obj, (key, value) =>
        typeof value === 'bigint' ? value.toString() : value
    ));
}

function nonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() !== '' ? value : null
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
                            segment: true,
                            // Нужны для compute "Водитель · Avito" vs
                            // "Отток · Avito" в LeadStatusBadge — без них
                            // в списке невозможно отличить активного от
                            // ушедшего.
                            lastOrderAt: true,
                            dismissedAt: true,
                        }
                    },
                    // Contact info — used in the chat header when the chat
                    // has no driver linked (e.g. brand-new contacts created
                    // via "+ search by phone"). Without this the header
                    // showed the raw chat.name (often a Telegram username
                    // like "Check") instead of the human-readable ФИО.
                    contact: {
                        select: {
                            id: true,
                            displayName: true,
                            displayNameSource: true,
                            masterSource: true,
                            yandexDriverId: true,
                            primaryPhoneId: true,
                            phones: {
                                where: { isActive: true },
                                orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
                                select: { id: true, phone: true, isPrimary: true },
                            },
                            // TG identity metadata (firstName/lastName/username) — used by
                            // ChatList to show "Имя (@username)" when operator filters by
                            // the Telegram tab, instead of always falling back to driver FIO.
                            identities: {
                                where: { isActive: true },
                                orderBy: { createdAt: 'asc' },
                                select: {
                                    id: true,
                                    channel: true,
                                    externalId: true,
                                    displayName: true,
                                    metadata: true,
                                },
                            },
                        },
                    },
                    messages: {
                        orderBy: { sentAt: 'desc' },
                        take: 1
                    }
                },
                orderBy: { lastMessageAt: 'desc' },
                take: 400,
            })

            // 1b. Enrich with fields not in Prisma client types (chatType, workflow fields)
            // Scoped to the same set of chatIds to avoid a full-table scan.
            const chatIds: string[] = chats.map((c: any) => c.id)
            const extraRows: any[] = chatIds.length > 0 ? await (prisma as any).$queryRaw`
                SELECT id, "chatType", "assignedToUserId", "lastInboundAt", "lastOutboundAt"
                FROM "Chat"
                WHERE id = ANY(${chatIds})
            ` : []
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

            const yandexDriverIds = Array.from(new Set(
                chats
                    .map((chat: any) => chat.contact?.yandexDriverId)
                    .filter(Boolean)
            ))
            const contactDrivers = yandexDriverIds.length > 0
                ? await prisma.driver.findMany({
                    where: { yandexDriverId: { in: yandexDriverIds as string[] } },
                    select: {
                        id: true,
                        yandexDriverId: true,
                        fullName: true,
                        phone: true,
                        segment: true,
                        dismissedAt: true,
                    },
                })
                : []
            const driverByYandexId = new Map(contactDrivers.map((d: any) => [d.yandexDriverId, d]))

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
                // Per-channel maps. driverChats is sorted by lastMessageAt DESC,
                // so the FIRST occurrence per channel is the newest chat in that
                // channel. With Object.fromEntries the LAST entry won, which on
                // contacts that accidentally have two chats in the same channel
                // (e.g. WhatsApp LID vs phone-number formats) routed clicks to
                // the older empty one. Iterate-and-skip-if-set fixes this.
                const channelMap: Record<string, string> = {}
                const channelUnread: Record<string, number> = {}
                for (const c of driverChats) {
                    if (channelMap[c.channel] === undefined) channelMap[c.channel] = c.id
                    // Sum unread across same-channel duplicates so the badge
                    // doesn't undercount when a contact has split chats.
                    channelUnread[c.channel] = (channelUnread[c.channel] ?? 0) + (c.unreadCount || 0)
                }

                // Aggregate profiles from all chats for this driver
                const allProfiles = driverChats.map((c: any) => ({
                    channel: c.channel,
                    profileId: c.metadata?.connectionId || c.metadata?.profileId || null
                })).filter(p => p.profileId)

                // Per-channel snapshot of each underlying chat. Used by ChatList
                // to "rebase" a merged entry onto a specific channel when the
                // operator filters by WA/TG/MAX/Тел — the row then shows that
                // channel's last message, timestamp and unread count instead of
                // the primary chat's. Only the display-critical fields are
                // copied to keep the payload small.
                //
                // Same dedup rule as channelMap above: keep the newest chat per
                // channel, skip same-channel duplicates.
                const channelChats: Record<string, any> = {}
                for (const c of driverChats) {
                    if (channelChats[c.channel]) continue
                    channelChats[c.channel] = {
                        id: c.id,
                        channel: c.channel,
                        name: c.name,
                        lastMessageAt: c.lastMessageAt,
                        lastInboundAt: c.lastInboundAt,
                        lastOutboundAt: c.lastOutboundAt,
                        unreadCount: c.unreadCount || 0,
                        requiresResponse: !!c.requiresResponse,
                        status: c.status,
                        messages: c.messages, // last message (take: 1 above)
                        metadata: c.metadata,
                        assignedToUserId: c.assignedToUserId,
                    }
                }

                // Channel where the driver (contact) last wrote — used for badge
                // in the "Все" tab so the operator sees which channel is active,
                // rather than always seeing the primary channel (usually MAX).
                let lastInboundChannel: string | null = null
                let latestInboundAt: Date | null = null
                for (const c of driverChats) {
                    const t = c.lastInboundAt ? new Date(c.lastInboundAt) : null
                    if (t && (!latestInboundAt || t > latestInboundAt)) {
                        latestInboundAt = t
                        lastInboundChannel = c.channel
                    }
                }

                mergedEntries.push({
                    ...primary,
                    contact: primary.contact ? {
                        ...primary.contact,
                        canonicalSummary: buildCanonicalContactSummary({
                            contact: primary.contact,
                            driver: driverByYandexId.get(primary.contact.yandexDriverId) || primary.driver,
                            currentChannel: primary.channel,
                        }),
                    } : primary.contact,
                    unreadCount: allUnread,
                    requiresResponse,
                    assignedToUserId,
                    allChatIds,
                    channelMap, // { whatsapp: chatId, telegram: chatId, max: chatId }
                    channelUnread, // { whatsapp: 3, telegram: 1, ... }
                    allProfiles, // List of { channel, profileId }
                    channelChats, // { whatsapp: {chat}, telegram: {chat}, ... }
                    // For display in channel-filter tabs, keep all channels the driver has
                    allChannels: driverChats.map((c: any) => c.channel),
                    // Channel of the most recent inbound message across all channels
                    lastInboundChannel,
                })
            }

            // 4. Add ungrouped chats as-is
            for (const chat of ungroupedChats) {
                const profileId = chat.metadata?.connectionId || chat.metadata?.profileId || null
                const channelChats: Record<string, any> = {
                    [chat.channel]: {
                        id: chat.id,
                        channel: chat.channel,
                        name: chat.name,
                        lastMessageAt: chat.lastMessageAt,
                        lastInboundAt: chat.lastInboundAt,
                        lastOutboundAt: chat.lastOutboundAt,
                        unreadCount: chat.unreadCount || 0,
                        requiresResponse: !!chat.requiresResponse,
                        status: chat.status,
                        messages: chat.messages,
                        metadata: chat.metadata,
                        assignedToUserId: chat.assignedToUserId,
                    },
                }
                mergedEntries.push({
                    ...chat,
                    contact: chat.contact ? {
                        ...chat.contact,
                        canonicalSummary: buildCanonicalContactSummary({
                            contact: chat.contact,
                            driver: driverByYandexId.get(chat.contact.yandexDriverId) || chat.driver,
                            currentChannel: chat.channel,
                        }),
                    } : chat.contact,
                    allChatIds: [chat.id],
                    channelMap: { [chat.channel]: chat.id },
                    channelUnread: { [chat.channel]: chat.unreadCount || 0 },
                    allProfiles: profileId ? [{ channel: chat.channel, profileId }] : [],
                    channelChats,
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
     * Marks them 'failed' with a metadata.error explaining the reason. MAX
     * send_requested rows retain their delivery metadata and become retryable;
     * retrySend then reuses the same Message row.
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
        const stuckWhere = {
            direction: 'outbound',
            status: 'sent',
            externalId: null, // skip anything that already has a provider id
            sentAt: { lt: cutoff },
            // Call-type messages are NOT outbound text we're trying to deliver —
            // they're historical records of phone calls synced from FreeSWITCH.
            // Recovery is for stuck text messages only; touching calls clobbers
            // metadata.{callId,disposition,durationSec} which the chat timeline
            // and call-card renderer rely on.
            type: { not: 'call' },
        }
        const recoveryError = `Message stuck in 'sent' for >${maxAgeMinutes}min — marked failed by recovery`
        const stuckMaxMessages = await (prisma.message as any).findMany({
            where: { ...stuckWhere, channel: 'max' },
            select: { id: true, metadata: true },
        })
        const nonMaxResult = await (prisma.message as any).updateMany({
            where: {
                ...stuckWhere,
                OR: [{ channel: { not: 'max' } }, { channel: null }],
            },
            data: {
                status: 'failed',
                metadata: { error: recoveryError },
            },
        })
        const maxRecoveryResults = await Promise.all(stuckMaxMessages.map(async (message: any) => {
            const metadata = message.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)
                ? message.metadata
                : {}
            return (prisma.message as any).updateMany({
                where: { ...stuckWhere, channel: 'max', id: message.id },
                data: {
                    status: 'failed',
                    metadata: {
                        ...metadata,
                        error: recoveryError,
                        errorCode: 'TIMEOUT',
                        retryable: true,
                    },
                },
            })
        }))
        const maxRecoveredCount = maxRecoveryResults.reduce(
            (count: number, result: { count: number }) => count + result.count,
            0,
        )
        const recoveredCount = nonMaxResult.count + maxRecoveredCount
        if (recoveredCount > 0) {
            console.log(`[MessageService] RECOVERY: marked ${recoveredCount} stuck messages as failed`)
        }
        return recoveredCount
    }

    /**
     * Sends a message through the appropriate channel.
     */
    static async send(chatId: string, content: string, channelOverride?: ChatChannel, profileId?: string, clientMessageId?: string, quotedMsgId?: string) {
        console.log(`[MessageService] START send: chatId=${chatId}, channelOverride=${channelOverride}, clientMessageId=${clientMessageId || 'none'}`)

        const chat = await (prisma.chat as any).findUnique({
            where: { id: chatId },
            select: { 
                id: true, 
                channel: true, 
                externalChatId: true,
                metadata: true,
                contactId: true,
                contactIdentityId: true,
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

        const targetChatId = chatId
        const targetChat = chat

        // A channel switch is a distinct identity selection, not a formatting
        // option on an existing conversation. The caller must first open the
        // exact persisted ContactIdentity through the contact-conversation
        // orchestrator; never synthesize another provider peer from Driver
        // phone/telegram fields here.
        if (channelOverride && channelOverride !== chat.channel) {
            throw new Error('CONTACT_CONVERSATION_CHANNEL_MISMATCH')
        }

        const channel = targetChat.channel
        const currentChatId = targetChatId
        const outboundBinding = await prepareOutboundConversationV1(targetChat, profileId)
        const routedConnectionId = outboundBinding.connectionId
        const rawExternalChatId = outboundBinding.target
        let providerQuotedMsgId = channel === 'max' ? undefined : quotedMsgId
        let providerQuotedText: string | undefined
        let providerQuotedSentAt: string | undefined
        let providerQuotedDirection: string | undefined
        if (quotedMsgId && channel === 'max') {
            const quotedMessage = await (prisma.message as any).findFirst({
                where: {
                    chatId: currentChatId,
                    OR: [
                        { id: quotedMsgId },
                        { externalId: quotedMsgId },
                    ],
                },
                select: { externalId: true, content: true, sentAt: true, direction: true },
            })
            if (quotedMessage) {
                if (quotedMessage.externalId) providerQuotedMsgId = quotedMessage.externalId
                providerQuotedText = quotedMessage.content || undefined
                providerQuotedSentAt = quotedMessage.sentAt instanceof Date
                    ? quotedMessage.sentAt.toISOString()
                    : undefined
                providerQuotedDirection = quotedMessage.direction || undefined
            }
        }

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

        const maxBinding = targetChat.channel === 'max'
            ? {
                capability: getMaxChannelDeliveryV1(),
                isPersonal: outboundBinding.isMaxPersonal,
                providerAccountId: outboundBinding.providerAccountId,
            }
            : null

        // 2. Save message to DB first (Optimistic)
        // Use currentChatId (= targetChatId after channel switch) so that TG/WA messages
        // land in the correct channel chat and are visible when that channel tab is open.
        const messageId = `msg_${Date.now()}`
        const now = new Date()

        const created = await (prisma.message as any).create({
            data: {
                id: messageId,
                clientMessageId: clientMessageId || null,
                chatId: currentChatId,
                content,
                direction: 'outbound',
                status: 'sent',
                channel: channel,
                sentAt: now,
                type: 'text',
                ...(quotedMsgId ? { metadata: { quotedMsgId } } : {}),
            }
        })

        // Phase 4 SSE: push outbound to other CRM tabs / operator-on-phone
        // mirror so they see the reply without waiting for a poll tick.
        try {
            const { broadcastChatMessage } = await import('@/lib/messageStreamBus')
            broadcastChatMessage(currentChatId, created)
        } catch { /* bus must never break send */ }

        // 2. Deliver via Provider
        let deliveryStatus: MessageStatus = 'sent'
        let errorMessage: string | null = null
        let deliveryExternalId: string | null = null
        let maxDeliveryMetadata: any = null

        try {
            switch (channel) {
                case 'whatsapp':
                    console.log(`[MessageService] WA Send: connId=${routedConnectionId}, target=${rawExternalChatId}`)
                    await getWhatsAppChannelDeliveryV1().sendText({
                        connectionId: routedConnectionId,
                        chatId: rawExternalChatId,
                        content,
                        quotedMessageId: quotedMsgId,
                    })
                    deliveryStatus = 'delivered'
                    break
                
                case 'max':
                    if (!maxBinding) throw new Error('CONTACT_CONVERSATION_PROVIDER_ACCOUNT_UNPROVEN')
                    const isPersonal = maxBinding.isPersonal
                    const maxMetadata = (targetChat.metadata || {}) as any
                    console.log(`[MessageService] MAX Send: isPersonal=${isPersonal}, profileId=${routedConnectionId}, target=${rawExternalChatId}`)
                    const maxRes = await maxBinding.capability.sendText({
                        target: rawExternalChatId,
                        content,
                        options: {
                            providerAccountId: maxBinding.providerAccountId,
                            isPersonal,
                            connectionId: isPersonal ? undefined : routedConnectionId,
                            name: chat.driver?.fullName,
                            quotedMsgId: providerQuotedMsgId,
                            quotedText: providerQuotedText,
                            quotedSentAt: providerQuotedSentAt,
                            quotedDirection: providerQuotedDirection,
                            uiChatId: maxMetadata.oldExternalChatId || maxMetadata.uiChatId,
                            clientMessageId: clientMessageId || messageId,
                        },
                    })
                    const maxExternalId = maxRes.externalId
                    const maxDeliveryConfirmed = maxRes.outcome === 'delivered'
                    if (maxExternalId) deliveryExternalId = maxExternalId
                    deliveryStatus = maxDeliveryConfirmed ? 'delivered' : 'sent'
                    maxDeliveryMetadata = {
                        operation: 'send',
                        status: maxDeliveryConfirmed ? 'delivered' : 'send_requested',
                        deliveryConfirmed: maxDeliveryConfirmed,
                        maxMessageId: maxExternalId,
                        externalId: maxExternalId,
                        protocolChatId: rawExternalChatId,
                        webRouteId: maxMetadata.oldExternalChatId || maxMetadata.uiChatId || null,
                    }
                    console.log('[MAX_DELIVERY]', JSON.stringify({
                        operation: 'send',
                        status: maxDeliveryMetadata.status,
                        crmMessageId: messageId,
                        conversationId: currentChatId,
                        protocolChatId: rawExternalChatId,
                        webRouteId: maxDeliveryMetadata.webRouteId,
                        maxMessageId: maxDeliveryMetadata.maxMessageId,
                        externalId: maxExternalId,
                    }))
                    // Phone was resolved to conversationId by scraper echo capture.
                    // Update externalChatId so future incoming messages route here.
                    // If a chat with that conversationId already exists (duplicate scenario),
                    // merge by moving messages from old phone-based chat into it.
                    const resolvedMaxId = maxRes.resolvedChatId
                    if (resolvedMaxId && resolvedMaxId !== rawExternalChatId) {
                        if (nonEmptyString(targetChat.contactIdentityId)) {
                            // The provider response alone cannot rebind an identity-owned
                            // conversation. Preserve the delivery result, but leave all
                            // Chat/Message ownership and target state unchanged.
                            console.warn(
                                `[MessageService] MAX resolvedChatId drift ignored for identity-backed chat ${currentChatId}`,
                            )
                        } else {
                            try {
                                const conflictChat = await (prisma.chat as any).findFirst({
                                    where: { externalChatId: resolvedMaxId }
                                })
                                if (conflictChat && conflictChat.id !== currentChatId) {
                                    // Merge: move our messages into the "real" chat, delete the phone-based duplicate
                                    await (prisma.message as any).updateMany({
                                        where: { chatId: currentChatId },
                                        data:  { chatId: conflictChat.id }
                                    })
                                    await (prisma.chat as any).delete({ where: { id: currentChatId } })
                                    console.log(`[MessageService] MAX chat merged: ${currentChatId} (${rawExternalChatId}) → ${conflictChat.id} (${resolvedMaxId})`)
                                } else {
                                    await (prisma.chat as any).update({
                                        where: { id: currentChatId },
                                        data:  { externalChatId: resolvedMaxId }
                                    })
                                    console.log(`[MessageService] MAX externalChatId updated: ${rawExternalChatId} → ${resolvedMaxId}`)
                                }
                            } catch (mergeErr: any) {
                                console.warn(`[MessageService] MAX externalChatId update skipped: ${mergeErr.message}`)
                            }
                        }
                    }
                    break

                case 'telegram':
                    try {
                        const res: any = await getTelegramChannelDeliveryV1().sendText({
                            target: rawExternalChatId,
                            content,
                            connectionId: routedConnectionId,
                            metadata: { messageId, chatId: targetChat.id, quotedMsgId },
                        })
                        if (res.externalId) deliveryExternalId = String(res.externalId)
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
            if (quotedMsgId) metadata.quotedMsgId = quotedMsgId
            if (maxDeliveryMetadata) {
                metadata.maxDelivery = maxDeliveryMetadata
            }
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
                where: { id: currentChatId },
                data: { lastMessageAt: now }
            })

            // Workflow: outbound message state update
            if (deliveryStatus !== 'failed') {
                await ConversationWorkflowService.onOutboundMessage(currentChatId, now)
            }
        } catch (updErr) {
            opsLog('error', 'message_status_update_failed', { operation: 'send', chatId, error: (updErr as any)?.message })
        }

        // Only a successful exact provider delivery is reachability evidence.
        // Generic transport failures must not mark a person unreachable.
        if (deliveryStatus === 'delivered') {
            try {
                const { contactReachabilityV1 } = await import('@/modules/contacts/public/v1/contact-reachability')
                await contactReachabilityV1.recordExactProviderReachability({
                    identityId: outboundBinding.contactIdentityId,
                    contactId: outboundBinding.contactId,
                    channel: outboundBinding.channel,
                    providerAccountId: outboundBinding.providerAccountId,
                    providerTargetId: outboundBinding.identityTarget,
                    status: 'confirmed',
                })
            } catch (reachErr: any) {
                // Non-critical — delivery already completed at the provider.
                console.error(`[MessageService] Reachability update failed: ${reachErr.message}`)
            }
        }

        return {
            success: deliveryStatus !== 'failed',
            chatId: currentChatId,
            id: messageId,
            status: deliveryStatus,
            externalId: deliveryExternalId,
            deliveryConfirmed: maxDeliveryMetadata?.deliveryConfirmed,
            error: errorMessage,
        }
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

        let outboundBinding: Awaited<ReturnType<typeof prepareOutboundConversationV1>>
        try {
            outboundBinding = await prepareOutboundConversationV1(message.chat)
        } catch (error: unknown) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Conversation identity binding is invalid',
            }
        }

        const retryMaxBinding = message.channel === 'max'
            ? {
                capability: getMaxChannelDeliveryV1(),
                isPersonal: outboundBinding.isMaxPersonal,
                providerAccountId: outboundBinding.providerAccountId,
            }
            : null

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
        let retryMaxDeliveryMetadata: any = null

        try {
            const chat = message.chat
            const rawExternalId = outboundBinding.target
            const connId = outboundBinding.connectionId

            switch (message.channel) {
                case 'whatsapp': {
                    await getWhatsAppChannelDeliveryV1().sendText({
                        connectionId: connId,
                        chatId: rawExternalId,
                        content: message.content,
                    })
                    deliveryStatus = 'delivered'
                    break
                }
                case 'max': {
                    if (!retryMaxBinding) throw new Error('CONTACT_CONVERSATION_PROVIDER_ACCOUNT_UNPROVEN')
                    const maxMetadata = (chat.metadata || {}) as any
                    let retryQuotedMsgId: string | undefined
                    let retryQuotedText: string | undefined
                    let retryQuotedSentAt: string | undefined
                    let retryQuotedDirection: string | undefined
                    if (meta.quotedMsgId) {
                        const quotedMessage = await (prisma.message as any).findFirst({
                            where: {
                                chatId: message.chatId,
                                OR: [
                                    { id: meta.quotedMsgId },
                                    { externalId: meta.quotedMsgId },
                                ],
                            },
                            select: { externalId: true, content: true, sentAt: true, direction: true },
                        })
                        if (quotedMessage) {
                            if (quotedMessage.externalId) retryQuotedMsgId = quotedMessage.externalId
                            retryQuotedText = quotedMessage.content || undefined
                            retryQuotedSentAt = quotedMessage.sentAt instanceof Date
                                ? quotedMessage.sentAt.toISOString()
                                : undefined
                            retryQuotedDirection = quotedMessage.direction || undefined
                        }
                    }
                    const retryMaxRes = await retryMaxBinding.capability.sendText({
                        target: rawExternalId,
                        content: message.content,
                        options: {
                            providerAccountId: retryMaxBinding.providerAccountId,
                            isPersonal: retryMaxBinding.isPersonal,
                            connectionId: retryMaxBinding.isPersonal ? undefined : connId,
                            name: chat.driver?.fullName,
                            quotedMsgId: retryQuotedMsgId,
                            quotedText: retryQuotedText,
                            quotedSentAt: retryQuotedSentAt,
                            quotedDirection: retryQuotedDirection,
                            uiChatId: maxMetadata.oldExternalChatId || maxMetadata.uiChatId,
                            clientMessageId: message.clientMessageId || message.id,
                        },
                    })
                    const maxExternalId = retryMaxRes.externalId
                    const maxDeliveryConfirmed = retryMaxRes.outcome === 'delivered'
                    if (maxExternalId) deliveryExternalId = maxExternalId
                    deliveryStatus = maxDeliveryConfirmed ? 'delivered' : 'sent'
                    retryMaxDeliveryMetadata = {
                        operation: 'send',
                        status: maxDeliveryConfirmed ? 'delivered' : 'send_requested',
                        deliveryConfirmed: maxDeliveryConfirmed,
                        maxMessageId: maxExternalId,
                        externalId: maxExternalId,
                        protocolChatId: rawExternalId,
                        webRouteId: maxMetadata.oldExternalChatId || maxMetadata.uiChatId || null,
                    }
                    console.log('[MAX_DELIVERY]', JSON.stringify({
                        operation: 'send',
                        status: retryMaxDeliveryMetadata.status,
                        crmMessageId: messageId,
                        conversationId: message.chatId,
                        protocolChatId: rawExternalId,
                        webRouteId: retryMaxDeliveryMetadata.webRouteId,
                        maxMessageId: retryMaxDeliveryMetadata.maxMessageId,
                        externalId: maxExternalId,
                    }))
                    break
                }
                case 'telegram': {
                    const res: any = await getTelegramChannelDeliveryV1().sendText({
                        target: rawExternalId,
                        content: message.content,
                        connectionId: connId,
                        metadata: { messageId, chatId: message.chatId },
                    })
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
        if (retryMaxDeliveryMetadata) {
            retryMeta.maxDelivery = retryMaxDeliveryMetadata
        }
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

        if (deliveryStatus === 'delivered') {
            try {
                const { contactReachabilityV1 } = await import('@/modules/contacts/public/v1/contact-reachability')
                await contactReachabilityV1.recordExactProviderReachability({
                    identityId: outboundBinding.contactIdentityId,
                    contactId: outboundBinding.contactId,
                    channel: outboundBinding.channel,
                    providerAccountId: outboundBinding.providerAccountId,
                    providerTargetId: outboundBinding.identityTarget,
                    status: 'confirmed',
                })
            } catch (reachErr: any) {
                console.error(`[MessageService] Reachability update failed: ${reachErr.message}`)
            }
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
    { pattern: 'контакт не найден в max', code: 'RECIPIENT_NOT_FOUND' },
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
