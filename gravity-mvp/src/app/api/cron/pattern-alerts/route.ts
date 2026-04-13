import { NextResponse } from 'next/server'
import { detectRootCausePatterns, calculateRootCauseTrends } from '@/lib/triggers'

export const dynamic = 'force-dynamic'

/**
 * GET /api/cron/pattern-alerts
 *
 * Idempotent endpoint: detects repeating root cause patterns and
 * early warnings, creates pattern_alert/early_warning events.
 * Safe to call multiple times.
 */
export async function GET() {
    try {
        const result = await detectRootCausePatterns()
        const trends = await calculateRootCauseTrends()

        return NextResponse.json({
            ok: true,
            alerts: result.alerts,
            warnings: result.warnings,
            patterns: result.patterns,
            trends: trends.length,
            trendDetails: trends,
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
