import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { recalculateDriverScoring } from '@/lib/scoring'

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
        
        const connection = await prisma.apiConnection.findFirst({
            orderBy: { createdAt: 'desc' },
        })

        if (!connection) {
            return NextResponse.json({ error: 'No API connection configured' }, { status: 400 })
        }

        // Calculate date range based on 'days' parameter
        const startDate = new Date()
        startDate.setDate(startDate.getDate() - days)
        startDate.setHours(0, 0, 0, 0)

        const endDate = new Date()
        endDate.setHours(23, 59, 59, 999)

        console.log(`[sync-trips] Syncing trips for last ${days} day(s) starting from ${startDate.toISOString().split('T')[0]}...`)

        // Fetch all orders for yesterday from Yandex Fleet API
        const allOrders: any[] = []
        let cursor: string | undefined

        while (true) {
            const payload: any = {
                query: {
                    park: { 
                        id: connection.parkId,
                        order: {
                            booked_at: {
                                from: startDate.toISOString(),
                                to: endDate.toISOString()
                            }
                        }
                    }
                },
                limit: 500,
            }

            if (cursor) {
                payload.cursor = cursor
            }

            const res = await fetch('https://fleet-api.taxi.yandex.net/v1/parks/orders/list', {
                method: 'POST',
                headers: {
                    'X-Client-ID': connection.clid,
                    'X-Api-Key': connection.apiKey,
                    'Accept-Language': 'ru',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(payload),
            })

            if (!res.ok) {
                const errText = await res.text()
                console.error(`[sync-trips] Yandex API error: ${res.status}`, errText)
                return NextResponse.json({ error: `Yandex API: ${res.status}` }, { status: 502 })
            }

            const data = await res.json()
            const orders = data.orders || []
            allOrders.push(...orders)

            console.log(`[sync-trips] Fetched ${orders.length} orders (total: ${allOrders.length})`)

            if (!data.cursor || orders.length === 0) break
            cursor = data.cursor
        }

        // Use a timezone-aware formatter for the park's local time (UTC+5)
        const tzFormatter = new Intl.DateTimeFormat('sv-SE', {
            timeZone: 'Asia/Yekaterinburg',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        })

        // Count trips per driver per day
        const tripCounts = new Map<string, Map<string, number>>()
        for (const order of allOrders) {
            if (order.status !== 'complete') continue

            const driverId = order.driver_profile?.id
            if (!driverId) continue
            
            // Extract local date (YYYY-MM-DD) from booked_at
            let dateStr = tzFormatter.format(startDate) // fallback
            if (order.booked_at) {
                try {
                    dateStr = tzFormatter.format(new Date(order.booked_at))
                } catch (e) {
                    // Ignore parsing error, fallback used
                }
            }

            if (!tripCounts.has(driverId)) {
                tripCounts.set(driverId, new Map())
            }
            const driverDates = tripCounts.get(driverId)!
            driverDates.set(dateStr, (driverDates.get(dateStr) || 0) + 1)
        }

        console.log(`[sync-trips] ${tripCounts.size} drivers had trips in this period`)

        // Get all drivers from our DB
        const drivers = await prisma.driver.findMany({
            select: { id: true, yandexDriverId: true },
        })

        // Upsert day summaries
        let updated = 0
        for (const driver of drivers) {
            const driverDates = tripCounts.get(driver.yandexDriverId)
            if (!driverDates) continue

            for (const [dateStr, trips] of driverDates.entries()) {
                // Strictly enforce UTC representation of the correctly formatted YMD string
                const dateObj = new Date(`${dateStr}T00:00:00.000Z`)

                await prisma.driverDaySummary.upsert({
                    where: {
                        driverId_date: { driverId: driver.id, date: dateObj },
                    },
                    update: { tripCount: trips },
                    create: {
                        driverId: driver.id,
                        date: dateObj,
                        tripCount: trips,
                    },
                })
            }

            // Recalculate segment
            await recalculateDriverScoring(driver.id)
            updated++
        }

        console.log(`[sync-trips] Updated ${updated} drivers. Sync complete.`)

        return NextResponse.json({
            success: true,
            date: startDate.toISOString().split('T')[0],
            driversUpdated: updated,
            ordersProcessed: allOrders.length,
        })
    } catch (error: any) {
        console.error('[sync-trips] Error:', error.message)
        return NextResponse.json({ error: error.message }, { status: 500 })
    }
}
