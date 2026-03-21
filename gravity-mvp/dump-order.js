const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const prisma = new PrismaClient();

async function main() {
    try {
        const connection = await prisma.apiConnection.findFirst({
            orderBy: { createdAt: 'desc' },
        });

        const res = await fetch('https://fleet-api.taxi.yandex.net/v1/parks/orders/list', {
            method: 'POST',
            headers: {
                'X-Client-ID': connection.clid,
                'X-Api-Key': connection.apiKey,
                'Accept-Language': 'ru',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                query: { park: { id: connection.parkId } },
                limit: 1
            }),
        });
        
        const data = await res.json();
        fs.writeFileSync('c:\\Users\\mixx\\Documents\\Github\\CRM\\gravity-mvp\\dump.json', JSON.stringify(data, null, 2));

    } catch (e) {
        console.error(e);
    } finally {
        await prisma.$disconnect();
    }
}

main();
