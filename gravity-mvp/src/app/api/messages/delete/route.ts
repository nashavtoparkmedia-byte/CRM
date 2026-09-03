import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { broadcastChatMessage } from '@/lib/messageStreamBus'
import { getMaxChannelDeliveryV1 } from '@/modules/messaging/public/v1/channel-delivery-runtime'
import { prepareOutboundConversationV1 } from '@/modules/messaging/public/v1/outbound-conversation-identity-runtime'

export async function POST(req: NextRequest) {
    try {
        const body = await req.json().catch(() => ({}))
        const { messageId, deleteForEveryone } = body
        if (!messageId) {
            return NextResponse.json({ error: 'messageId required' }, { status: 400 })
        }

        const message = await prisma.message.findUnique({
            where: { id: messageId },
            select: {
                id: true,
                chatId: true,
                channel: true,
                externalId: true,
                chat: {
                    select: {
                        id: true,
                        contactId: true,
                        contactIdentityId: true,
                        channel: true,
                        externalChatId: true,
                        chatType: true,
                        metadata: true,
                    },
                },
            },
        })
        if (!message) {
            return NextResponse.json({ error: 'not found' }, { status: 404 })
        }

        if (deleteForEveryone) {
            if (message.channel !== 'max' || !message.externalId) {
                return NextResponse.json({
                    error: 'Provider deletion is unavailable for this message',
                }, { status: 409 })
            }
            const outbound = await prepareOutboundConversationV1(message.chat)
            if (outbound.chatId !== message.chatId || outbound.channel !== message.channel) {
                throw new Error('CONTACT_CONVERSATION_IDENTITY_BINDING_MISMATCH')
            }
            await getMaxChannelDeliveryV1().deleteMessage({
                chatId: outbound.target,
                messageId: message.externalId,
                providerAccountId: outbound.providerAccountId,
                connectionId: outbound.connectionId,
                isPersonal: outbound.isMaxPersonal,
            })
        }

        // A requested provider deletion must succeed under exact identity proof
        // before the local row is removed.
        await prisma.message.delete({ where: { id: messageId } })
        try {
            broadcastChatMessage(message.chatId, {
                id: messageId,
                chatId: message.chatId,
                deleted: true,
            })
        } catch {}
        return NextResponse.json({ success: true })
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Internal Server Error'
        console.error('[API/messages/delete] Error:', message)
        return NextResponse.json({ error: message }, { status: 500 })
    }
}
