
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    console.log('--- Verification of lastOrderAt and Segments ---');
    
    // Check for drivers with 0 trips in the last 7 days but marked as something other than 'sleeping'
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    
    const suspiciousDrivers = await prisma.driver.findMany({
        where: {
            segment: { not: 'sleeping' },
            // This is a rough check, real check would need summing DriverDaySummary
        },
        take: 10,
        select: { id: true, fullName: true, segment: true, lastOrderAt: true }
    });
    
    console.log(`Checking ${suspiciousDrivers.length} non-sleeping drivers:`);
    for (const d of suspiciousDrivers) {
        const weeklyTripsCount = await prisma.driverDaySummary.aggregate({
            where: {
                driverId: d.id,
                date: { gte: sevenDaysAgo },
            },
            _sum: { tripCount: true }
        });
        const trips = weeklyTripsCount._sum.tripCount || 0;
        console.log(`Driver: ${d.fullName}, Segment: ${d.segment}, Weekly Trips: ${trips}, lastOrderAt: ${d.lastOrderAt?.toISOString()}`);
    }

    // Check for drivers inactive for > 45 days
    const fortyFiveDaysAgo = new Date();
    fortyFiveDaysAgo.setDate(fortyFiveDaysAgo.getDate() - 45);
    
    const goneDrivers = await prisma.driver.count({
        where: {
            lastOrderAt: { lt: fortyFiveDaysAgo }
        }
    });
    console.log(`Drivers with lastOrderAt > 45 days ago: ${goneDrivers}`);
}

main()
    .catch(e => console.error(e))
    .finally(() => prisma.$disconnect());
