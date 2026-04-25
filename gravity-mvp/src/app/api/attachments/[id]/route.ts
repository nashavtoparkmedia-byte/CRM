/**
 * Lazy media endpoint — Phase 2 of chat-speed work.
 *
 * MessageAttachment.url stores either:
 *   - a base64 data URL ("data:image/jpeg;base64,...") for WhatsApp /
 *     Telegram media we downloaded ourselves, or
 *   - an external HTTPS URL (e.g. MAX stickers from i.oneme.ru).
 *
 * /api/messages used to embed url in every message. With many media
 * messages in a chat that produced 1MB+ JSON responses and a 3-second
 * "open chat" lag.
 *
 * Now /api/messages returns id + meta only; the UI renders
 * <img src="/api/attachments/{id}">. The browser fetches each one
 * once and caches it (HTTP Cache-Control), so repeat opens hit the
 * cache instantly.
 *
 * For data URLs we decode the base64 once on the server and return
 * the raw bytes with the right Content-Type — much smaller than
 * shipping the data: URI through JSON.
 *
 * For external URLs we 302-redirect to the source. Browser still
 * caches by upstream URL, no extra hop on warm cache.
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365

export async function GET(
    _req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    const { id } = await params
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

    const att = await prisma.messageAttachment.findUnique({
        where: { id },
        select: { url: true, mimeType: true, fileName: true },
    })
    if (!att || !att.url) {
        return NextResponse.json({ error: 'not found' }, { status: 404 })
    }

    // External URL → just redirect. Browser handles caching upstream.
    if (att.url.startsWith('http://') || att.url.startsWith('https://')) {
        return NextResponse.redirect(att.url, 302)
    }

    // data URL → decode and stream as bytes.
    if (att.url.startsWith('data:')) {
        const commaIdx = att.url.indexOf(',')
        if (commaIdx < 0) {
            return NextResponse.json({ error: 'malformed data url' }, { status: 500 })
        }
        const meta = att.url.slice(5, commaIdx) // e.g. "image/jpeg;base64"
        const isBase64 = meta.endsWith(';base64')
        const mime = (isBase64 ? meta.slice(0, -7) : meta) || att.mimeType || 'application/octet-stream'
        const dataPart = att.url.slice(commaIdx + 1)
        const bytes = isBase64
            ? Buffer.from(dataPart, 'base64')
            : Buffer.from(decodeURIComponent(dataPart), 'utf-8')

        const headers: Record<string, string> = {
            'Content-Type': mime,
            'Content-Length': String(bytes.length),
            // Aggressive cache — content is keyed on attachment id, which
            // never changes (we'd create a new row instead).
            'Cache-Control': `public, max-age=${ONE_YEAR_SECONDS}, immutable`,
        }
        if (att.fileName) {
            // inline so the browser shows it in <img>; download flag is
            // controlled by the UI <a download> attribute, not us.
            headers['Content-Disposition'] = `inline; filename="${att.fileName.replace(/"/g, '')}"`
        }
        return new NextResponse(new Uint8Array(bytes), { status: 200, headers })
    }

    // Unknown scheme — best-effort 404
    return NextResponse.json({ error: 'unsupported url scheme' }, { status: 415 })
}
