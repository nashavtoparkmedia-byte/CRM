
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

// Safety bound on one connection's cursor walk, not an expected limit. At 500
// orders per page this covers 200k orders, roughly twice what the busiest park
// produces over the 45-day analysis window. Hitting it means the window was
// truncated, which is reported rather than passed off as a complete sync.
const MAX_PAGES_PER_CONNECTION = 400

/** One park connection that failed; the remaining connections still sync. */
export type YandexTripSyncFailureV1 = {
    parkId: string
    name: string | null
    message: string
}

export type YandexTripSyncResultV1 = {
    success: boolean
    driversUpdated: number
    ordersProcessed: number
    connectionsTotal: number
    connectionsSucceeded: number
    failures: YandexTripSyncFailureV1[]
    /** Parks whose window was cut short by the page bound; their history is incomplete. */
    truncated: YandexTripSyncFailureV1[]
}

type ParkConnection = { clid: string; apiKey: string; parkId: string; name?: string | null }

export class YandexFleetService {
    /**
     * Fetch completed-and-cancelled orders for one park connection over the window.
     * Pagination, 429 backoff and the polite delay are unchanged from the
     * single-connection implementation.
     */
    private static async fetchParkOrders(
        connection: ParkConnection,
        startDate: Date,
        endDate: Date,
    ): Promise<{ orders: any[]; truncated: boolean }> {
        const allOrders: any[] = []
        let cursor: string | undefined
        let iter = 0
        let truncated = false

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
            }, `YandexFleetService.syncTrips[${connection.parkId}]`)

            if (!res.ok) {
                const errText = await res.text()
                console.error(`[YandexFleetService] Yandex API error for park ${connection.parkId}: ${res.status}`, errText)
                throw new Error(`Yandex API: ${res.status} - ${errText}`)
            }

            const data = await res.json()
            const orders = data.orders || []
            allOrders.push(...orders)

            if (!data.cursor || orders.length === 0) break
            if (cursor === data.cursor) {
                console.log(`[YandexFleetService] Cursor unchanged in iter ${iter} for park ${connection.parkId}, breaking.`)
                break
            }
            if (iter >= MAX_PAGES_PER_CONNECTION) {
                console.warn(`[YandexFleetService] Park ${connection.parkId} hit the ${MAX_PAGES_PER_CONNECTION}-page safety bound after ${allOrders.length} order(s); the requested window was NOT fully covered.`)
                truncated = true
                break
            }
            cursor = data.cursor

            // Polite pause between paginated calls to avoid hammering Yandex
            await new Promise(r => setTimeout(r, POLITE_DELAY_MS))
        }

        return { orders: allOrders, truncated }
    }

    /**
     * Syncs trip data from Yandex Fleet API for a specified number of days.
     * Every configured park connection is processed; a connection that fails
     * does not stop the remaining parks. Upserts data into DriverDaySummary.
     */
    static async syncTrips(days: number = 7): Promise<YandexTripSyncResultV1> {
        // Each connection supplies the credentials and park identifier used
        // for that park's API calls below.
        const connections = await prisma.apiConnection.findMany({
            orderBy: { createdAt: 'asc' },
            select: { clid: true, apiKey: true, parkId: true, name: true },
        })

        if (connections.length === 0) {
            throw new Error('No API connection configured')
        }

        // Calculate date range
        const startDate = new Date()
        startDate.setDate(startDate.getDate() - days)
        startDate.setHours(0, 0, 0, 0)

        const endDate = new Date()
        endDate.setHours(23, 59, 59, 999)

        console.log(`[YandexFleetService] Syncing trips for last ${days} day(s) from ${startDate.toISOString().split('T')[0]} across ${connections.length} park connection(s)...`)

        // Timezone-aware formatter (UTC+5 for park local time)
        const tzFormatter = new Intl.DateTimeFormat('sv-SE', {
            timeZone: 'Asia/Yekaterinburg',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        })

        // Driver profile identities are park-scoped: resolve an order's
        // driver_profile.id inside the park it came from. yandexDriverId stays
        // as a fallback for rows imported before park identity was recorded.
        const drivers = await prisma.driver.findMany({
            select: { id: true, yandexDriverId: true, externalParkId: true, externalDriverProfileId: true },
        })

        const byParkProfile = new Map<string, string>()
        const byYandexId = new Map<string, string>()
        for (const driver of drivers) {
            if (driver.externalParkId && driver.externalDriverProfileId) {
                byParkProfile.set(`${driver.externalParkId}\u0000${driver.externalDriverProfileId}`, driver.id)
            }
            if (driver.yandexDriverId && !byYandexId.has(driver.yandexDriverId)) {
                byYandexId.set(driver.yandexDriverId, driver.id)
            }
        }

        let driversUpdated = 0
        let ordersProcessed = 0
        let connectionsSucceeded = 0
        const failures: YandexTripSyncFailureV1[] = []
        const truncatedParks: YandexTripSyncFailureV1[] = []

        for (const connection of connections) {
            let parkOrders: any[]
            try {
                const fetched = await this.fetchParkOrders(connection, startDate, endDate)
                parkOrders = fetched.orders
                if (fetched.truncated) {
                    truncatedParks.push({
                        parkId: connection.parkId,
                        name: connection.name ?? null,
                        message: `window truncated at the ${MAX_PAGES_PER_CONNECTION}-page bound after ${fetched.orders.length} orders`,
                    })
                }
            } catch (err: any) {
                const message = err?.message || String(err)
                console.error(`[YandexFleetService] Park ${connection.parkId} failed, continuing with remaining parks:`, message)
                failures.push({ parkId: connection.parkId, name: connection.name ?? null, message })
                continue
            }

            ordersProcessed += parkOrders.length

            // Count completed trips per resolved driver per park-local day
            const tripCounts = new Map<string, Map<string, number>>()
            for (const order of parkOrders) {
                if (order.status !== 'complete') continue

                const profileId = order.driver_profile?.id
                if (!profileId) continue

                const driverId = byParkProfile.get(`${connection.parkId}\u0000${profileId}`)
                    ?? byYandexId.get(profileId)
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

            const upsertPromises: any[] = []
            for (const [driverId, driverDates] of tripCounts.entries()) {
                for (const [dateStr, trips] of driverDates.entries()) {
                    const dateObj = new Date(`${dateStr}T00:00:00.000Z`)

                    upsertPromises.push(
                        prisma.driverDaySummary.upsert({
                            where: {
                                driverId_date: { driverId, date: dateObj },
                            },
                            update: { tripCount: trips },
                            create: {
                                driverId,
                                date: dateObj,
                                tripCount: trips,
                            },
                        })
                    )
                }
                driversUpdated++
            }

            // Execute upsert promises in chunks of 50 to avoid connection pooling issues
            for (let i = 0; i < upsertPromises.length; i += 50) {
                await Promise.all(upsertPromises.slice(i, i + 50))
            }

            connectionsSucceeded++
            console.log(`[YandexFleetService] Park ${connection.parkId}: ${parkOrders.length} order(s), ${tripCounts.size} driver(s) updated.`)

            // Polite pause between park connections to avoid hammering Yandex
            await new Promise(r => setTimeout(r, POLITE_DELAY_MS))
        }

        if (connectionsSucceeded === 0) {
            throw new Error(`Yandex trip sync failed for all ${connections.length} park connection(s): ${failures.map(f => `${f.parkId}: ${f.message}`).join('; ')}`)
        }

        console.log(`[YandexFleetService] Sync complete. ${connectionsSucceeded}/${connections.length} park(s), updated ${driversUpdated} driver-park record(s).`)
        return {
            success: true,
            driversUpdated,
            ordersProcessed,
            connectionsTotal: connections.length,
            connectionsSucceeded,
            failures,
            truncated: truncatedParks,
        }
    }
}
