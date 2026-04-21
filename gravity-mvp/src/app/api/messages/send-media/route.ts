import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

const MAX_SCRAPER_URL = process.env.MAX_SCRAPER_URL || 'http://localhost:3005'

/**
 * Detect media type from MIME.
 * Returns one of: image | video | voice | audio | document
 */
function detectMediaType(mimeType: string): 'image' | 'video' | 'voice' | 'audio' | 'document' {
    if (mimeType.startsWith('image/')) return 'image'
    if (mimeType.startsWith('video/')) return 'video'
    // Voice = OGG Opus (WhatsApp/Telegram voice notes)
    if (mimeType === 'audio/ogg' || mimeType === 'audio/opus' || mimeType.includes('opus')) return 'voice'
    if (mimeType.startsWith('audio/')) return 'audio'
    return 'document'
}

function contentFallback(mediaType: string, caption?: string): string {
    if (caption) return caption
    const map: Record<string, string> = {
        image: '[Фото]', video: '[Видео]', voice: '[Голосовое]',
        audio: '[Аудио]', document: '[Документ]',
    }
    return map[mediaType] || '[Файл]'
}

export async function POST(req: NextRequest) {
    try {
        const body = await req.json()
        const { chatId, base64, filename, mimeType, caption, profileId } = body

        if (!chatId || !base64 || !filename || !mimeType) {
            return NextResponse.json(
                { error: 'chatId, base64, filename, mimeType are required' },
                { status: 400 }
            )
        }

        // Get chat to determine channel
        const chat = await prisma.chat.findUnique({
            where: { id: chatId },
            select: { channel: true, externalChatId: true, driver: { select: { phone: true, telegramId: true } } }
        })

        if (!chat) {
            return NextResponse.json({ error: 'Chat not found' }, { status: 404 })
        }

        const mediaType = detectMediaType(mimeType)
        const channel = chat.channel
        const unifiedType = mediaType === 'voice' ? 'voice' : mediaType === 'audio' ? 'audio' :
                           mediaType === 'video' ? 'video' : mediaType === 'image' ? 'image' : 'document'

        console.log(`[send-media] channel=${channel} mediaType=${mediaType} filename=${filename} mime=${mimeType}`)

        let externalId: string | null = null

        // Route to appropriate channel backend
        if (channel === 'max') {
            const res = await fetch(`${MAX_SCRAPER_URL}/send-media`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chatId: Number(chat.externalChatId),
                    base64, filename, mimeType, caption: caption || '',
                    mediaType,
                }),
            })
            if (!res.ok) {
                const err = await res.json().catch(() => ({ error: res.statusText }))
                return NextResponse.json({ error: 'MAX scraper error', details: err }, { status: 502 })
            }
        } else if (channel === 'whatsapp') {
            const { sendMedia } = await import('@/lib/whatsapp/WhatsAppService')
            // Resolve connectionId for this chat
            const connection = await (prisma as any).whatsAppConnection.findFirst({
                where: { status: 'ready' },
                orderBy: { createdAt: 'asc' }
            })
            if (!connection) {
                return NextResponse.json({ error: 'No active WhatsApp connection' }, { status: 503 })
            }
            const waChatId = chat.driver?.phone || chat.externalChatId?.replace('whatsapp:', '') || ''
            const result = await sendMedia(
                connection.id, waChatId, base64, filename, mimeType, caption,
                { sendAsVoice: mediaType === 'voice', sendAsDocument: mediaType === 'document' }
            )
            externalId = result.externalId
        } else if (channel === 'telegram') {
            const { sendTelegramMedia } = await import('@/app/tg-actions')
            const target = chat.driver?.telegramId?.toString() ||
                           chat.driver?.phone ||
                           chat.externalChatId?.replace('telegram:', '') || ''
            const result = await sendTelegramMedia(target, base64, filename, mimeType, caption, profileId)
            externalId = result.externalId || null
        } else {
            return NextResponse.json(
                { error: `Media send not implemented for channel: ${channel}` },
                { status: 400 }
            )
        }

        // Decode base64 for size estimation
        const cleanBase64 = base64.startsWith('data:') ? base64.split(',')[1] : base64
        const dataUrl = `data:${mimeType};base64,${cleanBase64}`
        const approxSize = Math.round(cleanBase64.length * 0.75)

        // Save outbound message + attachment
        const message = await prisma.message.create({
            data: {
                chatId,
                direction: 'outbound',
                type: unifiedType as any,
                content: contentFallback(mediaType, caption),
                channel: channel as any,
                externalId,
                status: 'delivered',
                sentAt: new Date(),
                metadata: { origin: 'operator', filename, mimeType },
            },
        })

        await prisma.messageAttachment.create({
            data: {
                messageId: message.id,
                type: unifiedType,
                url: dataUrl,
                fileName: filename,
                fileSize: approxSize,
                mimeType,
            }
        })

        await prisma.chat.update({
            where: { id: chatId },
            data: { lastMessageAt: new Date() },
        })

        return NextResponse.json({ success: true, messageId: message.id, externalId })
    } catch (err: any) {
        console.error('[send-media] Error:', err)
        return NextResponse.json({ error: err.message }, { status: 500 })
    }
}
