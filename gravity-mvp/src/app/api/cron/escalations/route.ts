import { withCronLogging } from '@/lib/cron-health'
import { evaluateOperationalFollowupEscalationsV1 } from '@/modules/work-management/public/v1/operational-trigger-evaluations'

export const dynamic = 'force-dynamic'

/**
 * GET /api/cron/escalations
 *
 * Idempotent endpoint: escalates high-risk tasks whose mandatory
 * follow-up deadline has passed. Safe to call multiple times.
 */
export const GET = withCronLogging('escalations', async () => {
    const result = await evaluateOperationalFollowupEscalationsV1()
    return { ok: true, escalated: result.escalated }
})
