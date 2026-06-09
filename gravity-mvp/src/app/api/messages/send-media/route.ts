// hot-reload trigger 2026-05-24: per-channel try/catch + verbose logs + file logger
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import fs from 'fs'
import path from 'path'

const MAX_SCRAPER_URL = process.env.MAX_SCRAPER_URL || 'http://localhost:3005'

const DEBUG_LOG_PATH = path.join(process.cwd(), '.send-media-debug.log')
function flog(line: string) {
    try {
        fs.appendFileSync(DEBUG_LOG_PATH, `[${new Date().toISOString()}] ${line}\n`, 'utf8')
    } catch { /* best effort */ }
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
    flog('────── NEW REQUEST ──────')
    try {
        const body = await req.json()
        const { chatId, base64, filename, mimeType, caption, profileId } = body

        flog(`request chatId=${chatId} filename=${filename} mime=${mimeType} captionLen=${(caption||'').length} base64Len=${(base64||'').length} profileId=${profileId||'<none>'}`)

        if (!chatId || !base64 || !filename || !mimeType) {
            flog(`REJECT 400: missing required params`)
            return NextResponse.json(
                { error: 'chatId, base64, filename, mimeType are required' },
                { status: 400 }
            )
        }

        // Get chat to determine channel.
        const chat = await prisma.chat.findUnique({
            where: { id: chatId },
            select: { channel: true, externalChatId: true, driver: { select: { phone: true, id: true } } }
        }) as any
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
            flog(`REJECT 404: chat not found id=${chatId}`)
            return NextResponse.json({ error: 'Chat not found' }, { status: 404 })
        }

        flog(`chat: channel=${chat.channel} externalChatId=${chat.externalChatId} driverPhone=${chat.driver?.phone||'<none>'} driverTelegramId=${chat.driver?.telegramId||'<none>'}`)

        const mediaType = detectMediaType(mimeType)
        const channel = chat.channel
        const unifiedType = mediaType === 'voice' ? 'voice' : mediaType === 'audio' ? 'audio' :
                           mediaType === 'video' ? 'video' : mediaType === 'image' ? 'image' : 'document'

        // Safety strip: frontend уже чистит data: prefix, но если кто-то вызовет
        // route напрямую с raw dataUrl — нужна страховка для всех каналов.
        const cleanBase64 = base64.startsWith('data:') ? base64.split(',')[1] : base64

        console.log(`[send-media] start channel=${channel} mediaType=${mediaType} filename=${filename} mime=${mimeType} chatId=${chatId} externalChatId=${chat.externalChatId} base64Len=${cleanBase64.length}`)
        flog(`mediaType=${mediaType} unifiedType=${unifiedType} cleanBase64Len=${cleanBase64.length}`)

        let externalId: string | null = null

        // Route to appropriate channel backend
        if (channel === 'max') {
            const target = chat.externalChatId?.replace(/^max:/, '') ||
                           chat.driver?.phone?.replace(/\D/g, '') || ''
            console.log(`[send-media][MAX] POST ${MAX_SCRAPER_URL}/send-media target=${target}`)
            flog(`[MAX] POST ${MAX_SCRAPER_URL}/send-media target=${target}`)
            let res
            try {
                res = await fetch(`${MAX_SCRAPER_URL}/send-media`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chatId: target,
                        base64: cleanBase64,
                        filename, mimeType, caption: caption || '',
                        mediaType,
                    }),
                })
            } catch (fetchErr: any) {
                console.error('[send-media][MAX] fetch failed:', fetchErr?.message)
                flog(`[MAX] FETCH FAILED: ${fetchErr?.message}\n${fetchErr?.stack||''}`)
                return NextResponse.json(
                    { error: `MAX scraper unreachable at ${MAX_SCRAPER_URL}: ${fetchErr?.message}` },
                    { status: 502 }
                )
            }
            flog(`[MAX] scraper http status=${res.status} ok=${res.ok}`)
            if (!res.ok) {
                const err = await res.json().catch(() => ({ error: res.statusText }))
                console.error(`[send-media][MAX] scraper ${res.status}:`, err)
                flog(`[MAX] scraper ERROR body: ${JSON.stringify(err)}`)
                return NextResponse.json(
                    { error: `MAX scraper ${res.status}`, details: err },
                    { status: 502 }
                )
            }
            const okBody = await res.json().catch(() => ({}))
            flog(`[MAX] scraper OK body: ${JSON.stringify(okBody)}`)
            console.log('[send-media][MAX] scraper OK')
        } else if (channel === 'whatsapp') {
            const { sendMedia } = await import('@/lib/whatsapp/WhatsAppService')
            const connection = await (prisma as any).whatsAppConnection.findFirst({
                where: { status: 'ready' },
                orderBy: { createdAt: 'asc' }
            })
            if (!connection) {
                console.error('[send-media][WA] no ready WhatsApp connection')
                flog(`[WA] REJECT 503: no ready WhatsApp connection`)
                return NextResponse.json({ error: 'No active WhatsApp connection' }, { status: 503 })
            }
            const waChatId = chat.driver?.phone || chat.externalChatId?.replace('whatsapp:', '') || ''
            console.log(`[send-media][WA] connectionId=${connection.id} waChatId=${waChatId} (from driver.phone=${chat.driver?.phone || 'null'} externalChatId=${chat.externalChatId})`)
            flog(`[WA] connectionId=${connection.id} waChatId=${waChatId}`)
            if (!waChatId) {
                flog(`[WA] REJECT 400: cannot resolve waChatId`)
                return NextResponse.json({ error: 'Cannot resolve WhatsApp chat target' }, { status: 400 })
            }
            try {
                const result = await sendMedia(
                    connection.id, waChatId, cleanBase64, filename, mimeType, caption,
                    { sendAsVoice: mediaType === 'voice', sendAsDocument: mediaType === 'document' }
                )
                externalId = result.externalId
                console.log(`[send-media][WA] sent externalId=${externalId}`)
                flog(`[WA] SUCCESS externalId=${externalId}`)
            } catch (waErr: any) {
                console.error('[send-media][WA] sendMedia failed:', waErr?.message, waErr?.stack)
                flog(`[WA] sendMedia FAILED: ${waErr?.message}\n${waErr?.stack||''}`)
                return NextResponse.json(
                    { error: `WhatsApp send failed: ${waErr?.message || 'unknown'}` },
                    { status: 502 }
                )
            }
        } else if (channel === 'telegram') {
            const { sendTelegramMedia } = await import('@/app/tg-actions')
            const target = chat.driver?.telegramId?.toString() ||
                           chat.driver?.phone ||
                           chat.externalChatId?.replace('telegram:', '') || ''
            console.log(`[send-media][TG] target=${target} profileId=${profileId || 'default'}`)
            flog(`[TG] target=${target} profileId=${profileId || 'default'}`)
            if (!target) {
                flog(`[TG] REJECT 400: cannot resolve target`)
                return NextResponse.json({ error: 'Cannot resolve Telegram chat target' }, { status: 400 })
            }
            try {
                const result = await sendTelegramMedia(target, cleanBase64, filename, mimeType, caption, profileId)
                externalId = result.externalId != null ? String(result.externalId) : null
                console.log(`[send-media][TG] sent externalId=${externalId}`)
                flog(`[TG] SUCCESS externalId=${externalId}`)
            } catch (tgErr: any) {
                console.error('[send-media][TG] sendTelegramMedia failed:', tgErr?.message, tgErr?.stack)
                flog(`[TG] sendTelegramMedia FAILED: ${tgErr?.message}\n${tgErr?.stack||''}`)
                return NextResponse.json(
                    { error: `Telegram send failed: ${tgErr?.message || 'unknown'}` },
                    { status: 502 }
                )
            }
        } else {
            flog(`REJECT 400: unknown channel=${channel}`)
            return NextResponse.json(
                { error: `Media send not implemented for channel: ${channel}` },
                { status: 400 }
            )
        }

        const dataUrl = `data:${mimeType};base64,${cleanBase64}`
        const approxSize = Math.round(cleanBase64.length * 0.75)

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
                    status: 'delivered',
                    sentAt: new Date(),
                    metadata: { origin: 'operator', filename, mimeType },
                },
            })
            flog(`DB Message created id=${message.id}`)
        } catch (dbErr: any) {
            console.error('[send-media] DB message.create failed (channel уже доставил):', dbErr?.message)
            flog(`DB Message.create FAILED (channel delivered): ${dbErr?.message}\n${dbErr?.stack||''}`)
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
            flog(`DB MessageAttachment created`)
        } catch (attErr: any) {
            console.warn('[send-media] DB attachment.create failed (non-blocking):', attErr?.message)
            flog(`DB MessageAttachment.create FAILED (non-blocking): ${attErr?.message}`)
        }

        try {
            await prisma.chat.update({
                where: { id: chatId },
                data: { lastMessageAt: new Date() },
            })
        } catch {}

        flog(`RESPONSE 200 messageId=${message.id} externalId=${externalId}`)
        return NextResponse.json({ success: true, messageId: message.id, externalId })
    } catch (err: any) {
        console.error('[send-media] Error:', err)
        flog(`UNCAUGHT ERROR: ${err?.message}\n${err?.stack||''}`)
        return NextResponse.json({ error: err.message }, { status: 500 })
    }
}
