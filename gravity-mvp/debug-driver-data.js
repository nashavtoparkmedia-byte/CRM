const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    try {
        const driver = await prisma.driver.findFirst({
            where: { fullName: { contains: 'Петухова Анна', mode: 'insensitive' } },
            include: {
                daySummaries: {
                    orderBy: { date: 'desc' },
                    take: 20
                }
            }
        });
        
        if (!driver) {
            console.log('Driver not found');
            return;
        }

        console.log('Driver Found:', {
            id: driver.id,
            fullName: driver.fullName,
            yandexDriverId: driver.yandexDriverId,
            lastOrderAt: driver.lastOrderAt,
        });

        console.log('Recent Summaries:', JSON.stringify(driver.daySummaries, null, 2));

        // Let's also check if there are ANY orders in the system
        const someSummaries = await prisma.driverDaySummary.findMany({
            where: { tripCount: { gt: 0 } },
            take: 5,
            orderBy: { date: 'desc' }
        });
        console.log('Some non-zero summaries in system:', JSON.stringify(someSummaries, null, 2));

    } catch (e) {
        console.error(e);
    } finally {
        await prisma.$disconnect();
    }
}

main();
