/* eslint-disable @typescript-eslint/no-explicit-any -- Prisma JSON metadata is validated at this boundary */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { broadcastChatMessage } from '@/lib/messageStreamBus'

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

        const message = await (prisma.message as any).findFirst({
            where: {
                channel: 'max',
                externalId: String(externalMsgId),
            },
        })

        if (!message) {
            console.warn(`[WEBHOOK-MAX/reaction] Message not found: externalMsgId=${externalMsgId}`)
            console.log('[MAX_DELIVERY]', JSON.stringify({
                ts: new Date().toISOString(),
                operation: 'reaction',
                status: 'failed',
                maxMessageId: String(externalMsgId),
                externalId: String(externalMsgId),
                error: 'message not found',
            }))
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
                reactions[emoji] = 1
            }
        }

        const updated = await (prisma.message as any).update({
            where: { id: message.id },
            data: {
                metadata: {
                    ...meta,
                    reactions,
                    maxReactionSync: {
                        externalMsgId: String(externalMsgId),
                        actor: body.actor ? String(body.actor) : null,
                        source: body.source ? String(body.source) : 'provider_snapshot',
                        observedAt: new Date().toISOString(),
                    },
                },
            },
        })

        // Broadcast via SSE so open chat tabs refresh instantly
        try { broadcastChatMessage(updated.chatId, updated) } catch {}

        console.log('[MAX_DELIVERY]', JSON.stringify({
            ts: new Date().toISOString(),
            operation: 'reaction',
            status: 'max_echo_received',
            crmMessageId: message.id,
            maxMessageId: String(externalMsgId),
            externalId: String(externalMsgId),
            conversationId: message.chatId,
            reaction: emoji || null,
            counters: Array.isArray(counters) ? counters : null,
            error: null,
        }))
        console.log(`[WEBHOOK-MAX/reaction] msgId=${message.id} emoji=${emoji} remove=${isRemove} reactions=${JSON.stringify(reactions)}`)
        return NextResponse.json({ ok: true, reactions })

    } catch (error: any) {
        console.error('[WEBHOOK-MAX/reaction] Error:', error.message)
        return NextResponse.json({ error: error.message }, { status: 500 })
    }
}
