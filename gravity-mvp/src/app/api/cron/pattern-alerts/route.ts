import { NextResponse } from 'next/server'
import { detectRootCausePatterns } from '@/lib/triggers'

export const dynamic = 'force-dynamic'

/**
 * GET /api/cron/pattern-alerts
 *
 * Idempotent endpoint: detects repeating root cause patterns
 * and creates pattern_alert events. Safe to call multiple times.
 */
export async function GET() {
    try {
        const result = await detectRootCausePatterns()

        return NextResponse.json({
            ok: true,
            alerts: result.alerts,
            patterns: result.patterns,
            timestamp: new Date().toISOString(),
        })
    } catch (err) {
        console.error('[cron/pattern-alerts] Error:', err)
        return NextResponse.json(
            { ok: false, error: (err as Error).message },
            { status: 500 }
        )
    }
}
