import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { broadcastChatMessage } from '@/lib/messageStreamBus'
import { getMaxChannelDeliveryV1, getTelegramChannelDeliveryV1, getWhatsAppChannelDeliveryV1 } from '@/modules/messaging/public/v1/channel-delivery-runtime'
import { prepareOutboundConversationV1 } from '@/modules/messaging/public/v1/outbound-conversation-identity-runtime'

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

        // Resolve the exact ContactIdentity/account/transport tuple before any
        // provider or database mutation. Provider targets must never be
        // reconstructed from Driver phone/Telegram fields.
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
        const outbound = await prepareOutboundConversationV1(chat, profileId)
        if (!outbound.chatId || outbound.chatId !== chatId) {
            throw new Error('CONTACT_CONVERSATION_IDENTITY_BINDING_MISMATCH')
        }

        const mediaType = detectMediaType(mimeType)
        const channel = outbound.channel
        const unifiedType = mediaType === 'voice' ? 'voice' : mediaType === 'audio' ? 'audio' :
                           mediaType === 'video' ? 'video' : mediaType === 'image' ? 'image' : 'document'

        console.log(`[send-media] channel=${channel} mediaType=${mediaType} filename=${filename} mime=${mimeType} captionLength=${String(caption || '').trim().length}`)

        let externalId: string | null = null
        let sendError: string | null = null

        // Route to appropriate channel backend
        if (channel === 'max') {
            try {
                const result = await getMaxChannelDeliveryV1().sendMedia({
                    chatId: outbound.target,
                    base64,
                    filename,
                    mimeType,
                    caption: caption || '',
                    mediaType,
                    providerAccountId: outbound.providerAccountId,
                    connectionId: outbound.connectionId,
                    isPersonal: outbound.isMaxPersonal,
                })
                externalId = result.externalId || null
            } catch (error: any) {
                sendError = error?.message || 'MAX media send failed'
                console.error('[send-media] MAX error (saving as failed):', sendError)
            }
        } else if (channel === 'whatsapp') {
            let result
            try {
                result = await getWhatsAppChannelDeliveryV1().sendMedia({
                    chatId: outbound.target,
                    base64,
                    filename,
                    mimeType,
                    caption,
                    sendAsVoice: mediaType === 'voice',
                    sendAsDocument: mediaType === 'document',
                    connectionId: outbound.connectionId,
                })
            } catch (error: any) {
                if (error?.message === 'No ready WhatsApp connection') {
                    return NextResponse.json({ error: 'No active WhatsApp connection' }, { status: 503 })
                }
                throw error
            }
            externalId = result.externalId
        } else if (channel === 'telegram') {
            const result = await getTelegramChannelDeliveryV1().sendMedia({
                target: outbound.target,
                internalChatId: outbound.chatId,
                providerAccountId: outbound.providerAccountId,
                identityTarget: outbound.identityTarget,
                base64,
                filename,
                mimeType,
                caption,
                connectionId: outbound.connectionId,
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
                    chatId: outbound.chatId,
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
            if (fullMsg) broadcastChatMessage(outbound.chatId, fullMsg)
        } catch {}

        try {
            await prisma.chat.update({
                where: { id: outbound.chatId },
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
