const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    try {
        console.log('Searching for "Петухова Анна Павловна"...');
        const drivers = await prisma.driver.findMany({
            where: {
                fullName: { contains: 'Петухова', mode: 'insensitive' }
            }
        });
        
        console.log(`Found ${drivers.length} drivers matching "Петухова":`);
        drivers.forEach(d => {
            console.log(`- ID: ${d.id}, Name: ${d.fullName}, YandexId: ${d.yandexDriverId}`);
        });

        if (drivers.length > 0) {
            const driverId = drivers[0].id;
            const summaries = await prisma.driverDaySummary.findMany({
                where: { driverId },
                orderBy: { date: 'desc' },
                take: 50
            });
            console.log(`Found ${summaries.length} summaries for ${drivers[0].fullName}`);
            summaries.forEach(s => {
                if (s.tripCount > 0) {
                    console.log(`  Date: ${s.date.toISOString().split('T')[0]}, Trips: ${s.tripCount}`);
                }
            });
        }
    } catch (e) {
        console.error('Error:', e);
    } finally {
        await prisma.$disconnect();
    }
}

main();
