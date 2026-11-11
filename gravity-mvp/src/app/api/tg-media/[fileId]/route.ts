/**
 * PR-Ц: Proxy для TG-вложений по file_id.
 *
 * tg-bot передаёт в webhook file_id из Telegram. Само скачивание делается
 * по запросу когда оператор открывает чат / кликает на вложение:
 *   GET /api/tg-media/<file_id>
 *
 * Поток:
 *   1. Читаем токен бота из примонтированного секретного файла
 *      (TELEGRAM_BOT_TOKEN_FILE); без него маршрут отвечает 503.
 *   2. getFile(file_id) → file_path
 *   3. download https://api.telegram.org/file/bot<TOKEN>/<file_path>
 *   4. Stream response с правильным Content-Type / Content-Disposition
 *
 * Простой in-memory cache file_id→buffer на 5 минут (большинство просмотров
 * подряд в одну сессию).
 */
import { NextRequest, NextResponse } from 'next/server'
import { ProxyAgent, fetch as undiciFetch } from 'undici'

import { readTelegramBotTokenV1 } from '@/modules/telegram-channel/public/v1'

const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY
const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined

// in-memory cache file_id → {buffer, mimeType, expiresAt}
const cache = new Map<string, { buffer: Buffer; mimeType: string; filename: string | null; expiresAt: number }>()
const CACHE_TTL_MS = 5 * 60 * 1000

export async function GET(_req: NextRequest, { params }: { params: Promise<{ fileId: string }> }) {
    const { fileId } = await params
    if (!fileId) {
        return NextResponse.json({ error: 'fileId required' }, { status: 400 })
    }

    // Cache hit
    const cached = cache.get(fileId)
    if (cached && cached.expiresAt > Date.now()) {
        return new NextResponse(cached.buffer as any, {
            headers: {
                'Content-Type': cached.mimeType,
                'Content-Disposition': cached.filename
                    ? `inline; filename="${encodeURIComponent(cached.filename)}"`
                    : 'inline',
                'Cache-Control': 'private, max-age=300',
            },
        })
    }

    try {
        let token: string
        try {
            token = await readTelegramBotTokenV1()
        } catch {
            // No token file is mounted: refuse cleanly, never fall back.
            return NextResponse.json({ error: 'TELEGRAM_BOT_MEDIA_UNCONFIGURED' }, { status: 503 })
        }
        const fetchOpts = dispatcher ? { dispatcher } : {}

        // 1. getFile → file_path
        const infoResp = await undiciFetch(
            `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`,
            fetchOpts,
        )
        const info: any = await infoResp.json()
        if (!info.ok) {
            return NextResponse.json({ error: info.description || 'getFile failed' }, { status: 502 })
        }
        const filePath: string = info.result.file_path
        const fileName: string = filePath.split('/').pop() || 'file'
        const mimeType = guessMime(fileName)

        // 2. Download file content
        const fileResp = await undiciFetch(
            `https://api.telegram.org/file/bot${token}/${filePath}`,
            fetchOpts,
        )
        if (!fileResp.ok) {
            return NextResponse.json({ error: `download failed: ${fileResp.status}` }, { status: 502 })
        }
        const arrayBuf = await fileResp.arrayBuffer()
        const buffer = Buffer.from(arrayBuf)

        // 3. Cache + respond
        cache.set(fileId, { buffer, mimeType, filename: fileName, expiresAt: Date.now() + CACHE_TTL_MS })
        // Чистим истёкшие записи (lazy)
        if (cache.size > 100) {
            const now = Date.now()
            for (const [k, v] of cache.entries()) if (v.expiresAt < now) cache.delete(k)
        }

        return new NextResponse(buffer as any, {
            headers: {
                'Content-Type': mimeType,
                'Content-Disposition': `inline; filename="${encodeURIComponent(fileName)}"`,
                'Cache-Control': 'private, max-age=300',
            },
        })
    } catch (e: unknown) {
        // The request URLs carry the bot token, so neither the error object nor
        // its message is logged or returned; the error class is enough.
        console.error(`[tg-media] fetch failed: ${e instanceof Error ? e.name : 'unknown'}`)
        return NextResponse.json({ error: 'TELEGRAM_BOT_MEDIA_UNAVAILABLE' }, { status: 502 })
    }
}

function guessMime(filename: string): string {
    const ext = filename.toLowerCase().split('.').pop() || ''
    const map: Record<string, string> = {
        jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
        mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
        ogg: 'audio/ogg', oga: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4',
        pdf: 'application/pdf',
        doc: 'application/msword',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        xls: 'application/vnd.ms-excel',
        xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        zip: 'application/zip',
    }
    return map[ext] || 'application/octet-stream'
}
