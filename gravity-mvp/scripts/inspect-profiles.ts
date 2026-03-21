
import { PrismaClient } from '@prisma/client';
import fetch from 'node-fetch';

const prisma = new PrismaClient();

async function main() {
    const connection = await prisma.apiConnection.findFirst({
        orderBy: { createdAt: 'desc' },
    });

    if (!connection) {
        console.error('No API connection found');
        return;
    }

    // Fetch a few drivers to see their profile structure again
    const res = await fetch(`https://fleet-api.taxi.yandex.net/v1/parks/driver-profiles/list`, {
        method: 'POST',
        headers: {
            'X-Client-ID': connection.clid,
            'X-Api-Key': connection.apiKey,
            'X-Park-Id': connection.parkId,
            'Accept-Language': 'ru',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            query: { park: { id: connection.parkId } },
            limit: 10,
        }),
    });

    const data: any = await res.json();
    const profiles = data.driver_profiles || [];

    for (const p of profiles) {
        console.log('--- Driver:', p.driver_profile?.id, p.driver_profile?.last_name);
        console.log('Driver Profile Keys:', Object.keys(p.driver_profile || {}));
        console.log('Accounts[0] last_transaction_date:', p.accounts?.[0]?.last_transaction_date);
        console.log('Full Driver Object Keys:', Object.keys(p));
        // Check for any other trip-related fields
        if (p.last_order_at) console.log('p.last_order_at:', p.last_order_at);
        if (p.driver_profile?.last_order_at) console.log('dp.last_order_at:', p.driver_profile.last_order_at);
        if (p.last_ride_at) console.log('p.last_ride_at:', p.last_ride_at);
    }
}

main();
