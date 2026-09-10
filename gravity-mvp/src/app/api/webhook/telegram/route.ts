import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { sendTelegramBotMessage as deliverTelegramBotMessage } from '@/app/tg-bot-actions'
import { changeDriverLimit } from '@/modules/fleet-operations/public/v1/yandex-fleet-operations'
import { channelDriverMatchV1 as DriverMatchService } from '@/modules/fleet-operations/public/v1/channel-driver-match'
import { channelConversationWorkflowV1 as ConversationWorkflowService } from '@/modules/messaging/public/v1/channel-conversation-workflow'
import { operationalLogV1 as opsLog } from '@/infrastructure/operations/operational-log'
import {
    ATTACH_CONTACT_IDENTITY_COMMAND_V1,
    REPLACE_IDENTITY_PROFILE_V1,
} from '@/contracts/contacts/v1'
import {
    attachContactIdentityV1,
    isResolvedChannelContactResultV1,
    markChannelIdentityConflictV1,
    resolveChannelContactOperationV1,
} from '@/modules/contacts/public/v1'
import { PROMOTE_CHANNEL_DISPLAY_NAME_V2, RESOLVE_CONTACT_COMMAND_V2 } from '@/contracts/contacts/v2'
import { resolveContactV2 } from '@/modules/contacts/public/v2'
import { CREATE_CHANNEL_MESSAGE_COMMAND_V1, ENSURE_CONVERSATION_CONTACT_LINK_COMMAND_V1, PATCH_CHANNEL_CONVERSATION_COMMAND_V1, UPSERT_CHANNEL_CONVERSATION_COMMAND_V1, type ChannelMessageTypeV1 } from '@/contracts/messaging/v1'
import { appendConversationIdentityCollisionV1, createChannelMessageV1, ensureConversationContactLinkV1, linkMatchedDriverToConversationCapabilityV1, patchChannelConversationV1, upsertChannelConversationV1 } from '@/modules/messaging/public/v1'
import { RECORD_BOT_USER_PROFILE_COMMAND_V1 } from '@/contracts/telegram-channel/v1'
import {
    prepareManualDriverTelegramLinkAuthorityV1,
    recordBotUserProfileV1,
} from '@/modules/telegram-channel/public/v1'
import { contactReachabilityV1 } from '@/modules/contacts/public/v1/contact-reachability'

type BotUserRegistrationInput = {
    telegramId?: string | number
    username?: string | null
    firstName?: string | null
    lastName?: string | null
    phone?: string | null
    phoneVerified?: boolean
}

type TelegramIngressChat = {
    id: string
    channel: string
    externalChatId: string
    name: string | null
    chatType: string
    contactId: string | null
    contactIdentityId: string | null
    driverId: string | null
    metadata: unknown
}

type TelegramChatKind = 'private' | 'group'

function metadataRecord(metadata: unknown): Record<string, unknown> {
    return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? metadata as Record<string, unknown>
        : {}
}

function concreteOpaqueId(value: unknown): string | null {
    if (typeof value !== 'string' && typeof value !== 'number') return null
    const normalized = String(value).trim()
    return normalized !== '' && normalized !== 'legacy' ? normalized : null
}

type TelegramProviderEvent = {
    eventId: string
    updateId: string
    messageId: string | null
    callbackQueryId: string | null
}

function exactTelegramProviderEvent(input: {
    providerEventId: unknown
    providerUpdateId: unknown
    providerMessageId: unknown
    callbackQueryId: unknown
}): TelegramProviderEvent | null {
    const eventId = concreteOpaqueId(input.providerEventId)
    const updateId = concreteOpaqueId(input.providerUpdateId)
    if (!eventId || !updateId || !/^\d+$/.test(updateId) || eventId !== `update:${updateId}`) {
        return null
    }

    const messageId = input.providerMessageId === null || input.providerMessageId === undefined
        ? null
        : concreteOpaqueId(input.providerMessageId)
    const callbackQueryId = input.callbackQueryId === null || input.callbackQueryId === undefined
        ? null
        : concreteOpaqueId(input.callbackQueryId)
    if ((messageId !== null && !/^\d+$/.test(messageId)) || (!messageId && !callbackQueryId)) {
        return null
    }

    return { eventId, updateId, messageId, callbackQueryId }
}

