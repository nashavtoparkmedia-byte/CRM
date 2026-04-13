import { withCronLogging } from '@/lib/cron-health'
import { runStabilityCheck } from '@/lib/stability-check'

export const dynamic = 'force-dynamic'

/**
 * GET /api/cron/stability-check
 *
 * Automated daily stability check. Safe to call multiple times.
 * Produces and persists a structured stability report.
 *
 * Query params:
 *   ?scope=daily|weekly|monthly (default: daily)
 */
export const GET = withCronLogging('stability-check', async () => {
    // Scope can be overridden but defaults to daily
    const report = await runStabilityCheck('daily')
    return {
        ok: true,
        status: report.status,
        anomalies: report.anomalies.length,
        scope: report.scope,
    }
})
