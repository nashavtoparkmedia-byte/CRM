import { NextResponse } from 'next/server'

// Proxy live history-import progress from max-web-scraper to the browser.
const MAX_SCRAPER_URL = process.env.MAX_SCRAPER_URL || 'http://localhost:3005'

export const dynamic = 'force-dynamic'

export async function GET() {
    try {
        const res = await fetch(`${MAX_SCRAPER_URL}/import-progress`, {
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
