import { NextResponse } from 'next/server'

/**
 * The singular legacy MAX ingress could synthesize conversation identity from
 * phone digits or a mutable title. All scraper traffic is owned by the exact,
 * account-bound `/api/webhooks/max` route now, so this endpoint must stay a
 * static tombstone and must not parse, authenticate, read, or mutate state.
 */
export async function POST() {
    return NextResponse.json({
        error: 'MAX_LEGACY_WEBHOOK_RETIRED',
        replacement: '/api/webhooks/max',
    }, { status: 410 })
}
