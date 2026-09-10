import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { broadcastChatMessageV1 as broadcastChatMessage } from '@/modules/messaging/public/v1/message-stream'
import { PATCH_MESSAGE_METADATA_COMMAND_V1 } from '@/contracts/messaging/v1'
import { patchMessageMetadataV1 } from '@/modules/messaging/public/v1'
import { isAuthorizedMaxScraperWebhookV1 } from '@/modules/max-channel/internal/scraper-webhook-auth'

function concreteProviderAccountId(value: unknown): string | null {
    if (typeof value !== 'string' && typeof value !== 'number') return null
    const normalized = String(value).trim()
    return normalized && normalized !== 'legacy' && normalized !== 'max-default'
        ? normalized
        : null
}

function metadataRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {}
}

// POST /api/webhook/max/reaction
// Вызывается скрапером когда пользователь ставит/убирает реакцию в MAX веб-интерфейсе.
// Синхронизирует metadata.reactions в БД и рассылает SSE-обновление клиентам.
export async function POST(req: NextRequest) {
    if (!isAuthorizedMaxScraperWebhookV1(req)) {
        return NextResponse.json({ error: 'MAX_SCRAPER_WEBHOOK_UNAUTHORIZED' }, { status: 401 })
    }
    try {
        const body = await req.json()
        const { externalMsgId, emoji, isRemove, counters, providerAccountId } = body
        const incomingProviderAccountId = concreteProviderAccountId(providerAccountId)

        if (!externalMsgId) {
            return NextResponse.json({ error: 'externalMsgId required' }, { status: 400 })
        }
        if (!incomingProviderAccountId) {
            return NextResponse.json({ error: 'MAX_PROVIDER_ACCOUNT_UNPROVEN' }, { status: 400 })
        }

        // Message IDs are globally unique. Fuzzy suffix lookup could mutate a
        // different account's message, so reaction ingress is exact-only.
        const message = await (prisma.message as any).findUnique({
            where: { externalId: String(externalMsgId) },
            include: { chat: true },
        })

        if (!message) {
            console.warn(`[WEBHOOK-MAX/reaction] Message not found: externalMsgId=${externalMsgId}`)
            console.log('[MAX_DELIVERY]', JSON.stringify({
                ts: new Date().toISOString(),
                operation: 'reaction',
                status: 'failed',
                maxMessageId: String(externalMsgId),
                error: 'message not found',
            }))
            return NextResponse.json({ ok: false, reason: 'message not found' })
        }

        const owningChat = message.chat
        const storedProviderAccountId = concreteProviderAccountId(
            metadataRecord(owningChat?.metadata).providerAccountId,
        )
        if (owningChat?.channel !== 'max') {
            return NextResponse.json({ error: 'MAX_MESSAGE_IDENTITY_COLLISION' }, { status: 409 })
        }
        if (!storedProviderAccountId) {
            return NextResponse.json({ error: 'MAX_PROVIDER_ACCOUNT_UNPROVEN' }, { status: 409 })
        }
        if (storedProviderAccountId !== incomingProviderAccountId) {
            return NextResponse.json({ error: 'MAX_PROVIDER_ACCOUNT_COLLISION' }, { status: 409 })
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

        const updated = { ...message, metadata: { ...meta, reactions } }
        await patchMessageMetadataV1({ contract: PATCH_MESSAGE_METADATA_COMMAND_V1, messageId: message.id, metadata: updated.metadata })

        // Broadcast via SSE so open chat tabs refresh instantly
        try { broadcastChatMessage(updated.chatId, updated) } catch {}

        console.log('[MAX_DELIVERY]', JSON.stringify({
            ts: new Date().toISOString(),
            operation: 'reaction',
            status: 'max_echo_received',
            crmMessageId: message.id,
            maxMessageId: String(externalMsgId),
            conversationId: message.chatId,
            reaction: emoji || null,
            error: null,
        }))

        console.log(`[WEBHOOK-MAX/reaction] msgId=${message.id} emoji=${emoji} remove=${isRemove} reactions=${JSON.stringify(reactions)}`)
        return NextResponse.json({ ok: true, reactions })

    } catch (error: any) {
        console.error('[WEBHOOK-MAX/reaction] Error:', error.message)
        return NextResponse.json({ error: error.message }, { status: 500 })
    }
}
