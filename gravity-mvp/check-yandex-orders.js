const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const prisma = new PrismaClient();

async function main() {
    let output = '';
    const log = (msg) => {
        console.log(msg);
        output += msg + '\n';
    };

    try {
        const connection = await prisma.apiConnection.findFirst({
            orderBy: { createdAt: 'desc' },
        });

        if (!connection) {
            log('No API connection found');
            return;
        }

        log(`Using connection: ${connection.parkId}`);

        const res = await fetch('https://fleet-api.taxi.yandex.net/v1/parks/orders/list', {
            method: 'POST',
            headers: {
                'X-Client-ID': connection.clid,
                'X-Api-Key': connection.apiKey,
                'Accept-Language': 'ru',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                query: { 
                    park: { 
                        id: connection.parkId,
                        order: {
                            booked_at: {
                                from: new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString(),
                                to: new Date().toISOString()
                            }
                        }
                    } 
                },
                limit: 20
            }),
        });

        if (!res.ok) {
            log(`API Error: ${res.status} ${await res.text()}`);
            return;
        }

        const data = await res.json();
        const orders = data.orders || [];
        log(`Fetched ${orders.length} latest orders`);

        orders.forEach((o, i) => {
            log(`Order ${i}: ID=${o.id}, DriverName=${o.driver?.name}, DriverID=${o.driver?.id}, Date=${o.booked_at}`);
        });

        if (orders.length > 0) {
            fs.writeFileSync('c:\\Users\\mixx\\Documents\\Github\\CRM\\gravity-mvp\\dump.json', JSON.stringify(orders[0], null, 2), 'utf8');
            log('Wrote first order to dump.json');
        }

    } catch (e) {
        log('Error: ' + e.message);
    } finally {
        fs.writeFileSync('c:\\Users\\mixx\\Documents\\Github\\CRM\\gravity-mvp\\debug_orders.txt', output, 'utf8');
        await prisma.$disconnect();
    }
}

main();
