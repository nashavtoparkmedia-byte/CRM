import { withCronLogging } from '@/lib/cron-health'
import { evaluateSLAEscalation } from '@/lib/triggers'

/**
 * Escalate tasks that have breached their SLA deadline.
 * Call via CRON: GET /api/cron/sla-escalation
 *
 * Creates a one-time `sla_escalated` event per task.
 * Safe to call repeatedly — already-escalated tasks are skipped.
 */
export const GET = withCronLogging('sla-escalation', async () => {
    const result = await evaluateSLAEscalation()
    return { ok: true, ...result }
})
