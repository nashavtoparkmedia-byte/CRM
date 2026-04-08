import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { DriverMatchService } from '@/lib/DriverMatchService'
import { ConversationWorkflowService } from '@/lib/ConversationWorkflowService'
import crypto from 'crypto'

export async function POST(req: NextRequest) {
    try {
        const body = await req.json()
        const { phone, text, timestamp, driverName, chatId: maxChatId, senderId } = body

        if (!text) {
            return NextResponse.json({ error: 'Missing required field: text' }, { status: 400 })
        }
        if (!phone && !maxChatId) {
            return NextResponse.json({ error: 'Missing required fields: phone or chatId' }, { status: 400 })
        }

        // Normalize phone. MAX might send just a name (e.g. "Все 2" -> "2" or "Александр" -> "")
        let phoneDigits = (phone || '').replace(/\D/g, '')

        // If we didn't get a valid 10+ digit phone number, try to fuzzy-match by name
        if (phoneDigits.length < 10) {
            console.log(`[WEBHOOK-MAX] Phone digits too short (${phoneDigits}) for name "${driverName || phone}". Attempting fuzzy match...`)
            
            // 1. First priority: Try to find a Driver matching this name (fuzzy)
            // This is crucial for linking anonymous scraper messages to existing driver profiles
            const matchedDriverId = await DriverMatchService.findDriverId({ name: driverName || phone })
            
            if (matchedDriverId) {
                const driver = await (prisma.driver as any).findUnique({ where: { id: matchedDriverId } })
                if (driver && driver.phone) {
                    phoneDigits = driver.phone.replace(/\D/g, '')
                    console.log(`[WEBHOOK-MAX] fuzzy matched to Driver "${driver.fullName}". Bound to phone: ${phoneDigits}`)
                }
            } else {
                // 1.5. Check if there is an active max chat for a driver whose name contains this word
                // This handles cases where "Александр" is ambiguous (many drivers), but only one "Александр Ремезов" has an active MAX chat
                const searchName = (driverName || phone).trim();
                const recentDriverChats = await (prisma.chat as any).findMany({
                    where: { 
                        channel: 'max', 
                        driverId: { not: null } 
                    },
                    include: { driver: true },
                    orderBy: { lastMessageAt: 'desc' },
                    take: 20
                });

                const matchedActiveChat = recentDriverChats.find((c: any) => {
                    if (!c.driver) return false;
                    const fullName = c.driver.fullName.toLowerCase();
                    const search = searchName.toLowerCase();
                    // Require at least 3 chars for fully fuzzy contains() match
                    if (search.length < 3) {
                        return fullName === search || fullName.split(/\s+/).includes(search);
                    }
                    return fullName.includes(search);
                });
                
                if (matchedActiveChat && matchedActiveChat.driver.phone) {
                    phoneDigits = matchedActiveChat.driver.phone.replace(/\D/g, '');
                    console.log(`[WEBHOOK-MAX] Ambiguous name "${searchName}", but linked to active driver "${matchedActiveChat.driver.fullName}" from recent chats. Bound to phone: ${phoneDigits}`);
                } else {
                    // 2. Second priority: Check if we already have a MAX chat exactly matching this name (Ghost Chat)
                    const existingChatByName = await (prisma.chat as any).findFirst({
                        where: { channel: 'max', name: driverName || phone }
                    })

                    if (existingChatByName && existingChatByName.externalChatId) {
                        phoneDigits = existingChatByName.externalChatId.replace('max:', '')
                        console.log(`[WEBHOOK-MAX] Driver not found, reusing existing Chat name ID: ${phoneDigits}`)
                    }
                }
            }
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

        console.log(`[WEBHOOK-MAX] Received: externalChatId=${externalChatId} phone=${phoneDigits} chatId=${maxChatId || 'none'} text="${text.substring(0, 50)}"`)

        // Migrate old phone-based chats to new chatId-based format
        if (maxChatId && phoneDigits) {
            const oldExternalId = `max:${phoneDigits}`
            const oldChat = await (prisma.chat as any).findUnique({ where: { externalChatId: oldExternalId } })
            if (oldChat) {
                const newChat = await (prisma.chat as any).findUnique({ where: { externalChatId: String(maxChatId) } })
                if (!newChat) {
                    // Migrate: rename old chat's externalChatId to new format
                    await (prisma.chat as any).update({
                        where: { id: oldChat.id },
                        data: { externalChatId: String(maxChatId) }
                    })
                    console.log(`[WEBHOOK-MAX] MIGRATED chat ${oldChat.id}: ${oldExternalId} → ${maxChatId}`)
                }
            }
        }

        // 1. Upsert unified Chat
        let unifiedChat = await (prisma.chat as any).findUnique({
            where: { externalChatId }
        })

        if (!unifiedChat) {
            unifiedChat = await (prisma.chat as any).create({
                data: {
                    externalChatId,
                    channel: 'max',
                    name: driverName || phone,
                    lastMessageAt: sentAt,
                    status: 'new'
                }
            })
        } else {
            unifiedChat = await (prisma.chat as any).update({
                where: { id: unifiedChat.id },
                data: { 
                    lastMessageAt: sentAt,
                    // Optionally update name if scraper found a better one and current is just a number
                    ...(driverName && unifiedChat.name === phone ? { name: driverName } : {})
                }
            })
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
        // Generate a deterministic ID based on timestamp, phone AND text hash to prevent collision
        const textHash = crypto.createHash('md5').update(text).digest('hex').substring(0, 8)
        const messageId = `max_in_${phoneDigits}_${sentAt.getTime()}_${textHash}`

        // Check if message already exists (by deterministic ID OR content+time echo)
        const existingMessage = await (prisma.message as any).findFirst({
            where: {
                OR: [
                    { id: messageId },
                    {
                        chatId: unifiedChat.id,
                        content: text,
                        direction: 'outbound',
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
                    direction: 'inbound',
                    content: text,
                    channel: 'max',
                    type: 'text',
                    sentAt,
                    status: 'delivered'
                }
            })

            // Workflow: inbound message state update
            await ConversationWorkflowService.onInboundMessage(unifiedChat.id, sentAt)

            console.log(`[WEBHOOK-MAX] SAVED channel=max chatId=${unifiedChat.id} msgId=${messageId} driverId=${unifiedChat.driverId || 'none'} text="${text.substring(0, 30)}"`)
        } else {
            console.log(`[WEBHOOK-MAX] DB-DEDUP channel=max chatId=${unifiedChat.id} msgId=${messageId} existing=${existingMessage.id}`)
        }

        return NextResponse.json({ success: true, chatId: unifiedChat.id })

    } catch (error: any) {
        console.error('[WEBHOOK-MAX ERROR]:', error)
        return NextResponse.json({ error: 'Internal server error', details: error.message }, { status: 500 })
    }
}
