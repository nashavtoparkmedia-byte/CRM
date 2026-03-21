
import { PrismaClient } from '@prisma/client';
import { recalculateDriverScoring } from '../src/lib/scoring';

const prisma = new PrismaClient();

async function main() {
    console.log('--- Recalculating All Drivers (Segment, Score, lastOrderAt) ---');
    
    // 1. Get all drivers
    const drivers = await prisma.driver.findMany({
        select: { id: true, fullName: true }
    });
    
    console.log(`Found ${drivers.length} drivers to process.`);
    
    let count = 0;
    for (const driver of drivers) {
        count++;
        if (count % 100 === 0) {
            console.log(`Processing: ${count}/${drivers.length}...`);
        }
        
        try {
            // recalculateDriverScoring does:
            // 1. countWeeklyTrips (last 7 days)
            // 2. countDaysWithoutTrips (consecutive)
            // 3. calculateSegment
            // 4. calculateDriverScore
            // 5. finds latestTrip in DriverDaySummary
            // 6. updates driver.segment, score, lastOrderAt
            await recalculateDriverScoring(driver.id);
        } catch (err: any) {
            console.error(`Error processing driver ${driver.fullName} (${driver.id}):`, err.message);
        }
    }
    
    console.log('--- Recalculation Completed ---');
}

main()
    .catch(e => console.error(e))
    .finally(() => prisma.$disconnect());
