import { withCronLogging } from '@/lib/cron-health'
import { enforceMandatoryFollowup } from '@/lib/triggers'

export const dynamic = 'force-dynamic'

/**
 * GET /api/cron/enforce-followup
 *
 * Idempotent endpoint: enforces mandatory follow-up on high-risk tasks
 * that have no nextActionId set. Safe to call multiple times.
 */
export const GET = withCronLogging('enforce-followup', async () => {
    const result = await enforceMandatoryFollowup()
    return { ok: true, enforced: result.enforced }
})
