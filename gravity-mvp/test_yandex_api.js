
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function testYandex() {
    try {
        const connection = await prisma.apiConnection.findFirst({
            orderBy: { createdAt: 'desc' },
        });

        if (!connection) {
            console.log('Error: No API connection in DB');
            return;
        }

        console.log(`Testing Yandex API connection for parkId: ${connection.parkId}`);

        const startDate = new Date();
        startDate.setDate(startDate.getDate() - 1);
        startDate.setHours(0, 0, 0, 0);

        const endDate = new Date();
        endDate.setHours(23, 59, 59, 999);

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
            limit: 10,
        };

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
            console.error(`Yandex API Error [${res.status}]:`, errText);
        } else {
            const data = await res.json();
            console.log(`Success! Fetched ${data.orders?.length || 0} orders.`);
            if (data.orders?.length > 0) {
                console.log('First order status:', data.orders[0].status);
            }
        }

    } catch (e) {
        console.error('Script Error:', e.message);
    } finally {
        await prisma.$disconnect();
    }
}

testYandex();
