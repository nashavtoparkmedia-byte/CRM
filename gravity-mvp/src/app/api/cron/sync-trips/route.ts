import { NextResponse } from 'next/server'
import { YandexFleetService } from '@/lib/YandexFleetService'

/**
 * Nightly sync of trip data from Yandex Fleet API.
 * Call via CRON: GET /api/cron/sync-trips
 *
 * Fetches yesterday's orders, counts trips per driver,
 * upserts into DriverDaySummary, and recalculates segments.
 */
export async function GET(req: Request) {
    try {
        const { searchParams } = new URL(req.url)
        const days = parseInt(searchParams.get('days') || '1')
        
        const result = await YandexFleetService.syncTrips(days)

        return NextResponse.json(result)
    } catch (error: any) {
        console.error('[sync-trips] Error:', error.message)
        return NextResponse.json({ error: error.message }, { status: 500 })
    }
}

