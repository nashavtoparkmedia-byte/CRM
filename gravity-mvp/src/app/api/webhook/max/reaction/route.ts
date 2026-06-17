import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { broadcastChatMessage } from '@/lib/messageStreamBus'

// POST /api/webhook/max/reaction
// Вызывается скрапером когда пользователь ставит/убирает реакцию в MAX веб-интерфейсе.
// Синхронизирует metadata.reactions в БД и рассылает SSE-обновление клиентам.
export async function POST(req: NextRequest) {
    try {
        const body = await req.json()
        const { chatId: maxChatId, externalMsgId, emoji, isRemove } = body

        if (!externalMsgId) {
            return NextResponse.json({ error: 'externalMsgId required' }, { status: 400 })
        }

        // Find message by externalId
        const message = await (prisma.message as any).findFirst({
            where: { externalId: String(externalMsgId) },
        })

        if (!message) {
            console.warn(`[WEBHOOK-MAX/reaction] Message not found: externalMsgId=${externalMsgId}`)
            return NextResponse.json({ ok: false, reason: 'message not found' })
        }

        // Update reactions in metadata
        const meta = (message.metadata as any) || {}
        const reactions: Record<string, number> = { ...(meta.reactions || {}) }

        if (isRemove || !emoji) {
            if (emoji) delete reactions[emoji]
        } else {
            reactions[emoji] = (reactions[emoji] || 0) + 1
        }

        const updated = await (prisma.message as any).update({
            where: { id: message.id },
            data: { metadata: { ...meta, reactions } },
        })

        // Broadcast via SSE so open chat tabs refresh instantly
        try { broadcastChatMessage(updated.chatId, updated) } catch {}

        console.log(`[WEBHOOK-MAX/reaction] msgId=${message.id} emoji=${emoji} remove=${isRemove} reactions=${JSON.stringify(reactions)}`)
        return NextResponse.json({ ok: true, reactions })

    } catch (error: any) {
        console.error('[WEBHOOK-MAX/reaction] Error:', error.message)
        return NextResponse.json({ error: error.message }, { status: 500 })
    }
}
