import { withCronLogging } from '@/lib/cron-health'
import { evaluateEscalations } from '@/lib/triggers'

export const dynamic = 'force-dynamic'

/**
 * GET /api/cron/escalations
 *
 * Idempotent endpoint: escalates high-risk tasks whose mandatory
 * follow-up deadline has passed. Safe to call multiple times.
 */
export const GET = withCronLogging('escalations', async () => {
    const result = await evaluateEscalations()
    return { ok: true, escalated: result.escalated }
})
