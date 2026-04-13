import { withCronLogging } from '@/lib/cron-health'
import { detectRootCausePatterns, calculateRootCauseTrends } from '@/lib/triggers'

export const dynamic = 'force-dynamic'

/**
 * GET /api/cron/pattern-alerts
 *
 * Idempotent endpoint: detects repeating root cause patterns and
 * early warnings, creates pattern_alert/early_warning events.
 * Safe to call multiple times.
 */
export const GET = withCronLogging('pattern-alerts', async () => {
    const result = await detectRootCausePatterns()
    const trends = await calculateRootCauseTrends()
    return {
        ok: true,
        alerts: result.alerts,
        warnings: result.warnings,
        patterns: result.patterns,
        trends: trends.length,
        trendDetails: trends,
    }
})
