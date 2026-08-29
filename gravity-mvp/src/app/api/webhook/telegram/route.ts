import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { sendTelegramBotMessage } from '@/app/tg-bot-actions'
import { changeDriverLimit } from '@/modules/fleet-operations/public/v1/yandex-fleet-operations'
import { channelDriverMatchV1 as DriverMatchService } from '@/modules/fleet-operations/public/v1/channel-driver-match'
import { channelConversationWorkflowV1 as ConversationWorkflowService } from '@/modules/messaging/public/v1/channel-conversation-workflow'
import { operationalLogV1 as opsLog } from '@/infrastructure/operations/operational-log'
import {
    ATTACH_CONTACT_IDENTITY_COMMAND_V1,
    REPLACE_IDENTITY_PROFILE_V1,
} from '@/contracts/contacts/v1'
import { attachContactIdentityV1, resolveChannelContactOperationV1 } from '@/modules/contacts/public/v1'
import { PROMOTE_CHANNEL_DISPLAY_NAME_V2, RESOLVE_CONTACT_COMMAND_V2 } from '@/contracts/contacts/v2'
import { resolveContactV2 } from '@/modules/contacts/public/v2'
import { CREATE_CHANNEL_MESSAGE_COMMAND_V1, ENSURE_CONVERSATION_CONTACT_LINK_COMMAND_V1, PATCH_CHANNEL_CONVERSATION_COMMAND_V1, UPSERT_CHANNEL_CONVERSATION_COMMAND_V1 } from '@/contracts/messaging/v1'
import { createChannelMessageV1, ensureConversationContactLinkV1, linkMatchedDriverToConversationCapabilityV1, patchChannelConversationV1, upsertChannelConversationV1 } from '@/modules/messaging/public/v1'
import { RECORD_BOT_USER_PROFILE_COMMAND_V1 } from '@/contracts/telegram-channel/v1'
import { recordBotUserProfileV1 } from '@/modules/telegram-channel/public/v1'

