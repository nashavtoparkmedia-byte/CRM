import { withCronLogging } from '@/lib/cron-health'
import { evaluateOperationalSlaEscalationV1 } from '@/modules/work-management/public/v1/operational-trigger-evaluations'

/**
 * Escalate tasks that have breached their SLA deadline.
 * Call via CRON: GET /api/cron/sla-escalation
 *
 * Creates a one-time `sla_escalated` event per task.
 * Safe to call repeatedly — already-escalated tasks are skipped.
 */
export const GET = withCronLogging('sla-escalation', async () => {
    const result = await evaluateOperationalSlaEscalationV1()
    return { ok: true, ...result }
})
