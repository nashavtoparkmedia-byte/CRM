import { NextResponse } from 'next/server'
import { enforceMandatoryFollowup } from '@/lib/triggers'

export const dynamic = 'force-dynamic'

/**
 * GET /api/cron/enforce-followup
 *
 * Idempotent endpoint: enforces mandatory follow-up on high-risk tasks
 * that have no nextActionId set. Safe to call multiple times.
 */
export async function GET() {
    try {
        const result = await enforceMandatoryFollowup()

        return NextResponse.json({
            ok: true,
            enforced: result.enforced,
            timestamp: new Date().toISOString(),
        })
    } catch (err) {
        console.error('[cron/enforce-followup] Error:', err)
        return NextResponse.json(
            { ok: false, error: (err as Error).message },
            { status: 500 }
        )
    }
}
