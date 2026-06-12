import { NextResponse } from 'next/server'

// Proxy the browser → max-web-scraper status. The client used to fetch
// http://localhost:3005 directly, which on prod means the USER's machine
// (nothing there) → "Скрейпер офлайн". Here the gravity-mvp server reaches
// the scraper over the internal Docker network via MAX_SCRAPER_URL.
const MAX_SCRAPER_URL = process.env.MAX_SCRAPER_URL || 'http://localhost:3005'

export const dynamic = 'force-dynamic'

export async function GET() {
    try {
        const res = await fetch(`${MAX_SCRAPER_URL}/status`, {
            cache: 'no-store',
            signal: AbortSignal.timeout(5000),
        })
        const body = await res.text()
        return new NextResponse(body, {
            status: res.status,
            headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        })
    } catch (err: any) {
        return NextResponse.json(
            { error: 'scraper_unreachable', message: err?.message ?? String(err) },
            { status: 502 },
        )
    }
}
