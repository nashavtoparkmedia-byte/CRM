import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { isResolvedChannelContactResultV1, resolveChannelContactOperationV1 } from '@/modules/contacts/public/v1'
import { channelConversationWorkflowV1 as ConversationWorkflowService } from '@/modules/messaging/public/v1/channel-conversation-workflow'
import crypto from 'crypto'
import { ENSURE_CONVERSATION_CONTACT_LINK_COMMAND_V1, PATCH_CHANNEL_CONVERSATION_COMMAND_V1, UPSERT_CHANNEL_CONVERSATION_COMMAND_V1, UPSERT_EXTERNAL_MESSAGE_COMMAND_V1 } from '@/contracts/messaging/v1'
import { ensureConversationContactLinkV1, patchChannelConversationV1, upsertChannelConversationV1, upsertExternalMessageV1 } from '@/modules/messaging/public/v1'

// PR-Г: placeholder detection — name = "..", ". .", "TG NNN", pure digits.
// Используется для умного update: новое реальное имя замещает placeholder
// без overwrite уже хорошего имени.
function isPlaceholderName(name?: string | null): boolean {
    if (!name) return true
    const t = name.trim()
    if (!t) return true
    if (/^(TG|MAX|WA|Telegram|Max|WhatsApp)[\s:]+\d+$/i.test(t)) return true
    if (/^\d+$/.test(t)) return true
    if (/^[.\s\-]+$/.test(t)) return true
    return false
}

