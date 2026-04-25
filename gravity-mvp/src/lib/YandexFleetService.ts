
import { prisma } from '@/lib/prisma'
import { recalculateDriverScoring } from '@/lib/scoring'

/**
 * Fetch wrapper with retry on Yandex Fleet rate limits (HTTP 429).
 * Uses exponential backoff: 2s, 4s, 8s, 16s, 32s.
 * Also fires a small delay between successful calls to stay polite.
 */
async function yandexFetch(url: string, init: RequestInit, label: string): Promise<Response> {
    const MAX_ATTEMPTS = 5
    let attempt = 0
    while (true) {
        attempt++
        const res = await fetch(url, init)
        if (res.status !== 429) return res
        if (attempt >= MAX_ATTEMPTS) return res

        // Honor Retry-After header if present, else exponential backoff
        const retryAfter = res.headers.get('retry-after')
        const backoffMs = retryAfter
            ? Math.min(60_000, parseInt(retryAfter, 10) * 1000 || 2000)
            : Math.min(32_000, 2_000 * Math.pow(2, attempt - 1))
        console.warn(`[${label}] 429 rate limit, retry ${attempt}/${MAX_ATTEMPTS} in ${backoffMs}ms`)
        await new Promise(r => setTimeout(r, backoffMs))
    }
}

const POLITE_DELAY_MS = 400  // small pause between Yandex calls

export class YandexFleetService {
    /**
     * Syncs trip data from Yandex Fleet API for a specified number of days.
     * Upserts data into DriverDaySummary and recalculates scoring for updated drivers.
     */
    static async syncTrips(days: number = 7): Promise<{ success: boolean; driversUpdated: number; ordersProcessed: number }> {
        const connection = await prisma.apiConnection.findFirst({
            orderBy: { createdAt: 'desc' },
        })

        if (!connection) {
            throw new Error('No API connection configured')
        }

        // Calculate date range
        const startDate = new Date()
        startDate.setDate(startDate.getDate() - days)
        startDate.setHours(0, 0, 0, 0)

        const endDate = new Date()
        endDate.setHours(23, 59, 59, 999)

        console.log(`[YandexFleetService] Syncing trips for last ${days} day(s) from ${startDate.toISOString().split('T')[0]}...`)

        const allOrders: any[] = []
        let cursor: string | undefined
        let iter = 0

        while (true) {
            iter++
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

            const res = await yandexFetch('https://fleet-api.taxi.yandex.net/v1/parks/orders/list', {
                method: 'POST',
                headers: {
                    'X-Client-ID': connection.clid,
                    'X-Api-Key': connection.apiKey,
                    'Accept-Language': 'ru',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(payload),
            }, 'YandexFleetService.syncTrips')

            if (!res.ok) {
                const errText = await res.text()
                console.error(`[YandexFleetService] Yandex API error: ${res.status}`, errText)
                throw new Error(`Yandex API: ${res.status} - ${errText}`)
            }

            const data = await res.json()
            const orders = data.orders || []
            allOrders.push(...orders)

            if (!data.cursor || orders.length === 0) break
            if (cursor === data.cursor) {
                console.log(`[YandexFleetService] Cursor unchanged in iter ${iter}, breaking.`)
                break
            }
            if (iter >= 50) {
                console.log(`[YandexFleetService] Reached max 50 fetch iterations, breaking early to prevent timeout.`)
                break
            }
            cursor = data.cursor

            // Polite pause between paginated calls to avoid hammering Yandex
            await new Promise(r => setTimeout(r, POLITE_DELAY_MS))
        }

        // Timezone-aware formatter (UTC+5 for park local time)
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
            
            let dateStr = tzFormatter.format(startDate) // fallback
            if (order.booked_at) {
                try {
                    dateStr = tzFormatter.format(new Date(order.booked_at))
                } catch (e) {}
            }

            if (!tripCounts.has(driverId)) {
                tripCounts.set(driverId, new Map())
            }
            const driverDates = tripCounts.get(driverId)!
            driverDates.set(dateStr, (driverDates.get(dateStr) || 0) + 1)
        }

        // Get all drivers to map Yandex ID to our Internal ID
        const drivers = await prisma.driver.findMany({
            select: { id: true, yandexDriverId: true },
        })

        let updatedCount = 0
        const upsertPromises: any[] = []

        for (const driver of drivers) {
            const driverDates = tripCounts.get(driver.yandexDriverId)
            if (!driverDates) continue

            for (const [dateStr, trips] of driverDates.entries()) {
                const dateObj = new Date(`${dateStr}T00:00:00.000Z`)

                upsertPromises.push(
                    prisma.driverDaySummary.upsert({
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
                )
            }
            updatedCount++
        }

        // Execute upsert promises in chunks of 50 to avoid connection pooling issues
        for (let i = 0; i < upsertPromises.length; i += 50) {
            await Promise.all(upsertPromises.slice(i, i + 50))
        }

        console.log(`[YandexFleetService] Sync complete. Updated ${updatedCount} drivers.`)
        return { success: true, driversUpdated: updatedCount, ordersProcessed: allOrders.length }
    }
}
