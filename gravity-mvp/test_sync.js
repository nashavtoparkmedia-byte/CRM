require('dotenv').config({ path: './.env' });
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function testSync() {
    try {
        const connection = await prisma.apiConnection.findFirst({
            orderBy: { createdAt: 'desc' },
        });

        if (!connection) {
            throw new Error('No API connection configured');
        }

        const days = 7;
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);
        startDate.setHours(0, 0, 0, 0);

        const endDate = new Date();
        endDate.setHours(23, 59, 59, 999);

        console.log(`Syncing trips for last ${days} day(s)...`);

        const allOrders = [];
        let cursor;
        let iter = 0;

        while (true) {
            iter++;
            console.log(`Iter ${iter}, cursor=${cursor}`);
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
                const errText = await res.text();
                throw new Error(`Yandex API: ${res.status} - ${errText}`);
            }

            const data = await res.json();
            const orders = data.orders || [];
            allOrders.push(...orders);
            console.log(`Fetched ${orders.length} in iter ${iter}`);

            if (!data.cursor || orders.length === 0) break;
            // PREVENT INFINITE LOOP if cursor doesn't change
            if (cursor === data.cursor) {
                console.log('Cursor unchanged, breaking');
                break;
            }
            cursor = data.cursor;
            
            if (iter > 10) {
                console.log('Too many iterations, breaking');
                break;
            }
        }

        console.log(`Fetched ${allOrders.length} orders total`);

    } catch (e) {
        console.error('Error:', e);
    } finally {
        await prisma.$disconnect();
    }
}

testSync();
