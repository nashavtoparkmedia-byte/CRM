import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { ContactService } from '@/lib/ContactService'
import { normalizePhoneE164 } from '@/lib/phoneUtils'

export async function POST(request: Request) {
    try {
        const { driverId, channel, externalChatId } = await request.json()

        if (!driverId || !channel) {
            return NextResponse.json({ error: 'DriverId and channel are required' }, { status: 400 })
        }

        const isUnsaved = driverId.startsWith('unsaved_')
        let driver = null

        if (!isUnsaved) {
            driver = await prisma.driver.findUnique({
                where: { id: driverId }
            })
            if (!driver) {
                return NextResponse.json({ error: 'Driver not found' }, { status: 404 })
            }
        }

        // Determine externalChatId if not provided
        let finalExternalId = externalChatId
        if (!finalExternalId) {
            if (isUnsaved) {
                finalExternalId = driverId.replace('unsaved_', '')
            } else if (channel === 'whatsapp' || channel === 'max') {
                finalExternalId = driver?.phone?.replace(/\D/g, '')
            } else if (channel === 'telegram') {
                const tgList: any[] = await prisma.$queryRaw`SELECT * FROM "DriverTelegram" WHERE "driverId" = ${driverId} LIMIT 1`
                const tg = tgList[0] || null
                // Result from $queryRaw might have bigints if the column is bigint
                const tgId = tg?.telegramId?.toString()
                finalExternalId = tgId || driver?.phone?.replace(/\D/g, '')
                console.log(`[API-START-CHAT] Telegram initiation for ${driver?.fullName}: id=${finalExternalId} (fallback used: ${!tg})`)
            }
        }

        if (!finalExternalId) {
            console.error(`[API-START-CHAT] Failed to determine ID for ${driver?.fullName || isUnsaved} on ${channel}`)
            return NextResponse.json({ error: 'Could not determine external chat ID for this channel' }, { status: 400 })
        }

        // Create or get chat with channel-prefixed externalChatId
        const prefixedId = `${channel}:${finalExternalId}`
        const chatName = isUnsaved ? `+${finalExternalId}` : driver?.fullName

        const chat = await (prisma.chat as any).upsert({
            where: { externalChatId: prefixedId },
            update: {
                driverId: isUnsaved ? null : driverId,
                name: chatName,
                channel
            },
            create: {
                driverId: isUnsaved ? null : driverId,
                channel,
                externalChatId: prefixedId,
                name: chatName,
                status: 'new'
            }
        })

        // ── Contact Model dual write ──────────────────────────────
        try {
            const phone = isUnsaved
                ? normalizePhoneE164(finalExternalId)
                : normalizePhoneE164(driver?.phone)
            const displayName = chatName || null

            const contactResult = await ContactService.resolveContact(
                channel,
                finalExternalId,
                phone,
                displayName,
            )
            await ContactService.ensureChatLinked(
                chat.id,
                contactResult.contact.id,
                contactResult.identity.id,
            )
        } catch (contactErr: any) {
            console.error(`[API-START-CHAT] ContactService error (non-blocking): ${contactErr.message}`)
        }
        // ──────────────────────────────────────────────────────────

        return NextResponse.json(chat)
    } catch (error) {
        console.error('[API-START-CHAT] POST Error:', error)
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
    }
}
