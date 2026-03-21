const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
    console.log('🔄 Starting historical trip data backfill...');

    const connection = await prisma.apiConnection.findFirst({
        orderBy: { createdAt: 'desc' },
    });

    if (!connection) {
        console.error('❌ No API connection configured.');
        process.exit(1);
    }

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 30);
    startDate.setHours(0, 0, 0, 0);

    const endDate = new Date();
    endDate.setHours(23, 59, 59, 999);

    console.log(`[backfill] Fetching orders from ${startDate.toISOString()} to ${endDate.toISOString()}...`);

    const allOrders = [];
    let cursor = undefined;
    let retryCount = 0;

    while (true) {
        const payload = {
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
        };

        if (cursor) {
            payload.cursor = cursor;
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
        });

        if (!res.ok) {
            if (res.status === 429 && retryCount < 5) {
                retryCount++;
                console.log(`[backfill] Rate limited (429). Retrying in ${retryCount * 2} seconds...`);
                await sleep(retryCount * 2000);
                continue;
            }
            const errText = await res.text();
            console.error(`[backfill] Yandex API error: ${res.status}`, errText);
            process.exit(1);
        }

        retryCount = 0;

        const data = await res.json();
        const orders = data.orders || [];
        allOrders.push(...orders);

        console.log(`[backfill] Fetched ${orders.length} orders (total: ${allOrders.length})`);

        if (!data.cursor || orders.length === 0) break;
        cursor = data.cursor;
        
        await sleep(500);
    }

    console.log(`[backfill] Total orders fetched: ${allOrders.length}. Grouping by driver and date...`);

    const tzFormatter = new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Asia/Yekaterinburg',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    });

    const tripCounts = new Map();
    for (const order of allOrders) {
        if (order.status !== 'complete') continue;

        const driverId = order.driver_profile?.id;
        if (!driverId) continue;
        
        let dateStr = tzFormatter.format(startDate);
        if (order.booked_at) {
            try {
                dateStr = tzFormatter.format(new Date(order.booked_at));
            } catch (e) {}
        }

        if (!tripCounts.has(driverId)) {
            tripCounts.set(driverId, new Map());
        }
        const driverDates = tripCounts.get(driverId);
        driverDates.set(dateStr, (driverDates.get(dateStr) || 0) + 1);
    }

    console.log(`[backfill] Identified trips for ${tripCounts.size} unique drivers. Updating database...`);

    const drivers = await prisma.driver.findMany({
        select: { id: true, yandexDriverId: true },
    });

    let updated = 0;
    let cleared = 0;
    for (const driver of drivers) {
        const driverDates = tripCounts.get(driver.yandexDriverId);
        
        await prisma.driverDaySummary.updateMany({
            where: {
                driverId: driver.id,
                date: { gte: startDate, lte: endDate }
            },
            data: { tripCount: 0 }
        });
        cleared++;

        if (!driverDates) continue;

        for (const [dateStr, trips] of driverDates.entries()) {
            // Strictly enforce UTC representation of the correctly formatted YMD string
            const dateObj = new Date(`${dateStr}T00:00:00.000Z`);

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
            });
        }
        updated++;
    }

    console.log(`[backfill] Cleared previous records for ${cleared} drivers. Updated ${updated} drivers with accurate data.`);
    console.log('🎉 Backfill complete!');
}

main().catch(console.error).finally(() => prisma.$disconnect());
