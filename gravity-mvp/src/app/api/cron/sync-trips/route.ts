import { NextResponse } from 'next/server'
import { YandexFleetService } from '@/lib/YandexFleetService'
import { logCronHealth } from '@/lib/cron-health'

/**
 * Nightly sync of trip data from Yandex Fleet API.
 * Call via CRON: GET /api/cron/sync-trips
 *
 * Fetches yesterday's orders, counts trips per driver,
 * upserts into DriverDaySummary, and recalculates segments.
 */
export async function GET(req: Request) {
    const start = Date.now()
    try {
        const { searchParams } = new URL(req.url)
        const days = parseInt(searchParams.get('days') || '1')

        const result = await YandexFleetService.syncTrips(days)

        const durationMs = Date.now() - start
        logCronHealth({
            cronName: 'sync-trips',
            status: 'ok',
            durationMs,
            metadata: { days, ...result },
        }).catch(() => {})

        return NextResponse.json(result)
    } catch (error: any) {
        const durationMs = Date.now() - start
        console.error('[sync-trips] Error:', error.message)
        logCronHealth({
            cronName: 'sync-trips',
            status: 'error',
            durationMs,
            errorMessage: error.message,
        }).catch(() => {})
        return NextResponse.json({ error: error.message }, { status: 500 })
    }
}