function exactProviderTimestamp(value: unknown): Date | null {
    if (typeof value !== 'string' && typeof value !== 'number') return null
    const timestamp = new Date(value)
    return Number.isNaN(timestamp.getTime()) ? null : timestamp
}

function telegramProviderEventExternalId(
    providerAccountId: string,
    providerPeerId: string,
    providerEventId: string,
): string {
    return [
        'telegram',
        encodeURIComponent(providerAccountId),
        encodeURIComponent(providerPeerId),
        encodeURIComponent(providerEventId),
    ].join(':')
}

function telegramIngressAuthorized(req: NextRequest): boolean {
    const secret = process.env.BOT_CRM_SECRET
    return Boolean(secret && req.headers.get('x-bot-signature') === secret)
}

async function sendTelegramBotMessage(
    telegramId: string,
    text: string,
    driverId?: string,
    inlineKeyboard?: Parameters<typeof deliverTelegramBotMessage>[3],
) {
    const result = await deliverTelegramBotMessage(telegramId, text, driverId, inlineKeyboard)
    if (!result.success) {
        throw new Error(result.error || 'TELEGRAM_BOT_DELIVERY_RESULT_UNPROVEN')
    }
    return result
}

async function requireCurrentDriverTelegramAuthority(input: {
    driverId: string
    telegramId: bigint
    chatId: string
    providerAccountId: string
    connectionId: string
}): Promise<NextResponse | null> {
    try {
        const authority = await prepareManualDriverTelegramLinkAuthorityV1({
            driverId: input.driverId,
            telegramId: input.telegramId,
        })
        if (
            authority.chatId !== input.chatId
            || authority.providerAccountId !== input.providerAccountId
            || authority.connectionId !== input.connectionId
        ) {
            throw new Error('DRIVER_TELEGRAM_IDENTITY_BINDING_MISMATCH')
        }
        return null
    } catch (error: unknown) {
        opsLog('warn', 'telegram_driver_action_authority_rejected', {
            channel: 'telegram',
            chatId: input.chatId,
            driverId: input.driverId,
            error: error instanceof Error ? error.message : String(error),
        })
        return NextResponse.json({
            error: 'DRIVER_TELEGRAM_CURRENT_AUTHORITY_REQUIRED',
        }, { status: 409 })
    }
}

