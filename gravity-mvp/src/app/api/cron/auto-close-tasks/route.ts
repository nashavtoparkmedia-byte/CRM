import { withCronLogging } from '@/lib/cron-health'
import { evaluateAutoClose } from '@/lib/triggers'

/**
 * Auto-close churn/onboarding tasks when driver trip activity is detected.
 * Call via CRON: GET /api/cron/auto-close-tasks
 *
 * Checks Driver.lastOrderAt vs Task.createdAt.
 * If the driver had a trip after the task was created → task is auto-closed.
 *
 * closedReason:
 *   churn      → 'returned'   (водитель вернулся)
 *   onboarding → 'launched'   (водитель вышел на линию)
 */
export const GET = withCronLogging('auto-close-tasks', async () => {
    const result = await evaluateAutoClose()
    return { ok: true, ...result }
})
