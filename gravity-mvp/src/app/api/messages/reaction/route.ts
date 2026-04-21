import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

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

        await prisma.message.update({
            where: { id: messageId },
            data: { metadata: updatedMetadata }
        })

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

/**
 * Send reaction to the actual messenger channel.
 */
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
            await sendWhatsAppReaction(externalMsgId, externalChatId, emoji, isRemoving, chatMetadata)
            break
        case 'telegram':
            await sendTelegramReaction(externalMsgId, externalChatId, emoji, isRemoving, chatMetadata)
            break
        case 'max':
            // MAX protocol doesn't have a documented reaction opcode yet
            console.log(`[reaction] MAX reactions not supported yet, stored in CRM only`)
            break
        default:
            console.log(`[reaction] Channel ${channel} not supported for reactions`)
    }
}

/**
 * WhatsApp: react to a message using whatsapp-web.js client.react()
 */
async function sendWhatsAppReaction(
    externalMsgId: string,
    externalChatId: string,
    emoji: string,
    isRemoving: boolean,
    chatMetadata: any
) {
    const { getClient } = await import('@/lib/whatsapp/WhatsAppService')

    // Determine connectionId from chat metadata
    const connectionId = chatMetadata?.connectionId
    if (!connectionId) {
        // Try to find any ready WhatsApp connection
        const conns: any[] = await prisma.$queryRaw`
            SELECT id FROM "WhatsAppConnection" WHERE "status" = 'ready' LIMIT 1
        `
        if (conns.length === 0) throw new Error('No ready WhatsApp connection')
        const client = getClient(conns[0].id)
        if (!client) throw new Error('WhatsApp client not found')
        await reactWhatsApp(client, externalChatId, externalMsgId, emoji, isRemoving)
        return
    }

    const client = getClient(connectionId)
    if (!client) throw new Error(`WhatsApp client not found for connection ${connectionId}`)
    await reactWhatsApp(client, externalChatId, externalMsgId, emoji, isRemoving)
}

async function reactWhatsApp(client: any, chatId: string, msgId: string, emoji: string, isRemoving: boolean) {
    const chat = await client.getChatById(chatId)
    const messages = await chat.fetchMessages({ limit: 50 })
    const targetMsg = messages.find((m: any) => m.id._serialized === msgId)

    if (!targetMsg) {
        throw new Error(`WhatsApp message ${msgId} not found in chat ${chatId}`)
    }

    // react('') removes reaction, react(emoji) sets it
    await targetMsg.react(isRemoving ? '' : emoji)
    console.log(`[reaction/WA] ${isRemoving ? 'Removed' : 'Sent'} ${emoji} on msg ${msgId}`)
}

/**
 * Telegram: send reaction via GramJS Api.messages.SendReaction
 */
async function sendTelegramReaction(
    externalMsgId: string,
    externalChatId: string,
    emoji: string,
    isRemoving: boolean,
    chatMetadata: any
) {
    const { Api } = await import('telegram')

    // Find the Telegram connection
    const connectionId = chatMetadata?.connectionId
    let connId = connectionId
    if (!connId) {
        const conns: any[] = await prisma.$queryRaw`
            SELECT id FROM "TelegramConnection" WHERE "isActive" = true ORDER BY "isDefault" DESC LIMIT 1
        `
        if (conns.length === 0) throw new Error('No active Telegram connection')
        connId = conns[0].id
    }

    // Get the GramJS client from the cache
    // tg-actions exports getTelegramClient indirectly — we access the client cache
    const { getClientForReaction } = await import('@/app/tg-actions')
    const client = await getClientForReaction(connId)
    if (!client) throw new Error(`Telegram client not found for connection ${connId}`)

    // Parse the peer from externalChatId
    // externalChatId format: "telegram:{userId}" or just the user/chat ID
    const peerIdStr = externalChatId.replace('telegram:', '')
    const peerId = parseInt(peerIdStr, 10)
    if (isNaN(peerId)) throw new Error(`Invalid Telegram peer ID: ${externalChatId}`)

    const msgIdNum = parseInt(externalMsgId, 10)
    if (isNaN(msgIdNum)) throw new Error(`Invalid Telegram message ID: ${externalMsgId}`)

    const reaction = isRemoving
        ? []
        : [new Api.ReactionEmoji({ emoticon: emoji })]

    await client.invoke(
        new Api.messages.SendReaction({
            peer: peerId,
            msgId: msgIdNum,
            reaction,
        })
    )

    console.log(`[reaction/TG] ${isRemoving ? 'Removed' : 'Sent'} ${emoji} on msg ${externalMsgId} in peer ${peerIdStr}`)
}
