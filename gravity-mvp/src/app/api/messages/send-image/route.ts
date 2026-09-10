import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getMaxChannelDeliveryV1 } from '@/modules/messaging/public/v1/channel-delivery-runtime'
import { prepareOutboundConversationV1 } from '@/modules/messaging/public/v1/outbound-conversation-identity-runtime'

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

        // Prove the exact ContactIdentity/account/transport tuple before the
        // provider call or any local message mutation.
        const chat = await prisma.chat.findUnique({
            where: { id: chatId },
            select: {
                id: true,
                contactId: true,
                contactIdentityId: true,
                channel: true,
                externalChatId: true,
                chatType: true,
                metadata: true,
            },
        })

        if (!chat) {
            return NextResponse.json({ error: 'Chat not found' }, { status: 404 })
        }

        const outbound = await prepareOutboundConversationV1(chat)
        if (!outbound.chatId || outbound.chatId !== chatId) {
            throw new Error('CONTACT_CONVERSATION_IDENTITY_BINDING_MISMATCH')
        }
        if (outbound.channel !== 'max') {
            return NextResponse.json(
                { error: `Image send not implemented for channel: ${outbound.channel}` },
                { status: 400 }
            )
        }

        await getMaxChannelDeliveryV1().sendMedia({
            chatId: outbound.target,
            base64,
            filename,
            mimeType,
            caption: caption || '',
            mediaType: 'image',
            providerAccountId: outbound.providerAccountId,
            connectionId: outbound.connectionId,
            isPersonal: outbound.isMaxPersonal,
        })

        // Save outgoing image message to DB so it appears in CRM
        const message = await prisma.message.create({
            data: {
                chatId:    outbound.chatId,
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
            where: { id: outbound.chatId },
            data:  { lastMessageAt: new Date() },
        })

        return NextResponse.json({ success: true, messageId: message.id })
    } catch (err: any) {
        console.error('[send-image] Error:', err)
        return NextResponse.json({ error: err.message }, { status: 500 })
    }
}
