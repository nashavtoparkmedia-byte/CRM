import { NextRequest, NextResponse } from 'next/server'
import { backfillTelegramPhonesForOrphanIdentities } from '@/app/tg-actions'

/**
 * POST /api/debug-db/backfill-tg-phones
 *
 * Body: { dryRun?: boolean, limit?: number, throttleMs?: number }
 *   dryRun     — default true; pass false to actually mutate.
 *   limit      — default 0 (all); cap for piloting.
 *   throttleMs — default 250; gap between gramJS getEntity calls.
 *
 * Walks orphan TG ContactIdentity rows and tries to attach a real phone
 * via gramJS. See backfillTelegramPhonesForOrphanIdentities for details.
 */
export async function POST(req: NextRequest) {
    let body: any = {}
    try { body = await req.json() } catch { /* empty body ok */ }

    const result = await backfillTelegramPhonesForOrphanIdentities({
        dryRun: body.dryRun,
        limit: body.limit,
        throttleMs: body.throttleMs,
    })

    return NextResponse.json(result)
}
