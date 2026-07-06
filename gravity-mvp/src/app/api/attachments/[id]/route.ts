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
import sharp from 'sharp'

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365

function asciiFileNameFallback(fileName: string): string {
    const fallback = fileName
        .replace(/["\\]/g, '')
        .replace(/[^\x20-\x7E]/g, '_')
        .trim()
    return fallback || 'file'
}

function encodeRFC5987Value(value: string): string {
    return encodeURIComponent(value)
        .replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

function inlineContentDisposition(fileName: string): string {
    const fallback = asciiFileNameFallback(fileName)
    return `inline; filename="${fallback}"; filename*=UTF-8''${encodeRFC5987Value(fileName)}`
}

export async function GET(
    req: NextRequest,
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

    // External URL — proxy and convert WEBP→JPEG so browser saves as .jpg
    if (att.url.startsWith('http://') || att.url.startsWith('https://')) {
        try {
            const upstream = await fetch(att.url, { next: { revalidate: 0 } })
            if (!upstream.ok) return NextResponse.redirect(att.url, 302)
            const upstreamMime = upstream.headers.get('content-type')?.split(';')[0].trim() || att.mimeType || 'application/octet-stream'

            // External page (ok.ru, YouTube, etc.) masquerading as video attachment —
            // redirect user to the page instead of proxying HTML into a <video> element.
            const isMedia = upstreamMime.startsWith('video/') || upstreamMime.startsWith('audio/')
                         || upstreamMime.startsWith('image/') || upstreamMime === 'application/pdf'
            if (!isMedia) return NextResponse.redirect(att.url, 302)

            let bytes = Buffer.from(await upstream.arrayBuffer())
            let outputMime = upstreamMime

            // Build a clean filename: strip query params/hash from URL path
            let outputFileName = att.fileName
            if (!outputFileName) {
                try {
                    const u = new URL(att.url)
                    outputFileName = u.pathname.split('/').pop() || 'file'
                } catch {
                    outputFileName = att.url.split('/').pop()?.split('?')[0] || 'file'
                }
            }

            if (upstreamMime === 'image/webp') {
                bytes = Buffer.from(await sharp(bytes).jpeg({ quality: 92 }).toBuffer())
                outputMime = 'image/jpeg'
                outputFileName = outputFileName!.replace(/\.webp$/i, '.jpg')
            }

            // Ensure image files have a proper extension so browser offers correct file type
            if (!outputFileName!.includes('.')) {
                const extByMime: Record<string, string> = {
                    'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
                    'image/webp': '.webp', 'video/mp4': '.mp4', 'audio/ogg': '.ogg',
                    'application/pdf': '.pdf',
                }
                outputFileName += extByMime[outputMime] || ''
            }

            return new NextResponse(new Uint8Array(bytes), {
                status: 200,
                headers: {
                    'Content-Type': outputMime,
                    'Content-Length': String(bytes.length),
                    'Accept-Ranges': 'bytes',
                    'Cache-Control': `public, max-age=${ONE_YEAR_SECONDS}, immutable`,
                    'Content-Disposition': inlineContentDisposition(outputFileName!),
                },
            })
        } catch {
            return NextResponse.redirect(att.url, 302)
        }
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

        // Convert WEBP images to JPEG so browsers offer .jpg in "Save image as"
        let outputBytes: Buffer = bytes
        let outputMime = mime
        let outputFileName = att.fileName || null
        if (mime === 'image/webp') {
            try {
                outputBytes = Buffer.from(await sharp(bytes).jpeg({ quality: 92 }).toBuffer())
                outputMime = 'image/jpeg'
                if (outputFileName) {
                    outputFileName = outputFileName.replace(/\.webp$/i, '.jpg')
                }
            } catch {}
        }

        // Video/audio: support HTTP range requests so Chrome can seek and play.
        // Without Accept-Ranges + 206 responses, Chrome refuses to play MP4.
        const rangeHeader = req.headers.get('range')
        if (rangeHeader && (outputMime.startsWith('video/') || outputMime.startsWith('audio/'))) {
            const totalSize = outputBytes.length
            const match = rangeHeader.match(/bytes=(\d+)-(\d*)/)
            if (match) {
                const start = parseInt(match[1], 10)
                const end   = match[2] ? Math.min(parseInt(match[2], 10), totalSize - 1) : totalSize - 1
                const chunk = outputBytes.subarray(start, end + 1)
                const rangeHeaders: Record<string, string> = {
                    'Content-Type':   outputMime,
                    'Content-Range':  `bytes ${start}-${end}/${totalSize}`,
                    'Accept-Ranges':  'bytes',
                    'Content-Length': String(chunk.length),
                    'Cache-Control':  `public, max-age=${ONE_YEAR_SECONDS}, immutable`,
                }
                if (outputFileName) rangeHeaders['Content-Disposition'] = inlineContentDisposition(outputFileName)
                return new NextResponse(new Uint8Array(chunk), { status: 206, headers: rangeHeaders })
            }
        }

        const headers: Record<string, string> = {
            'Content-Type':  outputMime,
            'Content-Length': String(outputBytes.length),
            'Accept-Ranges': 'bytes',
            // Aggressive cache — content is keyed on attachment id, which
            // never changes (we'd create a new row instead).
            'Cache-Control': `public, max-age=${ONE_YEAR_SECONDS}, immutable`,
        }
        if (outputFileName) {
            headers['Content-Disposition'] = inlineContentDisposition(outputFileName)
        }
        return new NextResponse(new Uint8Array(outputBytes), { status: 200, headers })
    }

    // Unknown scheme — best-effort 404
    return NextResponse.json({ error: 'unsupported url scheme' }, { status: 415 })
}
