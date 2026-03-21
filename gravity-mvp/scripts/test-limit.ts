const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function run() {
    const connection = await prisma.apiConnection.findFirst({ orderBy: { createdAt: 'desc' } });
    if (!connection) return console.log('No connection');

    console.log('Fetching v2 contractor profile...');

    const res = await fetch(`https://fleet-api.taxi.yandex.net/v2/parks/contractors/profile?park_id=${connection.parkId}&contractor_profile_id=3a23295d8d714c03b61a17a6fc86601b`, {
        method: 'GET',
        headers: {
            'X-Client-ID': connection.clid,
            'X-Api-Key': connection.apiKey,
            'Accept-Language': 'ru',
            'Content-Type': 'application/json'
        }
    });

    const data = await res.json();
    console.log("V2 GET Response:", JSON.stringify(data, null, 2));

    process.exit(0);
}
run();
