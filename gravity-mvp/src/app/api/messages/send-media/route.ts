import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { broadcastChatMessage } from '@/lib/messageStreamBus'

const MAX_SCRAPER_URL = process.env.MAX_SCRAPER_URL || 'http://localhost:3005'

type MaxDeliveryStatus =
    | 'queued'
    | 'upload_started'
    | 'uploaded'
    | 'send_requested'
    | 'max_echo_received'
    | 'delivered'
    | 'failed'

function sanitizeForMaxDeliveryLog(value: unknown): unknown {
    if (value == null) return value
    if (typeof value === 'string') {
        if (/^data:.*;base64,/i.test(value)) return '[data-url-redacted]'
        if (/^[A-Za-z0-9+/=_-]{400,}$/.test(value)) return '[base64-or-token-redacted]'
        return value.length > 300 ? `${value.slice(0, 120)}...[${value.length}]` : value
    }
    if (Array.isArray(value)) return value.map(sanitizeForMaxDeliveryLog)
    if (typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
                key,
                /token|cookie|secret|authorization|base64|password/i.test(key)
                    ? '[redacted]'
                    : sanitizeForMaxDeliveryLog(entry),
            ])
        )
    }
    return value
}

function maxDeliveryLog(event: Record<string, unknown>) {
    console.log('[MAX_DELIVERY]', JSON.stringify(sanitizeForMaxDeliveryLog({
        ts: new Date().toISOString(),
        ...event,
    })))
}

function isRealMaxMessageId(id: unknown): boolean {
    return /^d301/i.test(String(id || ''))
}

