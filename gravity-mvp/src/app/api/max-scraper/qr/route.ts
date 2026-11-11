import { NextResponse } from 'next/server'
import { getIntegrationAdminPrincipal } from '@/modules/identity-access/public/v1'

// Proxy the QR PNG from max-web-scraper. Browser <img> hits this same-origin
// route; gravity-mvp fetches the image over the internal Docker network.
const MAX_SCRAPER_URL = process.env.MAX_SCRAPER_URL || 'http://localhost:3005'

export const dynamic = 'force-dynamic'

export async function GET() {
    // The live MAX login QR, the scraper's restart and its state belong to the
    // integration administrator only: any other staff or mobile session could
    // otherwise scan the QR into its own account or disrupt the channel.
    if (!await getIntegrationAdminPrincipal()) {
        return NextResponse.json({ error: 'MAX_SCRAPER_ADMIN_REQUIRED' }, { status: 403 })
    }
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