async function admitTelegramConversation(input: {
    externalChatId: string
    name: string
    chatKind: TelegramChatKind
    providerAccountId: string
    connectionId: string
    lastMessageAt: Date
    extraMetadata?: Record<string, unknown>
}): Promise<{ chat: TelegramIngressChat } | { response: NextResponse }> {
    const result = await upsertChannelConversationV1({
        contract: UPSERT_CHANNEL_CONVERSATION_COMMAND_V1,
        externalChatId: input.externalChatId,
        channel: 'telegram',
        name: input.name,
        chatType: input.chatKind,
        metadata: {
            ...(input.extraMetadata || {}),
            chatKind: input.chatKind,
            providerAccountId: input.providerAccountId,
            connectionId: input.connectionId,
        },
    })
    const chat = result.conversation as TelegramIngressChat
    const existingMetadata = metadataRecord(chat.metadata)
    const existingProviderAccountId = concreteOpaqueId(existingMetadata.providerAccountId)
    const existingConnectionId = concreteOpaqueId(existingMetadata.connectionId)
    const existingChatKind = chat.chatType === 'private' || chat.chatType === 'group'
        ? chat.chatType
        : existingMetadata.chatKind === 'private' || existingMetadata.chatKind === 'group'
            ? existingMetadata.chatKind
            : null
    const collisionReason = chat.channel !== 'telegram'
        ? 'channel_mismatch'
        : chat.externalChatId !== input.externalChatId
            ? 'conversation_key_mismatch'
            : existingProviderAccountId === null
                ? 'provider_account_unproven'
                : existingProviderAccountId !== input.providerAccountId
                    ? 'provider_account_mismatch'
                    : existingConnectionId === null
                        ? 'transport_connection_unproven'
                        : existingConnectionId !== input.connectionId
                            ? 'transport_connection_mismatch'
                            : existingChatKind !== input.chatKind
                                ? 'chat_kind_mismatch'
                                : null

    if (collisionReason) {
        const evidence = {
            channel: 'telegram' as const,
            reason: collisionReason,
            incomingProviderAccountId: input.providerAccountId,
            existingProviderAccountId,
            incomingConnectionId: input.connectionId,
            existingConnectionId,
            incomingChatKind: input.chatKind,
            existingChatKind,
            externalChatId: input.externalChatId,
            existingExternalChatId: chat.externalChatId,
        }
        await appendConversationIdentityCollisionV1({
            chatId: chat.id,
            evidence,
        })
        if (chat.contactId && chat.contactIdentityId) {
            await markChannelIdentityConflictV1({
                contactId: chat.contactId,
                identityId: chat.contactIdentityId,
                channel: 'telegram',
                reason: collisionReason,
                evidenceRoot: `channel-collision:telegram:${chat.externalChatId}:${input.providerAccountId}:${input.connectionId}:${collisionReason}`,
                details: {
                    incomingProviderAccountId: input.providerAccountId,
                    existingProviderAccountId,
                    incomingConnectionId: input.connectionId,
                    existingConnectionId,
                    incomingChatKind: input.chatKind,
                    existingChatKind,
                },
            })
        }
        const error = collisionReason === 'provider_account_mismatch'
            ? 'TELEGRAM_PROVIDER_ACCOUNT_COLLISION'
            : collisionReason === 'provider_account_unproven'
                ? 'TELEGRAM_PROVIDER_ACCOUNT_UNPROVEN'
                : collisionReason === 'transport_connection_mismatch'
                    ? 'TELEGRAM_TRANSPORT_CONNECTION_COLLISION'
                    : collisionReason === 'transport_connection_unproven'
                        ? 'TELEGRAM_TRANSPORT_CONNECTION_UNPROVEN'
                        : collisionReason === 'chat_kind_mismatch'
                            ? 'TELEGRAM_CHAT_KIND_COLLISION'
                            : 'TELEGRAM_CONVERSATION_COLLISION'
        return { response: NextResponse.json({ error }, { status: 409 }) }
    }

    const patched = await patchChannelConversationV1({
        contract: PATCH_CHANNEL_CONVERSATION_COMMAND_V1,
        selector: { chatId: chat.id },
        patch: { lastMessageAt: input.lastMessageAt, name: input.name },
    })
    return { chat: patched.conversation as TelegramIngressChat }
}

function optionalProfileValue(value: unknown) {
    return typeof value === 'string' && value.trim() ? value.trim() : null
}

async function registerBotUser(req: NextRequest, payload: BotUserRegistrationInput) {
    const secret = process.env.BOT_CRM_SECRET
    if (!secret || req.headers.get('x-bot-signature') !== secret) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const telegramId = String(payload.telegramId || '').trim()
    if (!/^\d+$/.test(telegramId) || telegramId === '0') {
        return NextResponse.json({ error: 'Missing or invalid telegramId' }, { status: 400 })
    }

    const phone = optionalProfileValue(payload.phone)
    const telegramIdBigInt = BigInt(telegramId)
    await recordBotUserProfileV1({
        contract: RECORD_BOT_USER_PROFILE_COMMAND_V1,
        telegramId: telegramIdBigInt,
        username: optionalProfileValue(payload.username),
        firstName: optionalProfileValue(payload.firstName),
        lastName: optionalProfileValue(payload.lastName),
        phone,
        phoneVerified: Boolean(phone && payload.phoneVerified === true),
        observedAt: new Date(),
    })

    const mapping = await prisma.driverTelegram.findFirst({
        where: { telegramId: telegramIdBigInt },
        select: { driverId: true, username: true },
    })
    if (!mapping) {
        return NextResponse.json({ success: true, linked: false, status: 'PENDING_MANAGER_LINK' })
    }
    return NextResponse.json({
        success: true,
        linked: true,
        driverId: mapping.driverId,
        driverName: mapping.username,
    })
}

