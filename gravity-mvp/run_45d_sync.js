require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function backfillTrips(days) {
    try {
        const connection = await prisma.apiConnection.findFirst({
            orderBy: { createdAt: 'desc' },
        });

        if (!connection) throw new Error("No API connection in DB");

        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);
        startDate.setHours(0, 0, 0, 0);
        const endDate = new Date();
        endDate.setHours(23, 59, 59, 999);

        console.log(`[Backfill] Syncing trips for last ${days} day(s) from ${startDate.toISOString()}...`);

        const allOrders = [];
        let cursor;
        let iter = 0;

        while (true) {
            iter++;
            const payload = {
                query: {
                    park: { 
                        id: connection.parkId,
                        order: { booked_at: { from: startDate.toISOString(), to: endDate.toISOString() } }
                    }
                },
                limit: 500,
            };

            if (cursor) payload.cursor = cursor;

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
                console.error(`Yandex API error: ${res.status}`, await res.text());
                break;
            }

            const data = await res.json();
            const orders = data.orders || [];
            allOrders.push(...orders);

            if (iter % 10 === 0) {
                console.log(`[Backfill] Fetched ${allOrders.length} orders so far (iter ${iter})...`);
            }

            if (!data.cursor || orders.length === 0) break;
            if (cursor === data.cursor) break;
            cursor = data.cursor;
        }

        console.log(`[Backfill] Downloading complete. Fetched ${allOrders.length} orders.`);

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
                try { dateStr = tzFormatter.format(new Date(order.booked_at)); } catch (e) {}
            }

            if (!tripCounts.has(driverId)) tripCounts.set(driverId, new Map());
            const driverDates = tripCounts.get(driverId);
            driverDates.set(dateStr, (driverDates.get(dateStr) || 0) + 1);
        }

        const drivers = await prisma.driver.findMany({
            select: { id: true, yandexDriverId: true },
        });

        console.log(`[Backfill] Upserting day summaries for ${tripCounts.size} active drivers...`);
        let updatedCount = 0;
        const upsertPromises = [];

        for (const driver of drivers) {
            const driverDates = tripCounts.get(driver.yandexDriverId);
            if (!driverDates) continue;

            for (const [dateStr, trips] of driverDates.entries()) {
                const dateObj = new Date(`${dateStr}T00:00:00.000Z`);
                upsertPromises.push(
                    prisma.driverDaySummary.upsert({
                        where: { driverId_date: { driverId: driver.id, date: dateObj } },
                        update: { tripCount: trips },
                        create: { driverId: driver.id, date: dateObj, tripCount: trips },
                    })
                );
            }
            updatedCount++;
        }

        console.log(`[Backfill] Writing ${upsertPromises.length} updates to database in chunks...`);
        for (let i = 0; i < upsertPromises.length; i += 100) {
            await Promise.all(upsertPromises.slice(i, i + 100));
        }

        console.log(`[Backfill] Done! Updated ${updatedCount} drivers.`);
        
        // Recalculate
        const { recalculateAllSegments } = require('./src/lib/scoring.ts');
        console.log(`[Backfill] Recalculating all segments...`);
        const res = await recalculateAllSegments();
        console.log(`[Backfill] Recalculated ${res.count} drivers.`);

    } catch (e) {
        console.error("[Backfill] Error:", e);
    } finally {
        await prisma.$disconnect();
    }
}

backfillTrips(45);
