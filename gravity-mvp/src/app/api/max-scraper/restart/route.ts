import { NextResponse } from 'next/server'

// Proxy the "restart scraper" action to max-web-scraper.
const MAX_SCRAPER_URL = process.env.MAX_SCRAPER_URL || 'http://localhost:3005'

export const dynamic = 'force-dynamic'

export async function POST() {
    try {
        const res = await fetch(`${MAX_SCRAPER_URL}/restart`, {
            method: 'POST',
            cache: 'no-store',
            signal: AbortSignal.timeout(10000),
        })
        const body = await res.text()
        return new NextResponse(body, {
            status: res.status,
            headers: { 'content-type': res.headers.get('content-type') || 'application/json' },
        })
    } catch (err: any) {
        return NextResponse.json(
            { error: 'scraper_unreachable', message: err?.message ?? String(err) },
            { status: 502 },
        )
    }
}