export async function POST(req: NextRequest) {
    try {
        const body = await req.json()
        if (body?.action === 'register_bot_user') {
            return registerBotUser(req, (body.payload || {}) as BotUserRegistrationInput)
        }
        if (!telegramIngressAuthorized(req)) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }
        console.log(`[WEBHOOK-TG] Received:`, JSON.stringify(body))

        // Structure expected from Bot's webhook payload
        const { telegramId, text, direction, username, timestamp, providerAccountId, connectionId,
                providerEventId, providerUpdateId, providerMessageId, callbackQueryId,
                chatType, chatId: tgChatId, chatTitle,
                firstName, lastName,
                attachments } = body  // PR-Ц: media attachments from tg-bot

        const telegramIdString = concreteOpaqueId(telegramId)
        if (!telegramIdString || !/^\d+$/.test(telegramIdString) || telegramIdString === '0' || !text) {
            return NextResponse.json({ error: 'Missing required fields: telegramId, text' }, { status: 400 })
        }
        const telegramProviderAccountId = concreteOpaqueId(providerAccountId)
        if (!telegramProviderAccountId) {
            return NextResponse.json({ error: 'Missing or invalid providerAccountId' }, { status: 400 })
        }
        const telegramConnectionId = concreteOpaqueId(connectionId)
        if (!telegramConnectionId) {
            return NextResponse.json({ error: 'Missing or invalid connectionId' }, { status: 400 })
        }
        const telegramProviderEvent = exactTelegramProviderEvent({
            providerEventId,
            providerUpdateId,
            providerMessageId,
            callbackQueryId,
        })
        if (!telegramProviderEvent) {
            return NextResponse.json({ error: 'Missing or invalid Telegram provider event identity' }, { status: 400 })
        }
        const sentAt = exactProviderTimestamp(timestamp)
        if (!sentAt) {
            return NextResponse.json({ error: 'Missing or invalid provider timestamp' }, { status: 400 })
        }

        // ── GROUP BRANCH: route group/supergroup/channel messages separately ──
        const isGroup = chatType && chatType !== 'private'
        if (isGroup) {
            if (!concreteOpaqueId(tgChatId)) {
                return NextResponse.json({ error: 'Missing or invalid chatId for group message' }, { status: 400 })
            }
            const groupExternalId = `telegram:group:${tgChatId}`

            const admission = await admitTelegramConversation({
                externalChatId: groupExternalId,
                name: chatTitle || `TG Group ${tgChatId}`,
                chatKind: 'group',
                providerAccountId: telegramProviderAccountId,
                connectionId: telegramConnectionId,
                lastMessageAt: sentAt,
                extraMetadata: { chatTitle, chatType },
            })
            if ('response' in admission) return admission.response
            const unifiedChat = admission.chat
            const providerPeerId = String(tgChatId)
            const messageExternalId = telegramProviderEventExternalId(
                telegramProviderAccountId,
                providerPeerId,
                telegramProviderEvent.eventId,
            )
            const existing = await prisma.message.findFirst({
                where: { chatId: unifiedChat.id, externalId: messageExternalId },
                select: { id: true },
            })
            if (existing) {
                return NextResponse.json({ success: true, processed: 'duplicate_provider_event' })
            }

            // senderName priority: firstName > username > fallback ID
            const senderDisplay = firstName
                ? (lastName ? `${firstName} ${lastName}` : firstName)
                : (username ? `@${username}` : `User ${telegramIdString}`)

            await createChannelMessageV1({
                contract: CREATE_CHANNEL_MESSAGE_COMMAND_V1,
                chatId: unifiedChat.id,
                direction: direction === 'OUTGOING' ? 'outbound' : 'inbound',
                content: text,
                channel: 'telegram',
                type: 'text',
                sentAt,
                status: 'delivered',
                externalId: messageExternalId,
                metadata: {
                    senderId: telegramIdString,
                    senderName: senderDisplay,
                    senderUsername: username || null,
                    providerAccountId: telegramProviderAccountId,
                    connectionId: telegramConnectionId,
                    providerPeerId,
                    providerEventId: telegramProviderEvent.eventId,
                    providerUpdateId: telegramProviderEvent.updateId,
                    providerMessageId: telegramProviderEvent.messageId,
                    callbackQueryId: telegramProviderEvent.callbackQueryId,
                },
            })

            // Lightweight workflow: only unreadCount + lastInboundAt (no requiresResponse, no status transition)
            if (direction !== 'OUTGOING') {
                await ConversationWorkflowService.onGroupInboundMessage(unifiedChat.id, sentAt)
            }

            console.log(`[WEBHOOK-TG] GROUP chatId=${unifiedChat.id} type=${chatType} title=${chatTitle} sender=${senderDisplay}`)
            return NextResponse.json({ success: true, processed: 'group_message' })
        }
        // ── END GROUP BRANCH ──

        const tgIdBigInt = BigInt(telegramIdString)
        const externalChatId = `telegram:${telegramIdString}`

        // Chat.name priority: @username > real name > Telegram id.
        const tgDisplayName = (() => {
            if (username) return `@${username}`
            const fn = (firstName ?? '').trim()
            const ln = (lastName ?? '').trim()
            const fullName = [fn, ln].filter(Boolean).join(' ').trim()
            const hasRealName = /[А-Яа-яA-Za-z]/.test(fullName) && !/^[.\s\-_$]+$/.test(fullName)
            if (hasRealName) return fullName
            if (fullName) return fullName
            return `TG ${telegramIdString}`
        })()

        const admission = await admitTelegramConversation({
            externalChatId,
            name: tgDisplayName,
            chatKind: 'private',
            providerAccountId: telegramProviderAccountId,
            connectionId: telegramConnectionId,
            lastMessageAt: sentAt,
        })
        if ('response' in admission) return admission.response
        let unifiedChat = admission.chat
        const messageExternalId = telegramProviderEventExternalId(
            telegramProviderAccountId,
            telegramIdString,
            telegramProviderEvent.eventId,
        )
        const existingProviderEvent = await prisma.message.findFirst({
            where: { chatId: unifiedChat.id, externalId: messageExternalId },
            select: { id: true },
        })
        if (existingProviderEvent) {
            return NextResponse.json({ success: true, processed: 'duplicate_provider_event' })
        }
        let message: { id: string }

        // Also save to the unified Messenger chat/message tables
        // so inbound TG messages appear in the CRM Messenger UI
        try {
            // ── Contact Model dual write ──────────────────────────────
            try {
                // PR-А: Contact.displayName тоже приоритет — real name > @username
                const contactResult = await resolveChannelContactOperationV1(
                    'telegram',
                    telegramIdString,
                    null,  // Bot webhook не передаёт номер телефона
                    tgDisplayName === `TG ${telegramIdString}` ? null : tgDisplayName,
                    { chatKind: 'private', providerAccountId: telegramProviderAccountId },
                )
                if (!isResolvedChannelContactResultV1(contactResult) || !contactResult.identity) {
                    throw new Error(`CONTACT_RESOLUTION_BLOCKED:${contactResult.status}`)
                }
                await ensureConversationContactLinkV1({
                    contract: ENSURE_CONVERSATION_CONTACT_LINK_COMMAND_V1,
                    chatId: unifiedChat.id,
                    contactId: contactResult.contact.id,
                    contactIdentityId: contactResult.identity.id,
                })
                if (direction !== 'OUTGOING') {
                    await contactReachabilityV1.recordExactProviderReachability({
                        identityId: contactResult.identity.id,
                        contactId: contactResult.contact.id,
                        channel: 'telegram',
                        providerAccountId: telegramProviderAccountId,
                        providerTargetId: telegramIdString,
                        status: 'confirmed',
                    })
                }
                // Provider-specific DriverMatch evidence may only project a
                // Driver after the Chat has an exact ContactIdentity owner; the
                // Messaging adapter then requires Contacts' durable canonical
                // Driver confirmation before changing Chat.driverId.
                if (!unifiedChat.driverId) {
                    const linked = await DriverMatchService.linkChatToDriver(
                        unifiedChat.id,
                        { telegramId: telegramIdString },
                        linkMatchedDriverToConversationCapabilityV1,
                    )
                    if (linked) {
                        const refreshedChat = await prisma.chat.findUnique({ where: { id: unifiedChat.id } })
                        if (!refreshedChat) throw new Error('TELEGRAM_CHAT_DISAPPEARED')
                        unifiedChat = refreshedChat
                    }
                    console.log(`[WEBHOOK-TG] RELINK chat=${unifiedChat.id} driver=${unifiedChat.driverId || 'none'} linked=${linked}`)
                }
                // For existing contacts with auto-set name (source=channel), update to @username
                // so the header immediately reflects the username instead of old first_name.
                // Does NOT touch contacts edited manually (displayNameSource = 'manual' or 'yandex').
                if (!contactResult.isNew && username && tgDisplayName.startsWith('@')) {
                    await resolveContactV2({
                        contract: RESOLVE_CONTACT_COMMAND_V2,
                        operation: PROMOTE_CHANNEL_DISPLAY_NAME_V2,
                        contactId: contactResult.contact.id,
                        candidateDisplayName: tgDisplayName,
                    })
                }
                // Store username + name in identity metadata so the profile can show "Name (@username)"
                await attachContactIdentityV1({
                    contract: ATTACH_CONTACT_IDENTITY_COMMAND_V1,
                    operation: REPLACE_IDENTITY_PROFILE_V1,
                    identityId: contactResult.identity.id,
                    profile: {
                        handle: username || null,
                        givenName: firstName || null,
                        familyName: lastName || null,
                    },
                })
            } catch (contactErr: unknown) {
                const contactErrorMessage = contactErr instanceof Error ? contactErr.message : String(contactErr)
                opsLog('warn', 'webhook_telegram_contact_binding_blocked', {
                    channel: 'telegram',
                    chatId: unifiedChat.id,
                    providerAccountId: telegramProviderAccountId,
                    error: contactErrorMessage,
                })
                return NextResponse.json({ error: 'TELEGRAM_CONTACT_BINDING_BLOCKED' }, { status: 409 })
            }
            // ──────────────────────────────────────────────────────────

            await recordBotUserProfileV1({
                contract: RECORD_BOT_USER_PROFILE_COMMAND_V1,
                telegramId: tgIdBigInt,
                username: username || null,
                firstName: firstName || null,
                lastName: lastName || null,
                phone: null,
                phoneVerified: false,
                observedAt: sentAt,
            })

            // Add the message to the legacy Telegram history only after the
            // exact Chat/Contact ownership admission has succeeded.
            message = await prisma.botChatMessage.create({
                data: {
                    telegramId: tgIdBigInt,
                    text,
                    direction: direction || 'INCOMING'
                }
            })

            const msgDirection = direction === 'OUTGOING' ? 'outbound' : 'inbound'
            // PR-Ц: определяем тип сообщения по первому attachment.
            // text → текст без медиа; image/video/voice/audio/document/sticker → media-сообщение.
            const firstAtt = Array.isArray(attachments) && attachments.length > 0 ? attachments[0] : null
            const firstAttachmentType = firstAtt && typeof firstAtt === 'object'
                ? (firstAtt as Record<string, unknown>).type
                : null
            const supportedMessageTypes = new Set<ChannelMessageTypeV1>([
                'text', 'image', 'audio', 'video', 'sticker', 'voice', 'document',
            ])
            const msgType: ChannelMessageTypeV1 = typeof firstAttachmentType === 'string'
                && supportedMessageTypes.has(firstAttachmentType as ChannelMessageTypeV1)
                ? firstAttachmentType as ChannelMessageTypeV1
                : 'text'
            const msgMetadata: Record<string, unknown> = {
                providerAccountId: telegramProviderAccountId,
                connectionId: telegramConnectionId,
                providerPeerId: telegramIdString,
                providerEventId: telegramProviderEvent.eventId,
                providerUpdateId: telegramProviderEvent.updateId,
                providerMessageId: telegramProviderEvent.messageId,
                callbackQueryId: telegramProviderEvent.callbackQueryId,
            }
            if (Array.isArray(attachments) && attachments.length > 0) {
                msgMetadata.attachments = attachments
            }
            await createChannelMessageV1({ contract: CREATE_CHANNEL_MESSAGE_COMMAND_V1, chatId: unifiedChat.id, direction: msgDirection, content: text, channel: 'telegram', type: msgType, sentAt, status: 'delivered', externalId: messageExternalId, metadata: msgMetadata })

            // Workflow: update status/unread/requiresResponse
            if (msgDirection === 'inbound') {
                await ConversationWorkflowService.onInboundMessage(unifiedChat.id, sentAt)
            } else {
                await ConversationWorkflowService.onOutboundMessage(unifiedChat.id, sentAt)
            }

            console.log(`[WEBHOOK-TG] SAVED channel=telegram chatId=${unifiedChat.id} driverId=${unifiedChat.driverId || 'none'} dir=${direction} text="${text.substring(0, 30)}"`)
        } catch (unifiedErr: unknown) {
            const unifiedErrorMessage = unifiedErr instanceof Error ? unifiedErr.message : String(unifiedErr)
            opsLog('error', 'webhook_telegram_save_failed', { channel: 'telegram', error: unifiedErrorMessage })
            return NextResponse.json({ error: 'TELEGRAM_INGRESS_PERSISTENCE_FAILED' }, { status: 500 })
        }

        // Try to find if user is a linked driver
        const driverTg = await prisma.driverTelegram.findUnique({
            where: { telegramId: tgIdBigInt }
        })

        // ====== STATE MACHINE FOR "CHANGE LIMIT" ======

        // Trigger: User clicked "💳 Управление лимитом" in the bot menu
        if (text === '💳 Управление лимитом') {
            if (!driverTg || !driverTg.phoneVerified || !driverTg.driverId) {
                await sendTelegramBotMessage(
                    telegramId,
                    '❌ Чтобы управлять лимитом, ваш профиль должен быть привязан к парку. ' +
                    'Пожалуйста, используйте кнопку "🚗 Подключиться" и поделитесь контактом.'
                );
                return NextResponse.json({ success: true, processed: 'not_found' });
            }

            const authorityFailure = await requireCurrentDriverTelegramAuthority({
                driverId: driverTg.driverId,
                telegramId: tgIdBigInt,
                chatId: unifiedChat.id,
                providerAccountId: telegramProviderAccountId,
                connectionId: telegramConnectionId,
            })
            if (authorityFailure) return authorityFailure

            // Update state to AWAITING_LIMIT
            await prisma.driverTelegram.update({
                where: { id: driverTg.id },
                data: { botState: 'AWAITING_LIMIT' }
            });

            // Build inline keyboard for quick selection
            const inlineKeyboard = [
                [
                    { text: '0 руб', callback_data: 'limit_0' },
                    { text: '20 000 руб', callback_data: 'limit_20000' }
                ],
                [
                    { text: '50 000 руб', callback_data: 'limit_50000' }
                ],
                [
                    { text: 'Ввести вручную', callback_data: 'limit_custom' }
                ]
            ];

            await sendTelegramBotMessage(
                telegramId,
                '💳 *Управление лимитом*\n\nВыберите новое значение лимита для вашего баланса или введите его вручную ответным сообщением (только положительное число):',
                driverTg.driverId,
                inlineKeyboard
            );

            return NextResponse.json({ success: true, processed: 'limit_menu_sent' });
        }

        // Handle states if driver exists
        if (driverTg) {
            const continueLimitFlow = driverTg.botState === 'AWAITING_LIMIT'
                && !text.startsWith('/')
            if (continueLimitFlow) {
                if (!driverTg.phoneVerified || !driverTg.driverId) {
                    return NextResponse.json({
                        error: 'DRIVER_TELEGRAM_CURRENT_AUTHORITY_REQUIRED',
                    }, { status: 409 })
                }
                const authorityFailure = await requireCurrentDriverTelegramAuthority({
                    driverId: driverTg.driverId,
                    telegramId: tgIdBigInt,
                    chatId: unifiedChat.id,
                    providerAccountId: telegramProviderAccountId,
                    connectionId: telegramConnectionId,
                })
                if (authorityFailure) return authorityFailure
            }

            // If user clicked an inline button for limit
            if (driverTg.botState === 'AWAITING_LIMIT' && text.startsWith('limit_')) {
                const action = text.replace('limit_', '');

                if (action === 'custom') {
                    // Send prompt for manual input
                    await sendTelegramBotMessage(telegramId, '✏️ Введите новую сумму лимита числом (например: 15000):');
                    return NextResponse.json({ success: true, processed: 'asked_custom_limit' });
                }

                const limitValue = parseInt(action, 10);
                if (!isNaN(limitValue) && limitValue >= 0) {
                    await sendTelegramBotMessage(telegramId, `⏳ Обновляем лимит до ${limitValue} руб...`);

                    const authorityFailure = await requireCurrentDriverTelegramAuthority({
                        driverId: driverTg.driverId,
                        telegramId: tgIdBigInt,
                        chatId: unifiedChat.id,
                        providerAccountId: telegramProviderAccountId,
                        connectionId: telegramConnectionId,
                    })
                    if (authorityFailure) return authorityFailure

                    // Call Yandex API (mocked/integrated in actions.ts)
                    const result = await changeDriverLimit(driverTg.driverId, limitValue);

                    if (result.success) {
                        await sendTelegramBotMessage(telegramId, `✅ Ваш лимит успешно изменен на *${limitValue} руб.*`);
                    } else {
                        await sendTelegramBotMessage(telegramId, `❌ Ошибка при изменении лимита: ${result.error}`);
                    }

                    // Reset state
                    const resetAuthorityFailure = await requireCurrentDriverTelegramAuthority({
                        driverId: driverTg.driverId,
                        telegramId: tgIdBigInt,
                        chatId: unifiedChat.id,
                        providerAccountId: telegramProviderAccountId,
                        connectionId: telegramConnectionId,
                    })
                    if (resetAuthorityFailure) return resetAuthorityFailure
                    await prisma.driverTelegram.update({
                        where: { id: driverTg.id },
                        data: { botState: 'IDLE' }
                    });

                    return NextResponse.json({ success: true, processed: 'limit_updated' });
                }
            }

            // Handle manual input text for custom limit
            if (driverTg.botState === 'AWAITING_LIMIT' && !text.startsWith('/')) {
                // Parse the text as a number
                const sanitizedText = text.replace(/\s/g, ''); // strip spaces, e.g., "15 000" -> "15000"
                const limitValue = parseInt(sanitizedText, 10);

                if (!isNaN(limitValue) && limitValue >= 0) {
                    await sendTelegramBotMessage(telegramId, `⏳ Обновляем лимит до ${limitValue} руб...`);

                    const authorityFailure = await requireCurrentDriverTelegramAuthority({
                        driverId: driverTg.driverId,
                        telegramId: tgIdBigInt,
                        chatId: unifiedChat.id,
                        providerAccountId: telegramProviderAccountId,
                        connectionId: telegramConnectionId,
                    })
                    if (authorityFailure) return authorityFailure

                    // Call Yandex API
                    const result = await changeDriverLimit(driverTg.driverId, limitValue);

                    if (result.success) {
                        await sendTelegramBotMessage(telegramId, `✅ Ваш лимит успешно изменен на *${limitValue} руб.*`);
                    } else {
                        await sendTelegramBotMessage(telegramId, `❌ Ошибка при изменении лимита: ${result.error}`);
                    }

                    // Reset state
                    const resetAuthorityFailure = await requireCurrentDriverTelegramAuthority({
                        driverId: driverTg.driverId,
                        telegramId: tgIdBigInt,
                        chatId: unifiedChat.id,
                        providerAccountId: telegramProviderAccountId,
                        connectionId: telegramConnectionId,
                    })
                    if (resetAuthorityFailure) return resetAuthorityFailure
                    await prisma.driverTelegram.update({
                        where: { id: driverTg.id },
                        data: { botState: 'IDLE' }
                    });

                    return NextResponse.json({ success: true, processed: 'limit_updated_custom' });
                } else if (limitValue < 0) {
                    await sendTelegramBotMessage(telegramId, `❌ Отрицательные значения недопустимы. Пожалуйста, введите положительное число.`);
                    return NextResponse.json({ success: true, processed: 'invalid_negative' });
                } else {
                    await sendTelegramBotMessage(telegramId, `❌ Пожалуйста, введите корректное число (например: 15000):`);
                    return NextResponse.json({ success: true, processed: 'invalid_format' });
                }
            }
        }

        // Default response object for tracking
        const responseData = {
            id: message.id,
            telegramId: telegramId // Use the original string/number from the request
        }

        return NextResponse.json({ success: true, message: responseData })

    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        console.error('[WEBHOOK ERROR]:', error)
        return NextResponse.json({ error: 'Internal server error', details: errorMessage }, { status: 500 })
    }
}
