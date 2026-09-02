import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { broadcastChatMessage } from '@/lib/messageStreamBus'
import { getMaxChannelDeliveryV1, getTelegramChannelDeliveryV1, getWhatsAppChannelDeliveryV1 } from '@/modules/messaging/public/v1/channel-delivery-runtime'
import { PATCH_MESSAGE_METADATA_COMMAND_V1 } from '@/contracts/messaging/v1'
import { patchMessageMetadataV1 } from '@/modules/messaging/public/v1'
import {
    prepareOutboundConversationV1,
    type PreparedOutboundConversationV1,
} from '@/modules/messaging/public/v1/outbound-conversation-identity-runtime'

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
                        id: true,
                        contactId: true,
                        contactIdentityId: true,
                        channel: true,
                        externalChatId: true,
                        chatType: true,
                        metadata: true,
                    }
                }
            }
        })

        if (!msg) {
            return NextResponse.json({ error: 'Message not found' }, { status: 404 })
        }
        const outbound = await prepareOutboundConversationV1(msg.chat)
        if (
            !outbound.chatId
            || outbound.chatId !== msg.chatId
            || outbound.channel !== msg.channel
        ) {
            throw new Error('CONTACT_CONVERSATION_IDENTITY_BINDING_MISMATCH')
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

        // A MAX frame acknowledgement is not a provider echo. Persist only
        // after the channel capability confirms the reaction reached MAX.
        if (msg.channel === 'max') {
            try {
                const result = await sendReactionToChannel(
                    outbound,
                    msg.externalId,
                    emoji,
                    isRemoving,
                )
                if (!result.reactionConfirmed) {
                    console.log('[MAX_DELIVERY]', JSON.stringify({
                        ts: new Date().toISOString(),
                        operation: 'reaction',
                        status: result.status || 'send_requested',
                        crmMessageId: msg.id,
                        maxMessageId: msg.externalId,
                        conversationId: outbound.target,
                        error: null,
                    }))
                    return NextResponse.json({
                        success: false,
                        pending: true,
                        status: result.status || 'send_requested',
                        message: 'MAX reaction sent; waiting for provider confirmation',
                    }, { status: 202 })
                }
            } catch (error: any) {
                console.warn('[API/reaction] MAX delivery failed:', error.message)
                return NextResponse.json({ error: error.message || 'MAX reaction failed' }, { status: 502 })
            }
        }

        await patchMessageMetadataV1({
            contract: PATCH_MESSAGE_METADATA_COMMAND_V1,
            messageId,
            metadata: updatedMetadata,
        })
        const updated = { ...msg, metadata: updatedMetadata }

        // Broadcast immediately so all open chat tabs refresh without waiting for channel round-trip
        try { broadcastChatMessage(updated.chatId, updated) } catch {}

        // Send reaction to messenger channel (best-effort, don't fail on error)
        if (msg.channel !== 'max') {
            try {
                await sendReactionToChannel(outbound, msg.externalId, emoji, isRemoving)
            } catch (err: any) {
                console.warn(`[API/reaction] Failed to send reaction to ${msg.channel}:`, err.message)
            }
        }

        return NextResponse.json({ reactions })
    } catch (err: any) {
        console.error('[API/reaction] Error:', err.message)
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
    }
}

async function sendReactionToChannel(
    outbound: PreparedOutboundConversationV1,
    externalMsgId: string | null | undefined,
    emoji: string,
    isRemoving: boolean,
): Promise<{ reactionConfirmed: boolean; status?: string }> {
    if (!externalMsgId) {
        console.log(`[reaction] No externalId for message, skipping channel delivery`)
        return { reactionConfirmed: false }
    }

    switch (outbound.channel) {
        case 'whatsapp':
            await getWhatsAppChannelDeliveryV1().sendReaction({
                connectionId: outbound.connectionId,
                chatId: outbound.target,
                messageId: externalMsgId,
                emoji,
                remove: isRemoving,
            })
            return { reactionConfirmed: true }
        case 'telegram':
            await getTelegramChannelDeliveryV1().sendReaction({
                connectionId: outbound.connectionId,
                internalChatId: outbound.chatId!,
                providerAccountId: outbound.providerAccountId,
                identityTarget: outbound.identityTarget,
                chatId: outbound.target,
                messageId: externalMsgId,
                emoji,
                remove: isRemoving,
            })
            return { reactionConfirmed: true }
        case 'max':
            return getMaxChannelDeliveryV1().sendReaction({
                chatId: outbound.target,
                messageId: externalMsgId,
                emoji,
                remove: isRemoving,
                providerAccountId: outbound.providerAccountId,
                connectionId: outbound.connectionId,
                isPersonal: outbound.isMaxPersonal,
            })
        default:
            console.log(`[reaction] Channel ${outbound.channel} not supported for reactions`)
            return { reactionConfirmed: false }
    }
}
