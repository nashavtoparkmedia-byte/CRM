import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { broadcastChatMessage } from '@/lib/messageStreamBus'
import { getMaxChannelDeliveryV1, getTelegramChannelDeliveryV1, getWhatsAppChannelDeliveryV1 } from '@/modules/messaging/public/v1/channel-delivery-runtime'

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
        const { chatId, base64, filename, mimeType, caption, profileId, clientMessageId } = body

        if (!chatId || !base64 || !filename || !mimeType) {
            return NextResponse.json(
                { error: 'chatId, base64, filename, mimeType are required' },
                { status: 400 }
            )
        }

        // Get chat to determine channel.
        // telegramId живёт в отдельной модели DriverTelegram, не на Driver —
        // raw query чтобы достать его одним запросом без рисков сломать schema.
        const chat = await prisma.chat.findUnique({
            where: { id: chatId },
            select: { channel: true, externalChatId: true, metadata: true, driver: { select: { phone: true, id: true } } }
        }) as any
        // Подтягиваем telegramId опционально через raw query (избегаем падения если relation отсутствует)
        if (chat?.driver?.id) {
            try {
                const rows = await prisma.$queryRaw<Array<{ telegramId: bigint }>>`
                    SELECT "telegramId" FROM "DriverTelegram" WHERE "driverId" = ${chat.driver.id} LIMIT 1
                `
                if (rows[0]?.telegramId != null) {
                    chat.driver.telegramId = rows[0].telegramId.toString()
                }
            } catch {}
        }

        if (!chat) {
            return NextResponse.json({ error: 'Chat not found' }, { status: 404 })
        }

        const mediaType = detectMediaType(mimeType)
        const channel = chat.channel
        const unifiedType = mediaType === 'voice' ? 'voice' : mediaType === 'audio' ? 'audio' :
                           mediaType === 'video' ? 'video' : mediaType === 'image' ? 'image' : 'document'

        console.log(`[send-media] channel=${channel} mediaType=${mediaType} filename=${filename} mime=${mimeType} captionLength=${String(caption || '').trim().length}`)

        let externalId: string | null = null
        let sendError: string | null = null

        // Route to appropriate channel backend
        if (channel === 'max') {
            const maxMetadata = (chat.metadata || {}) as any
            const maxUiChatId = maxMetadata.oldExternalChatId || maxMetadata.uiChatId || null
            const maxPhone = chat.driver?.phone || maxMetadata.phone || null
            try {
                const result = await getMaxChannelDeliveryV1().sendMedia({
                    chatId: Number(chat.externalChatId),
                    base64,
                    filename,
                    mimeType,
                    caption: caption || '',
                    mediaType,
                    uiChatId: maxUiChatId ? String(maxUiChatId) : undefined,
                    phone: maxPhone ? String(maxPhone) : undefined,
                })
                externalId = result.externalId || null
            } catch (error: any) {
                sendError = error?.message || 'MAX media send failed'
                console.error('[send-media] MAX error (saving as failed):', sendError)
            }
        } else if (channel === 'whatsapp') {
            const waChatId = chat.driver?.phone || chat.externalChatId?.replace('whatsapp:', '') || ''
            let result
            try {
                result = await getWhatsAppChannelDeliveryV1().sendMedia({
                    chatId: waChatId,
                    base64,
                    filename,
                    mimeType,
                    caption,
                    sendAsVoice: mediaType === 'voice',
                    sendAsDocument: mediaType === 'document',
                })
            } catch (error: any) {
                if (error?.message === 'No ready WhatsApp connection') {
                    return NextResponse.json({ error: 'No active WhatsApp connection' }, { status: 503 })
                }
                throw error
            }
            externalId = result.externalId
        } else if (channel === 'telegram') {
            const target = chat.driver?.telegramId?.toString() ||
                           chat.driver?.phone ||
                           chat.externalChatId?.replace('telegram:', '') || ''
            const result = await getTelegramChannelDeliveryV1().sendMedia({
                target,
                base64,
                filename,
                mimeType,
                caption,
                connectionId: profileId,
            })
            // PR-Щ hotfix: TG может вернуть BigInt — приводим к string явно
            externalId = result.externalId != null ? String(result.externalId) : null
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

        // Save outbound message + attachment.
        // Channel already delivered — если БД упадёт, лог + return 200 чтобы
        // оператор не пересылал. UI просто не покажет attachment, но клиент
        // его уже получил.
        let message: any = null
        try {
            message = await prisma.message.create({
                data: {
                    chatId,
                    direction: 'outbound',
                    type: unifiedType as any,
                    content: contentFallback(mediaType, caption),
                    channel: channel as any,
                    externalId,
                    ...(clientMessageId ? { clientMessageId: String(clientMessageId) } : {}),
                    status: sendError ? 'failed' : 'delivered',
                    sentAt: new Date(),
                    metadata: {
                        origin: 'operator', filename, mimeType,
                        ...(sendError ? { sendError } : {}),
                    },
                },
            })
        } catch (dbErr: any) {
            console.error('[send-media] DB message.create failed (channel уже доставил):', dbErr?.message)
            return NextResponse.json({
                success: true,
                delivered: true,
                warning: `Сообщение доставлено клиенту, но не сохранилось в БД: ${dbErr?.message}`,
            })
        }

        try {
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
        } catch (attErr: any) {
            console.warn('[send-media] DB attachment.create failed (non-blocking):', attErr?.message)
        }

        // Broadcast AFTER attachment is saved — include attachment metadata (without url/base64)
        // so the SSE replaces the optimistic cmid-* placeholder with the real message + attachment
        try {
            const fullMsg = await (prisma.message as any).findUnique({
                where: { id: message.id },
                include: {
                    attachments: {
                        select: { id: true, type: true, fileName: true, fileSize: true, mimeType: true }
                    }
                }
            })
            if (fullMsg) broadcastChatMessage(chatId, fullMsg)
        } catch {}

        try {
            await prisma.chat.update({
                where: { id: chatId },
                data: { lastMessageAt: new Date() },
            })
        } catch {}

        if (sendError) {
            return NextResponse.json({
                success: false, messageId: message.id,
                error: sendError,
                warning: 'Файл не отправлен получателю, попытка сохранена в переписке',
            })
        }
        return NextResponse.json({ success: true, messageId: message.id, externalId })
    } catch (err: any) {
        console.error('[send-media] Error:', err)
        return NextResponse.json({ error: err.message }, { status: 500 })
    }
}
