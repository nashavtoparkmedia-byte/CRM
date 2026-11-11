import { NextResponse } from 'next/server'
import { getIntegrationAdminPrincipal } from '@/modules/identity-access/public/v1'

// Proxy the "restart scraper" action to max-web-scraper.
const MAX_SCRAPER_URL = process.env.MAX_SCRAPER_URL || 'http://localhost:3005'

export const dynamic = 'force-dynamic'

export async function POST() {
    // The live MAX login QR, the scraper's restart and its state belong to the
    // integration administrator only: any other staff or mobile session could
    // otherwise scan the QR into its own account or disrupt the channel.
    if (!await getIntegrationAdminPrincipal()) {
        return NextResponse.json({ error: 'MAX_SCRAPER_ADMIN_REQUIRED' }, { status: 403 })
    }
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
