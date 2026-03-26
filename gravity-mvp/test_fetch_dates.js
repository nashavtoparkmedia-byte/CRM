require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function runAnalysis() {
    try {
        console.log("Loading modules...");
        // Replicate logic to test sync for 45 days directly.
        const connection = await prisma.apiConnection.findFirst({
            orderBy: { createdAt: 'desc' },
        });

        if (!connection) throw new Error("No API connection in DB");

        const days = 45;
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);
        startDate.setHours(0, 0, 0, 0);

        const endDate = new Date();
        endDate.setHours(23, 59, 59, 999);

        console.log(`Fetching from Yandex API from ${startDate.toISOString()} to ${endDate.toISOString()}`);
        
        let cursor;
        let iter = 0;
        let totalFetched = 0;
        
        // We'll collect order dates to see what dates are actually being returned!
        const orderDatesMap = new Map(); // YYYY-MM-DD -> count

        const tzFormatter = new Intl.DateTimeFormat('sv-SE', {
            timeZone: 'Asia/Yekaterinburg',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        });

        while (true) {
            iter++;
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

            if(!res.ok) {
                console.error('Yandex Error', res.status, await res.text());
                break;
            }

            const data = await res.json();
            const orders = data.orders || [];
            totalFetched += orders.length;

            for(const order of orders) {
                if (order.status !== 'complete') continue;
                let dateStr = tzFormatter.format(startDate);
                if(order.booked_at) {
                    try { dateStr = tzFormatter.format(new Date(order.booked_at)); } catch(e){}
                }
                orderDatesMap.set(dateStr, (orderDatesMap.get(dateStr) || 0) + 1);
            }

            if (!data.cursor || orders.length === 0) break;
            if (cursor === data.cursor) break;
            cursor = data.cursor;

            if (iter >= 5) { // Just fetch the first 5 batches to see dates
                console.log('Breaking early for dates check...');
                break;
            }
        }
        
        console.log(`Fetched ${totalFetched} orders total in ${iter} iterations`);
        console.log("Dates distribution (sample):");
        for (const [date, count] of Array.from(orderDatesMap.entries()).sort((a,b)=>a[0].localeCompare(b[0]))) {
            console.log(`  ${date}: ${count} complete trips`);
        }

    } catch (e) {
        console.error("Analysis Error:", e);
    } finally {
        await prisma.$disconnect();
    }
}

runAnalysis();
