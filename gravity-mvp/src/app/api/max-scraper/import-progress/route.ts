import { NextResponse } from 'next/server'
import { getIntegrationAdminPrincipal } from '@/modules/identity-access/public/v1'

// Proxy live history-import progress from max-web-scraper to the browser.
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