export async function POST(req: NextRequest) {
    try {
        const body = await req.json()
        console.log(`[WEBHOOK-TG] Received:`, JSON.stringify(body))

        // Structure expected from Bot's webhook payload
        const { telegramId, text, direction, username, timestamp,
                chatType, chatId: tgChatId, chatTitle,
                firstName, lastName,
                attachments } = body  // PR-Ц: media attachments from tg-bot

        if (!telegramId || !text) {
            return NextResponse.json({ error: 'Missing required fields: telegramId, text' }, { status: 400 })
        }

        // ── GROUP BRANCH: route group/supergroup/channel messages separately ──
        const isGroup = chatType && chatType !== 'private'
        if (isGroup) {
            const sentAt = timestamp ? new Date(timestamp) : new Date()
            const groupExternalId = `telegram:group:${tgChatId}`

            let unifiedChat = (await upsertChannelConversationV1({ contract: UPSERT_CHANNEL_CONVERSATION_COMMAND_V1, externalChatId: groupExternalId, channel: 'telegram', chatType: 'group', name: chatTitle || `TG Group ${tgChatId}`, metadata: { chatTitle, chatType } })).conversation as any
            await patchChannelConversationV1({ contract: PATCH_CHANNEL_CONVERSATION_COMMAND_V1, selector: { chatId: unifiedChat.id }, patch: { lastMessageAt: sentAt } })

            // senderName priority: firstName > username > fallback ID
            const senderDisplay = firstName
                ? (lastName ? `${firstName} ${lastName}` : firstName)
                : (username ? `@${username}` : `User ${telegramId}`)

            await createChannelMessageV1({ contract: CREATE_CHANNEL_MESSAGE_COMMAND_V1, chatId: unifiedChat.id, direction: direction === 'OUTGOING' ? 'outbound' : 'inbound', content: text, channel: 'telegram', type: 'text', sentAt, status: 'delivered', externalId: `telegram:group:${tgChatId}:${sentAt.getTime()}`, metadata: { senderId: telegramId.toString(), senderName: senderDisplay, senderUsername: username || null } })

            // Lightweight workflow: only unreadCount + lastInboundAt (no requiresResponse, no status transition)
            if (direction !== 'OUTGOING') {
                await ConversationWorkflowService.onGroupInboundMessage(unifiedChat.id, sentAt)
            }

            console.log(`[WEBHOOK-TG] GROUP chatId=${unifiedChat.id} type=${chatType} title=${chatTitle} sender=${senderDisplay}`)
            return NextResponse.json({ success: true, processed: 'group_message' })
        }
        // ── END GROUP BRANCH ──

        const tgIdBigInt = BigInt(telegramId)

        await recordBotUserProfileV1({
            contract: RECORD_BOT_USER_PROFILE_COMMAND_V1,
            telegramId: tgIdBigInt,
            username: username || null,
            firstName: firstName || null,
            lastName: lastName || null,
            phone: null,
            phoneVerified: false,
            observedAt: new Date(),
        })

        // Add the message to the DB for the CRM history
        const message = await prisma.botChatMessage.create({
            data: {
                telegramId: tgIdBigInt,
                text,
                direction: direction || 'INCOMING'
            }
        })

        // Also save to the unified Messenger chat/message tables
        // so inbound TG messages appear in the CRM Messenger UI
        try {
            const externalChatId = `telegram:${telegramId.toString()}`

            // USE BOT TIMESTAMP FOR STABLE SORTING
            const sentAt = timestamp ? new Date(timestamp) : new Date()

            // Chat.name приоритет — @username > REAL name > TG id.
            // @username уникален для аккаунта и стабилен; first_name может быть
            // "Check", "Тест", "." и т.п. Оператор всегда может поставить ФИО
            // через карандаш в профиле (displayNameSource = 'manual').
            const tgDisplayName = (() => {
                if (username) return `@${username}`
                const fn = (firstName ?? '').trim()
                const ln = (lastName  ?? '').trim()
                const fullName = [fn, ln].filter(Boolean).join(' ').trim()
                const hasRealName = /[А-Яа-яA-Za-z]/.test(fullName) && !/^[.\s\-_$]+$/.test(fullName)
                if (hasRealName) return fullName
                if (fullName)    return fullName
                return `TG ${telegramId}`
            })()

            // RETRY LOOP FOR UPSERT (concurrency protection)
            let unifiedChat;
            let retries = 3;
            while (retries > 0) {
                try {
                    unifiedChat = (await upsertChannelConversationV1({ contract: UPSERT_CHANNEL_CONVERSATION_COMMAND_V1, externalChatId, channel: 'telegram', name: tgDisplayName, chatType: 'private', metadata: {} })).conversation as any
                    await patchChannelConversationV1({ contract: PATCH_CHANNEL_CONVERSATION_COMMAND_V1, selector: { chatId: unifiedChat.id }, patch: { lastMessageAt: sentAt, name: tgDisplayName } })
                    break; // Success
                } catch (e: any) {
                    retries--;
                    if (retries === 0) throw e;
                    console.warn(`[WEBHOOK-TG] Upsert retry due to concurrency: ${e.message}`)
                    await new Promise(r => setTimeout(r, 50 * (3 - retries))) // Backoff
                }
            }

            if (!unifiedChat) throw new Error('Failed to obtain unifiedChat');

            // Relink driver on every inbound if missing
            if (!unifiedChat.driverId) {
                const linked = await DriverMatchService.linkChatToDriver(unifiedChat.id, { telegramId: telegramId.toString() }, linkMatchedDriverToConversationCapabilityV1)
                if (linked) {
                    unifiedChat = await (prisma.chat as any).findUnique({ where: { id: unifiedChat.id } })
                }
                console.log(`[WEBHOOK-TG] RELINK chat=${unifiedChat.id} driver=${unifiedChat.driverId || 'none'} linked=${linked}`)
            }

            // ── Contact Model dual write ──────────────────────────────
            try {
                // PR-А: Contact.displayName тоже приоритет — real name > @username
                const contactResult = await resolveChannelContactOperationV1(
                    'telegram',
                    telegramId.toString(),
                    null,  // Bot webhook не передаёт номер телефона
                    tgDisplayName === `TG ${telegramId}` ? null : tgDisplayName,
                )
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
                await ensureConversationContactLinkV1({
                    contract: ENSURE_CONVERSATION_CONTACT_LINK_COMMAND_V1,
                    chatId: unifiedChat.id,
                    contactId: contactResult.contact.id,
                    contactIdentityId: contactResult.identity.id,
                })
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
            } catch (contactErr: any) {
                console.error(`[WEBHOOK-TG] ContactService error (non-blocking): ${contactErr.message}`)
            }
            // ──────────────────────────────────────────────────────────

            // DE-DUPLICATION: check if we already have this message (echo from bot)
            // Increased window for burst protection
            const existing = await (prisma.message as any).findFirst({
                where: {
                    chatId: unifiedChat.id,
                    content: text,
                    direction: direction === 'OUTGOING' ? 'outbound' : 'inbound',
                    sentAt: {
                        gte: new Date(sentAt.getTime() - 20000), 
                        lte: new Date(sentAt.getTime() + 20000)
                    }
                }
            })

            if (!existing) {
                const msgDirection = direction === 'OUTGOING' ? 'outbound' : 'inbound'
                // PR-Ц: определяем тип сообщения по первому attachment.
                // text → текст без медиа; image/video/voice/audio/document/sticker → media-сообщение.
                const firstAtt = Array.isArray(attachments) && attachments.length > 0 ? attachments[0] : null
                const msgType = firstAtt?.type || 'text'
                const msgMetadata: any = {}
                if (Array.isArray(attachments) && attachments.length > 0) {
                    msgMetadata.attachments = attachments
                }
                await createChannelMessageV1({ contract: CREATE_CHANNEL_MESSAGE_COMMAND_V1, chatId: unifiedChat.id, direction: msgDirection, content: text, channel: 'telegram', type: msgType as any, sentAt, status: 'delivered', externalId: `telegram:${telegramId}:${sentAt.getTime()}`, metadata: msgMetadata })

                // Workflow: update status/unread/requiresResponse
                if (msgDirection === 'inbound') {
                    await ConversationWorkflowService.onInboundMessage(unifiedChat.id, sentAt)
                } else {
                    await ConversationWorkflowService.onOutboundMessage(unifiedChat.id, sentAt)
                }

                console.log(`[WEBHOOK-TG] SAVED channel=telegram chatId=${unifiedChat.id} driverId=${unifiedChat.driverId || 'none'} dir=${direction} text="${text.substring(0, 30)}"`)
            } else {
                console.log(`[WEBHOOK-TG] DB-DEDUP channel=telegram chatId=${unifiedChat.id} existing=${existing.id}`)
            }
        } catch (unifiedErr: any) {
            opsLog('error', 'webhook_telegram_save_failed', { channel: 'telegram', error: unifiedErr.message })
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

                    // Call Yandex API (mocked/integrated in actions.ts)
                    const result = await changeDriverLimit(driverTg.driverId, limitValue);

                    if (result.success) {
                        await sendTelegramBotMessage(telegramId, `✅ Ваш лимит успешно изменен на *${limitValue} руб.*`);
                    } else {
                        await sendTelegramBotMessage(telegramId, `❌ Ошибка при изменении лимита: ${result.error}`);
                    }

                    // Reset state
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

                    // Call Yandex API
                    const result = await changeDriverLimit(driverTg.driverId, limitValue);

                    if (result.success) {
                        await sendTelegramBotMessage(telegramId, `✅ Ваш лимит успешно изменен на *${limitValue} руб.*`);
                    } else {
                        await sendTelegramBotMessage(telegramId, `❌ Ошибка при изменении лимита: ${result.error}`);
                    }

                    // Reset state
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

    } catch (error: any) {
        console.error('[WEBHOOK ERROR]:', error)
        return NextResponse.json({ error: 'Internal server error', details: error.message }, { status: 500 })
    }
}
