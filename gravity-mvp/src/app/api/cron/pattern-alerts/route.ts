import { withCronLogging } from '@/lib/cron-health'
import {
    calculateOperationalRootCauseTrendsV1,
    detectOperationalRootCausePatternsV1,
} from '@/modules/work-management/public/v1/operational-trigger-evaluations'

export const dynamic = 'force-dynamic'

/**
 * GET /api/cron/pattern-alerts
 *
 * Idempotent endpoint: detects repeating root cause patterns and
 * early warnings, creates pattern_alert/early_warning events.
 * Safe to call multiple times.
 */
export const GET = withCronLogging('pattern-alerts', async () => {
    const result = await detectOperationalRootCausePatternsV1()
    const trends = await calculateOperationalRootCauseTrendsV1()
    return {
        ok: true,
        alerts: result.alerts,
        warnings: result.warnings,
        patterns: result.patterns,
        trends: trends.length,
        trendDetails: trends,
    }
})
