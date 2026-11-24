import { NextRequest, NextResponse } from 'next/server'
const MAX_BYTES = 8 * 1024 * 1024
const ALLOWED_CONTENT_TYPES = new Set([
    'image/jpeg', 'image/png', 'image/webp', 'image/gif',
    'video/mp4', 'video/quicktime', 'video/webm',
    'audio/ogg', 'audio/mpeg', 'audio/mp4',
    'application/pdf', 'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/zip',
])

async function readBoundedBody(response: Response): Promise<Buffer | null> {
    if (!response.body) return null
    const reader = response.body.getReader()
    const chunks: Buffer[] = []
    let total = 0
    try {
        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            total += value.byteLength
            if (total > MAX_BYTES) {
                await reader.cancel().catch(() => {})
                return null
            }
            chunks.push(Buffer.from(value))
        }
        return Buffer.concat(chunks, total)
    } finally {
        reader.releaseLock()
    }
}

function configuredSecret(): string | null {
    const value = process.env.BOT_CRM_SECRET?.trim()
    if (!value || value.length < 32 || value.length > 256 || /placeholder|replace[-_ ]?me|change[-_ ]?me|__generate|your[-_ ]?secret/i.test(value) || /^(.)\1+$/.test(value)) {
        return null
    }
    return value
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ fileId: string }> }) {
    const { fileId } = await params
    if (!/^[A-Za-z0-9_-]{8,256}$/.test(fileId)) {
        return NextResponse.json({ error: 'fileId invalid' }, { status: 400 })
    }

    const secret = configuredSecret()
    const botApiUrl = process.env.TG_BOT_API_URL?.trim()
    if (!secret || !botApiUrl) {
        return NextResponse.json({ error: 'media service unavailable' }, { status: 503 })
    }

    try {
        const baseUrl = new URL(botApiUrl)
        if (baseUrl.protocol !== 'http:' || baseUrl.hostname !== 'tg-bot' || baseUrl.port !== '3001' ||
            baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash || baseUrl.pathname !== '/') {
            return NextResponse.json({ error: 'media service unavailable' }, { status: 503 })
        }
        const endpoint = new URL('/api/bot/file', baseUrl)
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-bot-signature': secret,
            },
            body: JSON.stringify({ fileId }),
            signal: AbortSignal.timeout(15_000),
            cache: 'no-store',
        })
        if (!response.ok) {
            return NextResponse.json({ error: 'media unavailable' }, {
                status: response.status === 404 ? 404 : 502,
                headers: { 'Cache-Control': 'no-store' },
            })
        }

        const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.toLowerCase() || ''
        if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
            return NextResponse.json({ error: 'media type unsupported' }, { status: 502 })
        }
        if (!response.body) {
            return NextResponse.json({ error: 'media service unavailable' }, { status: 502 })
        }
        const bytes = await readBoundedBody(response)
        if (!bytes) {
            return NextResponse.json({ error: 'media too large' }, { status: 413 })
        }

        return new NextResponse(bytes, {
            headers: {
                'Content-Type': contentType,
                'Content-Length': String(bytes.byteLength),
                'Cache-Control': 'private, no-store',
                'X-Content-Type-Options': 'nosniff',
            },
        })
    } catch {
        // Provider URLs and exception text can contain credential-bearing data.
        return NextResponse.json({ error: 'media service unavailable' }, { status: 502 })
    }
}
