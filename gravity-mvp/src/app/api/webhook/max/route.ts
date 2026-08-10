import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { DriverMatchService } from '@/lib/DriverMatchService'
import { ContactService } from '@/lib/ContactService'
import { ConversationWorkflowService } from '@/lib/ConversationWorkflowService'
import crypto from 'crypto'
import { ENSURE_CONVERSATION_CONTACT_LINK_COMMAND_V1 } from '@/contracts/messaging/v1'
import { ensureConversationContactLinkV1 } from '@/modules/messaging/public/v1'

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
        const { phone, text, timestamp, driverName, chatId: maxChatId, senderId, isOutgoing, replyToExternalId, externalId: maxExternalId } = body

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

        // Migration pass 1: old phone-based chats ("max:phone") → new chatId format
        if (maxChatId && phoneDigits) {
            const oldExternalId = `max:${phoneDigits}`
            const oldChat = await (prisma.chat as any).findUnique({ where: { externalChatId: oldExternalId } })
            if (oldChat) {
                const newChat = await (prisma.chat as any).findUnique({ where: { externalChatId: String(maxChatId) } })
                if (!newChat) {
                    await (prisma.chat as any).update({
                        where: { id: oldChat.id },
                        data: { externalChatId: String(maxChatId) }
                    })
                    console.log(`[WEBHOOK-MAX] MIGRATED chat ${oldChat.id}: ${oldExternalId} → ${maxChatId}`)
                }
            }
        }

        // Migration pass 2: old numeric-format chatIds (e.g. "201482140") — stored without "max:" prefix.
        // When op:128 delivers a NEW 12-digit chatId for a contact we already know by driverId,
        // we update the stale chat rather than creating a duplicate.
        if (maxChatId && phoneDigits && phoneDigits.length >= 10) {
            const newExId = String(maxChatId)
            const alreadyExists = await (prisma.chat as any).findUnique({ where: { externalChatId: newExId } })
            if (!alreadyExists) {
                const driverCandidates = await (prisma.driver as any).findMany({
                    where: { phone: { contains: phoneDigits.slice(-10) } }
                })
                if (driverCandidates.length === 1) {
                    const driver = driverCandidates[0]
                    const staleChat = await (prisma.chat as any).findFirst({
                        where: { channel: 'max', driverId: driver.id, externalChatId: { not: newExId } }
                    })
                    if (staleChat) {
                        await (prisma.chat as any).update({ where: { id: staleChat.id }, data: { externalChatId: newExId } })
                        console.log(`[WEBHOOK-MAX] MIGRATED old-chatId ${staleChat.externalChatId} → ${newExId} (driver ${driver.id})`)
                    }
                } else if (driverCandidates.length > 1) {
                    console.warn(JSON.stringify({
                        level: 'warn',
                        event: 'legacy_max_old_chat_migration_ambiguous_driver_phone',
                        phoneSuffix: phoneDigits.slice(-4),
                        candidateCount: driverCandidates.length,
                        candidateIds: driverCandidates.map((driver: any) => driver.id),
                    }))
                }
            }
        }

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
            unifiedChat = await (prisma.chat as any).create({
                data: {
                    externalChatId,
                    channel: 'max',
                    name: bestName,
                    lastMessageAt: sentAt,
                    status: 'new'
                }
            })
        } else {
            // Update name только если current placeholder, а новое — лучше
            const shouldUpdateName = isPlaceholderName(unifiedChat.name) && !isPlaceholderName(bestName)
            unifiedChat = await (prisma.chat as any).update({
                where: { id: unifiedChat.id },
                data: {
                    lastMessageAt: sentAt,
                    ...(shouldUpdateName ? { name: bestName } : {})
                }
            })
        }

        // PR-Г: ContactService integration. Раньше для MAX не вызывался —
        // Contact не создавался, displayName не сохранялся. Теперь:
        // — если есть phone, используем его как identity
        // — displayName = bestName (реальное имя или номер)
        try {
            if (phoneDigits && phoneDigits.length >= 10) {
                const contactResult = await ContactService.resolveContact(
                    'max',
                    phoneDigits,
                    phoneDigits,
                    isPlaceholderName(bestName) ? null : bestName,
                )
                await ensureConversationContactLinkV1({
                    contract: ENSURE_CONVERSATION_CONTACT_LINK_COMMAND_V1,
                    chatId: unifiedChat.id,
                    contactId: contactResult.contact.id,
                    contactIdentityId: contactResult.identity.id,
                })
            } else {
                // Phone не извлекли — используем externalChatId как identity-id
                const contactResult = await ContactService.resolveContact(
                    'max',
                    externalChatId,
                    null,
                    isPlaceholderName(bestName) ? null : bestName,
                )
                await ensureConversationContactLinkV1({
                    contract: ENSURE_CONVERSATION_CONTACT_LINK_COMMAND_V1,
                    chatId: unifiedChat.id,
                    contactId: contactResult.contact.id,
                    contactIdentityId: contactResult.identity.id,
                })
            }
        } catch (contactErr: any) {
            console.error(`[WEBHOOK-MAX] ContactService error (non-blocking): ${contactErr.message}`)
        }

        // 2. Relink driver on every inbound if missing
        if (!unifiedChat.driverId) {
            const linked = await DriverMatchService.linkChatToDriver(unifiedChat.id, { 
                phone: phoneDigits,
                name: driverName || phone
            })
            if (linked) {
                unifiedChat = await (prisma.chat as any).findUnique({ where: { id: unifiedChat.id } })
            }
            console.log(`[WEBHOOK-MAX] RELINK chat=${unifiedChat.id} driver=${unifiedChat.driverId || 'none'} linked=${linked}`)
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
            await (prisma.message as any).create({
                data: {
                    id: messageId,
                    chatId: unifiedChat.id,
                    direction,
                    content: text,
                    channel: 'max',
                    type: 'text',
                    sentAt,
                    status: 'delivered',
                    ...(maxExternalId ? { externalId: String(maxExternalId) } : {}),
                    ...(replyToExternalId ? { metadata: { replyToExternalId } } : {}),
                }
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
