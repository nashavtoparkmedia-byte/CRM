import { NextResponse } from 'next/server'
import { evaluateEscalations } from '@/lib/triggers'

export const dynamic = 'force-dynamic'

/**
 * GET /api/cron/escalations
 *
 * Idempotent endpoint: escalates high-risk tasks whose mandatory
 * follow-up deadline has passed. Safe to call multiple times.
 */
export async function GET() {
    try {
        const result = await evaluateEscalations()

        return NextResponse.json({
            ok: true,
            escalated: result.escalated,
            timestamp: new Date().toISOString(),
        })
    } catch (err) {
        console.error('[cron/escalations] Error:', err)
        return NextResponse.json(
            { ok: false, error: (err as Error).message },
            { status: 500 }
        )
    }
}
