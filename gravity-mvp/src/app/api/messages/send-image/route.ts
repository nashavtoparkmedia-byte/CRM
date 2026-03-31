import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

const MAX_SCRAPER_URL = process.env.MAX_SCRAPER_URL || 'http://localhost:3005'

export async function POST(req: NextRequest) {
    try {
        const body = await req.json()
        const { chatId, base64, filename, mimeType, caption } = body

        if (!chatId || !base64 || !filename || !mimeType) {
            return NextResponse.json(
                { error: 'chatId, base64, filename, mimeType are required' },
                { status: 400 }
            )
        }

        // Get the chat to find channel and externalChatId
        const chat = await prisma.chat.findUnique({
            where: { id: chatId },
            select: { channel: true, externalChatId: true }
        })

        if (!chat) {
            return NextResponse.json({ error: 'Chat not found' }, { status: 404 })
        }

        if (chat.channel !== 'max') {
            return NextResponse.json(
                { error: `Image send not implemented for channel: ${chat.channel}` },
                { status: 400 }
            )
        }

        // Forward to MAX scraper
        const res = await fetch(`${MAX_SCRAPER_URL}/send-image`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chatId:   Number(chat.externalChatId),
                base64,
                filename,
                mimeType,
                caption:  caption || '',
            }),
        })

        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: res.statusText }))
            return NextResponse.json({ error: 'MAX scraper error', details: err }, { status: 502 })
        }

        // Save outgoing image message to DB so it appears in CRM
        const message = await prisma.message.create({
            data: {
                chatId:    chatId,
                direction: 'outbound',
                type:      'image',
                content:   caption || '[Фото]',
                channel:   'max',
                status:    'delivered',
                sentAt:    new Date(),
                metadata:  { origin: 'operator', filename },
            },
        })

        await prisma.chat.update({
            where: { id: chatId },
            data:  { lastMessageAt: new Date() },
        })

        return NextResponse.json({ success: true, messageId: message.id })
    } catch (err: any) {
        console.error('[send-image] Error:', err)
        return NextResponse.json({ error: err.message }, { status: 500 })
    }
}
