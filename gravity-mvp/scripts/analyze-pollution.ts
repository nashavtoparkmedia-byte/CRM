
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    console.log('--- Analyzing lastOrderAt vs DriverDaySummary ---');
    
    const drivers = await prisma.driver.findMany({
        select: { id: true, fullName: true, lastOrderAt: true }
    });
    
    let pollutedCount = 0;
    const today = new Date();
    const fortyFiveDaysAgo = new Date();
    fortyFiveDaysAgo.setDate(today.getDate() - 45);
    
    for (const d of drivers) {
        if (!d.lastOrderAt) continue;
        
        // If lastOrderAt is within the last 45 days
        if (d.lastOrderAt >= fortyFiveDaysAgo) {
            // Check if they have ANY trips in DriverDaySummary in the last 45 days
            const trips = await prisma.driverDaySummary.aggregate({
                where: {
                    driverId: d.id,
                    date: { gte: fortyFiveDaysAgo },
                    tripCount: { gt: 0 }
                },
                _sum: { tripCount: true }
            });
            
            if ((trips._sum.tripCount || 0) === 0) {
                // Potential pollution: lastOrderAt is recent, but no trips in 45 days in our summaries
                // We should check IF we actually have summaries for this period
                pollutedCount++;
                if (pollutedCount <= 5) {
                    console.log(`Potential Pollution: ${d.fullName}, lastOrderAt: ${d.lastOrderAt.toISOString()}, No trips in last 45 days summary.`);
                }
            }
        }
    }
    
    console.log(`Total potentially polluted drivers: ${pollutedCount} / ${drivers.length}`);
}

main()
    .catch(e => console.error(e))
    .finally(() => prisma.$disconnect());
