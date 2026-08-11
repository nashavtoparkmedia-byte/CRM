import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { broadcastChatMessage } from '@/lib/messageStreamBus'
import { getMaxChannelDeliveryV1, getTelegramChannelDeliveryV1, getWhatsAppChannelDeliveryV1 } from '@/modules/messaging/public/v1/channel-delivery-runtime'

/**
 * POST /api/messages/reaction
 * Body: { messageId: string, emoji: string }
 *
 * Toggle emoji reaction on a message.
 * Stores reactions in message metadata AND sends to messenger channel.
 */
export async function POST(req: NextRequest) {
    try {
        const { messageId, emoji } = await req.json()

        if (!messageId || !emoji) {
            return NextResponse.json({ error: 'messageId and emoji required' }, { status: 400 })
        }

        const msg = await prisma.message.findUnique({
            where: { id: messageId },
            select: {
                id: true,
                metadata: true,
                externalId: true,
                channel: true,
                chatId: true,
                chat: {
                    select: {
                        externalChatId: true,
                        metadata: true,
                    }
                }
            }
        })

        if (!msg) {
            return NextResponse.json({ error: 'Message not found' }, { status: 404 })
        }

        const metadata = (msg.metadata as Record<string, any>) || {}
        const reactions = (metadata.reactions as Record<string, number>) || {}

        // Toggle: if reaction exists, remove it; otherwise add it
        const isRemoving = !!reactions[emoji]
        if (isRemoving) {
            delete reactions[emoji]
        } else {
            reactions[emoji] = 1
        }

        const updatedMetadata = { ...metadata, reactions }

        const updated = await prisma.message.update({
            where: { id: messageId },
            data: { metadata: updatedMetadata }
        })

        // Broadcast immediately so all open chat tabs refresh without waiting for channel round-trip
        try { broadcastChatMessage(updated.chatId, updated) } catch {}

        // Send reaction to messenger channel (best-effort, don't fail on error)
        try {
            await sendReactionToChannel(msg.channel || '', msg.externalId, msg.chat?.externalChatId || '', emoji, isRemoving, msg.chat?.metadata)
        } catch (err: any) {
            console.warn(`[API/reaction] Failed to send reaction to ${msg.channel}:`, err.message)
        }

        return NextResponse.json({ reactions })
    } catch (err: any) {
        console.error('[API/reaction] Error:', err.message)
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
    }
}

async function sendReactionToChannel(
    channel: string,
    externalMsgId: string | null | undefined,
    externalChatId: string,
    emoji: string,
    isRemoving: boolean,
    chatMetadata: any
) {
    if (!externalMsgId) {
        console.log(`[reaction] No externalId for message, skipping channel delivery`)
        return
    }

    switch (channel) {
        case 'whatsapp':
            await getWhatsAppChannelDeliveryV1().sendReaction({
                connectionId: chatMetadata?.connectionId,
                chatId: externalChatId,
                messageId: externalMsgId,
                emoji,
                remove: isRemoving,
            })
            break
        case 'telegram':
            await getTelegramChannelDeliveryV1().sendReaction({
                connectionId: chatMetadata?.connectionId,
                chatId: externalChatId,
                messageId: externalMsgId,
                emoji,
                remove: isRemoving,
            })
            break
        case 'max':
            await getMaxChannelDeliveryV1().sendReaction({
                chatId: externalChatId.replace(/^max:/, ''),
                messageId: externalMsgId,
                emoji,
                remove: isRemoving,
            })
            break
        default:
            console.log(`[reaction] Channel ${channel} not supported for reactions`)
    }
}