function isValidMaxMediaDelivery(resData: Record<string, any>): boolean {
    const source = String(resData?.source || '')
    const candidateId = resData?.maxMessageId || resData?.externalId
    if (source === 'op180' || source === 'op180_compact') return false
    return Boolean(resData?.deliveryConfirmed && isRealMaxMessageId(candidateId))
}

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
            select: { channel: true, name: true, externalChatId: true, metadata: true, driver: { select: { phone: true, id: true } } }
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

        console.log(`[send-media] channel=${channel} mediaType=${mediaType} filename=${filename} mime=${mimeType}`)

        let externalId: string | null = null
        let sendError: string | null = null
        let maxDeliveryStatus: MaxDeliveryStatus | null = channel === 'max' ? 'queued' : null
        let maxDeliveryConfirmed = false
        let maxDeliveryResponse: Record<string, any> | null = null
        let maxProtocolChatId: string | null = null
        let maxWebRouteId: string | null = null

        // Route to appropriate channel backend
        if (channel === 'max') {
            const maxMetadata = (chat.metadata || {}) as any
            const rawMaxTarget = String(chat.externalChatId || '').includes(':')
                ? String(chat.externalChatId || '').split(':').slice(1).join(':')
                : String(chat.externalChatId || '')
            const cleanMaxTarget = rawMaxTarget.replace(/\D/g, '')
            maxProtocolChatId = cleanMaxTarget || null
            maxWebRouteId = maxMetadata.oldExternalChatId || maxMetadata.uiChatId || null
            if (!cleanMaxTarget) {
                sendError = `Invalid MAX target: ${chat.externalChatId || ''}`
            }
            maxDeliveryLog({
                operation: 'send',
                status: 'queued',
                clientMessageId,
                conversationId: cleanMaxTarget || null,
                protocolChatId: maxProtocolChatId,
                webRouteId: maxWebRouteId,
                uploadId: filename,
            })
            if (!sendError) {
            const res = await fetch(`${MAX_SCRAPER_URL}/send-media`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chatId: cleanMaxTarget,
                    base64, filename, mimeType, caption: caption || '',
                    mediaType,
                    phone: chat.driver?.phone || chat.name || '',
                    uiChatId: maxMetadata.oldExternalChatId || maxMetadata.uiChatId,
                }),
            })
            const resData = await res.json().catch(() => ({ error: res.statusText }))
            maxDeliveryResponse = resData
            if (!res.ok) {
                sendError = resData.error || res.statusText
                maxDeliveryStatus = 'failed'
                console.error('[send-media] MAX error (saving as failed):', sendError)
                // Don't return — save to DB so operator sees the attempt in chat
            } else {
                const candidateExternalId = resData.externalId || resData.maxMessageId || null
                maxDeliveryConfirmed = isValidMaxMediaDelivery(resData)
                externalId = maxDeliveryConfirmed ? candidateExternalId : null
                maxDeliveryStatus = maxDeliveryConfirmed ? 'delivered' : 'send_requested'
            }
            maxDeliveryLog({
                operation: maxDeliveryConfirmed ? 'echo' : 'send',
                status: maxDeliveryStatus,
                clientMessageId,
                conversationId: cleanMaxTarget,
                protocolChatId: maxProtocolChatId,
                webRouteId: maxWebRouteId,
                uploadId: filename,
                maxMessageId: maxDeliveryConfirmed ? (resData.maxMessageId || externalId || null) : null,
                externalId,
                error: sendError,
                scraperDeliveryStatus: resData.deliveryStatus || null,
                scraperSource: resData.source || null,
                scraperCandidateMessageId: maxDeliveryConfirmed ? null : (resData.maxMessageId || resData.externalId || null),
            })
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
        const dbMessageStatus = sendError ? 'failed' : (channel === 'max' ? (maxDeliveryConfirmed ? 'delivered' : 'sent') : 'delivered')
        const maxDeliveryMetadata = channel === 'max' ? {
            status: maxDeliveryStatus,
            deliveryConfirmed: maxDeliveryConfirmed,
            clientMessageId: clientMessageId ? String(clientMessageId) : null,
            conversationId: maxProtocolChatId,
            protocolChatId: maxProtocolChatId,
            webRouteId: maxWebRouteId,
            uploadId: filename,
            maxMessageId: maxDeliveryConfirmed ? (maxDeliveryResponse?.maxMessageId || externalId || null) : null,
            externalId,
            operation: maxDeliveryConfirmed ? 'echo' : 'send',
            error: sendError,
            scraperDeliveryStatus: maxDeliveryResponse?.deliveryStatus || null,
            scraperSource: maxDeliveryResponse?.source || null,
            scraperCandidateMessageId: maxDeliveryConfirmed ? null : (maxDeliveryResponse?.maxMessageId || maxDeliveryResponse?.externalId || null),
        } : undefined
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
                    status: dbMessageStatus,
                    sentAt: new Date(),
                    metadata: {
                        origin: 'operator', filename, mimeType,
                        ...(maxDeliveryMetadata ? { maxDelivery: maxDeliveryMetadata } : {}),
                        ...(sendError ? { sendError } : {}),
                    },
                },
            })
            if (channel === 'max') {
                maxDeliveryLog({
                    ...(maxDeliveryMetadata || {}),
                    crmMessageId: message.id,
                    status: maxDeliveryStatus,
                })
            }
        } catch (dbErr: any) {
            console.error('[send-media] DB message.create failed (channel уже доставил):', dbErr?.message)
            return NextResponse.json({
                success: true,
                delivered: channel === 'max' ? maxDeliveryConfirmed : true,
                status: maxDeliveryStatus,
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
                delivered: false,
                status: maxDeliveryStatus,
                error: sendError,
                warning: 'Файл не отправлен получателю, попытка сохранена в переписке',
            })
        }
        return NextResponse.json({
            success: true,
            messageId: message.id,
            externalId,
            delivered: channel === 'max' ? maxDeliveryConfirmed : true,
            status: channel === 'max' ? maxDeliveryStatus : 'delivered',
        })
    } catch (err: any) {
        console.error('[send-media] Error:', err)
        return NextResponse.json({ error: err.message }, { status: 500 })
    }
}
