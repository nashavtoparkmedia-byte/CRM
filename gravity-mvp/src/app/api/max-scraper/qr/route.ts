import { NextResponse } from 'next/server'

// Proxy the QR PNG from max-web-scraper. Browser <img> hits this same-origin
// route; gravity-mvp fetches the image over the internal Docker network.
const MAX_SCRAPER_URL = process.env.MAX_SCRAPER_URL || 'http://localhost:3005'

export const dynamic = 'force-dynamic'

export async function GET() {
    try {
        const res = await fetch(`${MAX_SCRAPER_URL}/qr`, {
            cache: 'no-store',
            signal: AbortSignal.timeout(5000),
        })
        if (!res.ok) return new NextResponse(null, { status: res.status })
        const buf = Buffer.from(await res.arrayBuffer())
        return new NextResponse(buf, {
            status: 200,
            headers: {
                'content-type': res.headers.get('content-type') || 'image/png',
                'cache-control': 'no-store',
            },
        })
    } catch {
        return new NextResponse(null, { status: 502 })
    }
}
