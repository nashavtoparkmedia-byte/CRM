import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { broadcastChatMessage } from '@/lib/messageStreamBus'

const MAX_SCRAPER_URL = process.env.MAX_SCRAPER_URL || 'http://localhost:3005'

export async function POST(req: NextRequest) {
    const body = await req.json().catch(() => ({}))
    const { messageId, deleteForEveryone } = body

    if (!messageId) {
        return NextResponse.json({ error: 'messageId required' }, { status: 400 })
    }

    const message = await prisma.message.findUnique({
        where: { id: messageId },
        select: { id: true, chatId: true, channel: true, externalId: true },
    })

    if (!message) {
        return NextResponse.json({ error: 'not found' }, { status: 404 })
    }

    // Best-effort channel delete (non-blocking, don't wait)
    if (deleteForEveryone && message.externalId) {
        if (message.channel === 'max') {
            const chat = await prisma.chat.findUnique({
                where: { id: message.chatId },
                select: { externalChatId: true },
            })
            if (chat?.externalChatId) {
                fetch(`${MAX_SCRAPER_URL}/delete-message`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chatId: Number(chat.externalChatId),
                        messageId: message.externalId,
                    }),
                }).catch(() => {})
            }
        }
    }

    // Delete from DB (cascades to MessageAttachment via Prisma schema)
    await prisma.message.delete({ where: { id: messageId } })

    // Broadcast deletion to SSE subscribers so open tabs update instantly
    try {
        broadcastChatMessage(message.chatId, { id: messageId, chatId: message.chatId, deleted: true })
    } catch {}

    return NextResponse.json({ success: true })
}