export async function POST(req: NextRequest) {
    try {
        console.warn('[WEBHOOK-MAX][legacy] Deprecated route /api/webhook/max received a request; scraper runtime should use /api/webhooks/max')
        const body = await req.json()
        const { phone, text, timestamp, driverName, chatId: maxChatId, senderId, isOutgoing, replyToExternalId, externalId: maxExternalId, chatKind, accountId } = body
        const maxChatKind = chatKind === 'private' || chatKind === 'group' ? chatKind : 'unknown'

        if (!text) {
            return NextResponse.json({ error: 'Missing required field: text' }, { status: 400 })
        }
        if (!phone && !maxChatId) {
            return NextResponse.json({ error: 'Missing required fields: phone or chatId' }, { status: 400 })
        }

        // Normalize phone. MAX might send just a name (e.g. "Все 2" -> "2" or "Александр" -> "")
        let phoneDigits = (phone || '').replace(/\D/g, '')

        // If we didn't get a valid 10+ digit phone number, do not derive one
        // from names or recent chats. Name is not identity proof.
        if (phoneDigits.length < 10) {
            console.warn(JSON.stringify({
                level: 'warn',
                event: 'legacy_max_name_phone_resolution_blocked',
                hasChatId: Boolean(maxChatId),
                nameLength: String(driverName || phone || '').trim().length,
            }))
            phoneDigits = ''
        }

        // Use MAX internal chatId as primary identifier (most reliable)
        // Fall back to phone-based ID, then name-based ID
        let externalChatId: string
        if (maxChatId) {
            externalChatId = String(maxChatId)
        } else if (phoneDigits) {
            externalChatId = `max:${phoneDigits}`
        } else {
            const safeName = (driverName || phone).replace(/[^a-zA-Zа-яА-Я0-9]/g, '_');
            externalChatId = `max_name:${safeName}`;
            console.log(`[WEBHOOK-MAX] No chatId or phone. Using named externalChatId: ${externalChatId}`);
        }
        const sentAt = timestamp ? new Date(timestamp) : new Date()

        const direction = isOutgoing ? 'outbound' : 'inbound'
        console.log(`[WEBHOOK-MAX] Received: externalChatId=${externalChatId} phone=${phoneDigits} chatId=${maxChatId || 'none'} direction=${direction} text="${text.substring(0, 50)}"`)

        // 1. Upsert unified Chat
        let unifiedChat = await (prisma.chat as any).findUnique({
            where: { externalChatId }
        })

        // PR-Г: name приоритет — реальное имя > телефон > "MAX user".
        // Не overwrite-им хорошее имя placeholder'ом.
        const bestName = (() => {
            const dn = (driverName ?? '').trim()
            if (dn && !isPlaceholderName(dn)) return dn
            if (phoneDigits) return `+${phoneDigits}`
            if (dn) return dn  // placeholder лучше чем ничего
            return `MAX ${externalChatId}`
        })()

        if (!unifiedChat) {
            const created = await upsertChannelConversationV1({ contract: UPSERT_CHANNEL_CONVERSATION_COMMAND_V1, externalChatId, channel: 'max', name: bestName, chatType: maxChatKind === 'group' ? 'group' : 'private', metadata: { chatKind: maxChatKind } })
            unifiedChat = created.conversation as any
            await patchChannelConversationV1({ contract: PATCH_CHANNEL_CONVERSATION_COMMAND_V1, selector: { chatId: unifiedChat.id }, patch: { lastMessageAt: sentAt } })
        } else {
            // Update name только если current placeholder, а новое — лучше
            const shouldUpdateName = isPlaceholderName(unifiedChat.name) && !isPlaceholderName(bestName)
            const patched = await patchChannelConversationV1({ contract: PATCH_CHANNEL_CONVERSATION_COMMAND_V1, selector: { chatId: unifiedChat.id }, patch: { lastMessageAt: sentAt, ...(shouldUpdateName ? { name: bestName } : {}) } })
            unifiedChat = patched.conversation as any
        }

        // Deprecated Contact compatibility path, constrained by the same
        // exact-sender and untrusted-phone policy as the primary webhook.
        try {
            // The deprecated payload may still be delivered, but only a real
            // senderId is a person identity. Phone and conversation ids are not.
            if (senderId && phoneDigits) {
                const contactResult = await resolveChannelContactOperationV1(
                    'max', String(senderId), phoneDigits,
                    isPlaceholderName(bestName) ? null : bestName,
                    {
                        chatKind: maxChatKind,
                        providerAccountId: String(accountId || 'max-default'),
                        phoneEvidence: { source: 'unknown', trustedForAutomaticResolution: false },
                    },
                )
                if (!isResolvedChannelContactResultV1(contactResult) || !contactResult.identity) {
                    console.warn(`[WEBHOOK-MAX] Contact resolution blocked: ${contactResult.status}`)
                } else {
                    await ensureConversationContactLinkV1({
                        contract: ENSURE_CONVERSATION_CONTACT_LINK_COMMAND_V1,
                        chatId: unifiedChat.id,
                        contactId: contactResult.contact.id,
                        contactIdentityId: contactResult.identity.id,
                    })
                }
            } else if (senderId) {
                const contactResult = await resolveChannelContactOperationV1(
                    'max', String(senderId), null,
                    isPlaceholderName(bestName) ? null : bestName,
                    {
                        chatKind: maxChatKind,
                        providerAccountId: String(accountId || 'max-default'),
                        phoneEvidence: null,
                    },
                )
                if (!isResolvedChannelContactResultV1(contactResult) || !contactResult.identity) {
                    console.warn(`[WEBHOOK-MAX] Contact resolution blocked: ${contactResult.status}`)
                } else {
                    await ensureConversationContactLinkV1({
                        contract: ENSURE_CONVERSATION_CONTACT_LINK_COMMAND_V1,
                        chatId: unifiedChat.id,
                        contactId: contactResult.contact.id,
                        contactIdentityId: contactResult.identity.id,
                    })
                }
            }
        } catch (contactErr: any) {
            console.error(`[WEBHOOK-MAX] ContactService error (non-blocking): ${contactErr.message}`)
        }

        // 3. Create Message
        // Generate a deterministic ID based on timestamp, phone, direction AND text hash to prevent collision
        const dirPrefix = isOutgoing ? 'max_out' : 'max_in'
        const textHash = crypto.createHash('md5').update(text).digest('hex').substring(0, 8)
        const messageId = `${dirPrefix}_${phoneDigits}_${sentAt.getTime()}_${textHash}`

        // Check if message already exists (by deterministic ID, externalId, or content+time echo)
        const existingMessage = await (prisma.message as any).findFirst({
            where: {
                OR: [
                    { id: messageId },
                    ...(maxExternalId ? [{ externalId: String(maxExternalId) }] : []),
                    {
                        chatId: unifiedChat.id,
                        content: text,
                        sentAt: {
                            gte: new Date(sentAt.getTime() - 120000),
                            lte: new Date(sentAt.getTime() + 120000)
                        }
                    }
                ]
            }
        })

        if (!existingMessage) {
            await upsertExternalMessageV1({
                contract: UPSERT_EXTERNAL_MESSAGE_COMMAND_V1,
                lookupExternalId: String(maxExternalId || messageId),
                chatId: unifiedChat.id,
                direction,
                type: 'text',
                content: text,
                channel: 'max',
                externalId: maxExternalId ? String(maxExternalId) : messageId,
                sentAt,
                metadata: replyToExternalId ? { replyToExternalId } : {},
            })

            // Workflow: only trigger inbound workflow for driver messages
            if (!isOutgoing) {
                await ConversationWorkflowService.onInboundMessage(unifiedChat.id, sentAt)
            }

            console.log(`[WEBHOOK-MAX] SAVED channel=max chatId=${unifiedChat.id} msgId=${messageId} direction=${direction} driverId=${unifiedChat.driverId || 'none'} text="${text.substring(0, 30)}"`)
        } else {
            console.log(`[WEBHOOK-MAX] DB-DEDUP channel=max chatId=${unifiedChat.id} msgId=${messageId} existing=${existingMessage.id}`)
        }

        return NextResponse.json({ success: true, chatId: unifiedChat.id })

    } catch (error: any) {
        console.error('[WEBHOOK-MAX ERROR]:', error)
        return NextResponse.json({ error: 'Internal server error', details: error.message }, { status: 500 })
    }
}
