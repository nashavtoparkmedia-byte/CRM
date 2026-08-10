import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { broadcastChatMessage } from '@/lib/messageStreamBus'
import { PATCH_MESSAGE_METADATA_COMMAND_V1 } from '@/contracts/messaging/v1'
import { patchMessageMetadataV1 } from '@/modules/messaging/public/v1'

// POST /api/webhook/max/reaction
// Вызывается скрапером когда пользователь ставит/убирает реакцию в MAX веб-интерфейсе.
// Синхронизирует metadata.reactions в БД и рассылает SSE-обновление клиентам.
export async function POST(req: NextRequest) {
    try {
        const body = await req.json()
        const { externalMsgId, emoji, isRemove, counters } = body

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

        const meta = (message.metadata as any) || {}
        let reactions: Record<string, number>

        if (Array.isArray(counters)) {
            // Opcode 155: full snapshot — replace entirely
            reactions = {}
            for (const c of counters) {
                if (c.reaction && c.count > 0) reactions[c.reaction] = c.count
            }
        } else {
            // Fallback: single emoji add/remove
            reactions = { ...(meta.reactions || {}) }
            if (isRemove || !emoji) {
                if (emoji) delete reactions[emoji]
            } else {
                reactions[emoji] = (reactions[emoji] || 0) + 1
            }
        }

        const updated = { ...message, metadata: { ...meta, reactions } }
        await patchMessageMetadataV1({ contract: PATCH_MESSAGE_METADATA_COMMAND_V1, messageId: message.id, metadata: updated.metadata })

        // Broadcast via SSE so open chat tabs refresh instantly
        try { broadcastChatMessage(updated.chatId, updated) } catch {}

        console.log(`[WEBHOOK-MAX/reaction] msgId=${message.id} emoji=${emoji} remove=${isRemove} reactions=${JSON.stringify(reactions)}`)
        return NextResponse.json({ ok: true, reactions })

    } catch (error: any) {
        console.error('[WEBHOOK-MAX/reaction] Error:', error.message)
        return NextResponse.json({ error: error.message }, { status: 500 })
    }
}
