import { NextResponse } from 'next/server'
import { runYandexSync } from '@/lib/yandexSync'
import { logCronHealth } from '@/lib/cron-health'

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
    const start = Date.now()
    try {
        const result = await runYandexSync({ bypassCooldown: true })
        const durationMs = Date.now() - start

        if (!result.ok) {
            logCronHealth({
                cronName: 'sync-trips',
                status: 'error',
                durationMs,
                errorMessage: result.errorMessage || result.reason || 'unknown',
            }).catch(() => {})
            return NextResponse.json(
                { ok: false, reason: result.reason, error: result.errorMessage },
                { status: result.reason === 'error' ? 500 : 409 }
            )
        }

        logCronHealth({
            cronName: 'sync-trips',
            status: 'ok',
            durationMs,
            metadata: {
                driversUpdated: result.driversUpdated,
                ordersProcessed: result.ordersProcessed,
                recalculatedCount: result.recalculatedCount,
            },
        }).catch(() => {})

        return NextResponse.json(result)
    } catch (error: any) {
        const durationMs = Date.now() - start
        console.error('[sync-trips] Unexpected error:', error?.message)
        logCronHealth({
            cronName: 'sync-trips',
            status: 'error',
            durationMs,
            errorMessage: error?.message,
        }).catch(() => {})
        return NextResponse.json({ error: error?.message }, { status: 500 })
    }
}
