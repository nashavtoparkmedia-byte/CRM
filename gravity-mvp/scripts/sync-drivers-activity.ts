
import { PrismaClient } from '@prisma/client';
import fetch from 'node-fetch';
import * as fs from 'fs';

const prisma = new PrismaClient();

async function main() {
    console.log('--- Starting Deep Sync Script (v1 Driver Profiles) ---');
    
    // 1. Get Connection
    const connection = await prisma.apiConnection.findFirst({
        orderBy: { createdAt: 'desc' },
    });

    if (!connection) {
        console.error('No API connection found in DB.');
        return;
    }

    console.log(`Using ParkID: ${connection.parkId}`);

    // 2. Sync Loop
    let offset = 0;
    let totalFetched = 0;
    let upsertedCount = 0;
    let activeFoundLimit = 45; // days
    let activeFound = 0;
    const PAGE_SIZE = 500;

    const fortyFiveDaysAgo = new Date();
    fortyFiveDaysAgo.setDate(fortyFiveDaysAgo.getDate() - activeFoundLimit);

    try {
        while (true) {
            console.log(`Fetching profiles (offset: ${offset})...`);
            
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
                    limit: PAGE_SIZE,
                    offset: offset,
                }),
            });

            if (!res.ok) {
                const err = await res.text();
                console.error(`API Error: ${res.status} ${err}`);
                break;
            }

            const data: any = await res.json();
            const profiles = data.driver_profiles || [];
            const totalInApi = data.total || 0;
            
            if (totalFetched === 0 && profiles.length > 0) {
                console.log('Profile Sample structure:', JSON.stringify(profiles[0], null, 2));
            }

            for (const p of profiles) {
                const dp = p.driver_profile || {};
                const id = dp.id;
                if (!id) continue;

                // Prioritize actual trip fields: last_ride_at or last_order_at from Yandex
                // We EXCLUDE last_transaction_date because it includes non-trip balance changes
                const lastOrderAtStr = dp.last_order_at || p.last_order_at || p.last_ride_at;
                const lastOrderAt = lastOrderAtStr ? new Date(lastOrderAtStr) : null;
                
                if (lastOrderAt && lastOrderAt >= fortyFiveDaysAgo) {
                    activeFound++;
                }

                const firstName = dp.first_name || '';
                const lastName = dp.last_name || '';
                const fullName = `${lastName} ${firstName}`.trim() || 'No Name';

                await prisma.driver.upsert({
                    where: { yandexDriverId: id },
                    create: {
                        yandexDriverId: id,
                        fullName,
                        lastOrderAt,
                        segment: 'unknown',
                    },
                    update: {
                        fullName,
                        lastOrderAt,
                    }
                });
                upsertedCount++;
            }

            totalFetched += profiles.length;
            offset += PAGE_SIZE;

            console.log(`Progress: Fetched ${totalFetched}/${totalInApi}, Upserted ${upsertedCount}, Active in 45d: ${activeFound}`);

            if (totalFetched >= totalInApi || profiles.length === 0) break;
        }

        console.log('--- Sync Completed ---');
        console.log(`Total Profiles: ${totalFetched}`);
        console.log(`Total Upserted: ${upsertedCount}`);
        console.log(`Active Drivers (last 45d): ${activeFound}`);

    } catch (error) {
        console.error('Fatal Script Error:', error);
    } finally {
        await prisma.$disconnect();
    }
}

main();
