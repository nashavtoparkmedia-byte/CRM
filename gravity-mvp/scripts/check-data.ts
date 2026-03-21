
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    console.log('--- Data Check ---');
    
    const totalDrivers = await prisma.driver.count();
    console.log(`Total Drivers: ${totalDrivers}`);
    
    const withLastOrder = await prisma.driver.count({
        where: { lastOrderAt: { not: null } }
    });
    console.log(`Drivers with lastOrderAt: ${withLastOrder}`);
    
    const inactive45d = await prisma.driver.count({
        where: { 
            OR: [
                { lastOrderAt: null },
                { lastOrderAt: { lt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000) } }
            ]
        }
    });
    console.log(`Inactive (45d+): ${inactive45d}`);
    
    // Check for "polluted" lastOrderAt if possible
    // We can compare with DriverDaySummary
    const drivers = await prisma.driver.findMany({
        take: 10,
        where: { lastOrderAt: { not: null } },
        select: { id: true, fullName: true, lastOrderAt: true }
    });
    
    for (const d of drivers) {
        const latestSummary = await prisma.driverDaySummary.findFirst({
            where: { driverId: d.id, tripCount: { gt: 0 } },
            orderBy: { date: 'desc' },
            select: { date: true }
        });
        console.log(`Driver: ${d.fullName}, lastOrderAt: ${d.lastOrderAt?.toISOString()}, latestSummary: ${latestSummary?.date.toISOString() || 'None'}`);
    }
}

main()
    .catch(e => console.error(e))
    .finally(() => prisma.$disconnect());
