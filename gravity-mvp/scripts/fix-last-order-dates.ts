
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    console.log('--- Starting Data Fix: lastOrderAt Backfill ---');

    // Get all drivers
    const drivers = await prisma.driver.findMany({
        select: { id: true, fullName: true, lastOrderAt: true }
    });

    console.log(`Found ${drivers.length} drivers. Checking trip history...`);

    let updatedCount = 0;

    // Optimized strategy: Get the latest trip date for all drivers who have ANY trips
    console.log('Fetching latest trip dates for all active drivers...');
    const latestTrips = await prisma.driverDaySummary.groupBy({
        by: ['driverId'],
        where: {
            tripCount: { gt: 0 }
        },
        _max: {
            date: true
        }
    });

    console.log(`Found trip history for ${latestTrips.length} drivers. Updating Driver records...`);

    let count = 0;
    for (const entry of latestTrips) {
        count++;
        const tripDate = entry._max.date;
        if (!tripDate) continue;

        const result = await prisma.driver.updateMany({
            where: {
                id: entry.driverId,
                OR: [
                    { lastOrderAt: null },
                    { lastOrderAt: { not: tripDate } }
                ]
            },
            data: {
                lastOrderAt: tripDate
            }
        });

        if (result.count > 0) {
            updatedCount++;
        }

        // Progress logging (O(1) counter)
        if (count % 100 === 0 || count === latestTrips.length) {
            console.log(`Progress: ${count}/${latestTrips.length} drivers processed...`);
        }
    }

    console.log(`--- Data Fix Completed for Active History ---`);
    console.log(`Drivers Updated with Actual Trip Dates: ${updatedCount}`);

    // --- Step 2: Clear lastOrderAt for drivers with NO trip history ---
    console.log('Step 2: Clearing lastOrderAt for drivers with NO trip history...');
    
    // Get all driver IDs who HAVE trips
    const activeDriverIds = latestTrips.map(t => t.driverId);

    const clearResult = await prisma.driver.updateMany({
        where: {
            id: { notIn: activeDriverIds },
            lastOrderAt: { not: null }
        },
        data: {
            lastOrderAt: null
        }
    });

    console.log(`Drivers with NO trip history cleared: ${clearResult.count}`);
    console.log(`--- Fix Completed ---`);
    console.log(`Total Drivers: ${drivers.length}`);
}

main()
    .catch(e => console.error(e))
    .finally(() => prisma.$disconnect());
