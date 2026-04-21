import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { sendTelegramBotMessage } from '@/app/tg-bot-actions'
import { changeDriverLimit } from '@/app/actions'
import { DriverMatchService } from '@/lib/DriverMatchService'
import { ContactService } from '@/lib/ContactService'
import { ConversationWorkflowService } from '@/lib/ConversationWorkflowService'
import { opsLog } from '@/lib/opsLog'

export async function POST(req: NextRequest) {
    try {
        const body = await req.json()
        console.log(`[WEBHOOK-TG] Received:`, JSON.stringify(body))

        // Structure expected from Bot's webhook payload
        const { telegramId, text, direction, username, timestamp,
                chatType, chatId: tgChatId, chatTitle,
                firstName, lastName } = body

        if (!telegramId || !text) {
            return NextResponse.json({ error: 'Missing required fields: telegramId, text' }, { status: 400 })
        }

        // ── GROUP BRANCH: route group/supergroup/channel messages separately ──
        const isGroup = chatType && chatType !== 'private'
        if (isGroup) {
            const sentAt = timestamp ? new Date(timestamp) : new Date()
            const groupExternalId = `telegram:group:${tgChatId}`

            let unifiedChat = await (prisma.chat as any).upsert({
                where: { externalChatId: groupExternalId },
                update: { lastMessageAt: sentAt },
                create: {
                    externalChatId: groupExternalId,
                    channel: 'telegram',
                    chatType: chatType,       // 'group' | 'supergroup' | 'channel'
                    name: chatTitle || `TG Group ${tgChatId}`,
                    lastMessageAt: sentAt,
                    metadata: { chatTitle, chatType }
                }
            })

            // senderName priority: firstName > username > fallback ID
            const senderDisplay = firstName
                ? (lastName ? `${firstName} ${lastName}` : firstName)
                : (username ? `@${username}` : `User ${telegramId}`)

            await (prisma.message as any).create({
                data: {
                    chatId: unifiedChat.id,
                    direction: direction === 'OUTGOING' ? 'outbound' : 'inbound',
                    content: text,
                    channel: 'telegram',
                    type: 'text',
                    sentAt,
                    status: 'delivered',
                    metadata: {
                        senderId: telegramId.toString(),
                        senderName: senderDisplay,
                        senderUsername: username || null
                    }
                }
            })

            // Lightweight workflow: only unreadCount + lastInboundAt (no requiresResponse, no status transition)
            if (direction !== 'OUTGOING') {
                await ConversationWorkflowService.onGroupInboundMessage(unifiedChat.id, sentAt)
            }

            console.log(`[WEBHOOK-TG] GROUP chatId=${unifiedChat.id} type=${chatType} title=${chatTitle} sender=${senderDisplay}`)
            return NextResponse.json({ success: true, processed: 'group_message' })
        }
        // ── END GROUP BRANCH ──

        const tgIdBigInt = BigInt(telegramId)

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

            // RETRY LOOP FOR UPSERT (concurrency protection)
            let unifiedChat;
            let retries = 3;
            while (retries > 0) {
                try {
                    unifiedChat = await (prisma.chat as any).upsert({
                        where: { externalChatId },
                        update: { lastMessageAt: sentAt },
                        create: {
                            externalChatId,
                            channel: 'telegram',
                            name: username ? `@${username}` : `TG ${telegramId}`,
                            lastMessageAt: sentAt
                        }
                    })
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
                const linked = await DriverMatchService.linkChatToDriver(unifiedChat.id, { telegramId: telegramId.toString() })
                if (linked) {
                    unifiedChat = await (prisma.chat as any).findUnique({ where: { id: unifiedChat.id } })
                }
                console.log(`[WEBHOOK-TG] RELINK chat=${unifiedChat.id} driver=${unifiedChat.driverId || 'none'} linked=${linked}`)
            }

            // ── Contact Model dual write ──────────────────────────────
            try {
                const contactResult = await ContactService.resolveContact(
                    'telegram',
                    telegramId.toString(),
                    null,  // Bot webhook не передаёт номер телефона
                    username ? `@${username}` : null,
                )
                await ContactService.ensureChatLinked(
                    unifiedChat.id,
                    contactResult.contact.id,
                    contactResult.identity.id,
                )
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
                await (prisma.message as any).create({
                    data: {
                        chatId: unifiedChat.id,
                        direction: msgDirection,
                        content: text,
                        channel: 'telegram',
                        type: 'text',
                        sentAt: sentAt,
                        status: 'delivered'
                    }
                })

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
