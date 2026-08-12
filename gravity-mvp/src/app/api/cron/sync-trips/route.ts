import { runScheduledYandexSyncCronV1 } from '@/modules/operations-observability/public/v1'

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
export async function GET() {
    return runScheduledYandexSyncCronV1()
}
