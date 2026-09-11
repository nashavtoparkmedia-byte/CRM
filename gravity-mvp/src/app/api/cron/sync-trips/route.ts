import { NextResponse } from 'next/server'
import { runScheduledYandexSyncCronV1 } from '@/modules/operations-observability/public/v1'

export const dynamic = 'force-dynamic'

/**
 * Nightly Yandex Fleet sync (drivers + trips + segment recalculation).
 * Call via CRON: GET /api/cron/sync-trips
 *
 * Performs:
 *   1. Sync active drivers (creates new, updates existing)
 *   2. Sync dismissed drivers (marks dismissedAt)
 *   3. Pull trips for the analysis period (DriverDaySummary)
 *   4. Recalculate segments
 *
 * Updates SyncStatus row so the /drivers UI shows "last sync at HH:MM".
 */
export async function GET(request: Request) {
    // Ensure this is called by an authorized cron jobs runner (e.g. Vercel Cron, GitHub Actions).
    // Fail closed: an unset CRON_SECRET denies every caller rather than disabling the check.
    const cronSecret = process.env.CRON_SECRET
    const authHeader = request.headers.get('authorization')
    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    return runScheduledYandexSyncCronV1()
}
