import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

async function main() {
    console.log('🔄 Starting historical trip data backfill...')

    const connection = await prisma.apiConnection.findFirst({
        orderBy: { createdAt: 'desc' },
    })

    if (!connection) {
        console.error('❌ No API connection configured.')
        process.exit(1)
    }

    // Calculate dates for the last 30 days
    const startDate = new Date()
    startDate.setDate(startDate.getDate() - 30)
    startDate.setHours(0, 0, 0, 0)

    const endDate = new Date()
    endDate.setHours(23, 59, 59, 999)

    console.log(`[backfill] Fetching orders from ${startDate.toISOString()} to ${endDate.toISOString()}...`)

    const allOrders: any[] = []
    let cursor: string | undefined

    let retryCount = 0;

    while (true) {
        const payload: any = {
            query: {
                park: { id: connection.parkId },
                booked_at: {
                    from: startDate.toISOString(),
                    to: endDate.toISOString()
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
            if (res.status === 429 && retryCount < 5) {
                retryCount++;
                console.log(`[backfill] Rate limited (429). Retrying in ${retryCount * 2} seconds...`);
                await sleep(retryCount * 2000);
                continue;
            }
            const errText = await res.text()
            console.error(`[backfill] Yandex API error: ${res.status}`, errText)
            process.exit(1)
        }

        retryCount = 0; // reset on success

        const data = await res.json()
        const orders = data.orders || []
        allOrders.push(...orders)

        console.log(`[backfill] Fetched ${orders.length} orders (total: ${allOrders.length})`)

        if (!data.cursor || orders.length === 0) break
        cursor = data.cursor
        
        // Small delay to prevent 429
        await sleep(500);
    }

    console.log(`[backfill] Total orders fetched: ${allOrders.length}. Grouping by driver and date...`)

    // Count trips per driver per day
    const tripCounts = new Map<string, Map<string, number>>()
    for (const order of allOrders) {
        const driverId = order.driver?.id
        if (!driverId) continue
        
        let dateStr = startDate.toISOString().split('T')[0];
        if (order.booked_at) {
            try {
                dateStr = new Date(order.booked_at).toISOString().split('T')[0];
            } catch (e) {}
        }

        if (!tripCounts.has(driverId)) {
            tripCounts.set(driverId, new Map())
        }
        const driverDates = tripCounts.get(driverId)!
        driverDates.set(dateStr, (driverDates.get(dateStr) || 0) + 1)
    }

    console.log(`[backfill] Identified trips for ${tripCounts.size} unique drivers. Updating database...`)

    const drivers = await prisma.driver.findMany({
        select: { id: true, yandexDriverId: true },
    })

    let updated = 0
    let cleared = 0
    for (const driver of drivers) {
        const driverDates = tripCounts.get(driver.yandexDriverId)
        
        // First, we can optionally zero out everything in the last 30 days to avoid stale data
        // But since we didn't specify that, we'll just upsert the ones we found.
        // Wait, if an old day had 5 trips and now has 0, upsert with 0 won't happen because we only iterate found dates.
        // It's safer to clear tripCount for the past 30 days for this driver, then apply the new counts.
        await prisma.driverDaySummary.updateMany({
            where: {
                driverId: driver.id,
                date: { gte: startDate, lte: endDate }
            },
            data: { tripCount: 0 }
        })
        cleared++;

        if (!driverDates) continue

        for (const [dateStr, trips] of driverDates.entries()) {
            const dateObj = new Date(dateStr)
            dateObj.setHours(0, 0, 0, 0)

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

        // We could recalculate segment here, but maybe it's too slow in a huge loop. 
        // We will just do it.
        // In order not to import recalculateDriverScoring, we could just let the dashboard deal with it,
        // or we can import it. Let's just update the DB. We'll skip segment recalculation here for speed, 
        // it can be triggered by normal cron.
        updated++
    }

    console.log(`[backfill] Cleared previous records for ${cleared} drivers. Updated ${updated} drivers with accurate data.`)
    console.log('🎉 Backfill complete!')
}

main()
    .catch(console.error)
    .finally(() => prisma.$disconnect())
