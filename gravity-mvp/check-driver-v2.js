const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const prisma = new PrismaClient();

async function main() {
    let output = '';
    const log = (msg) => {
        console.log(msg);
        output += msg + '\n';
    };

    try {
        log('Searching for "Петухова Анна Павловна"...');
        const drivers = await prisma.driver.findMany({
            where: {
                fullName: { contains: 'Петухова', mode: 'insensitive' }
            }
        });
        
        log(`Found ${drivers.length} drivers matching "Петухова":`);
        drivers.forEach(d => {
            log(`- ID: ${d.id}, Name: ${d.fullName}, YandexId: ${d.yandexDriverId}`);
        });

        if (drivers.length > 0) {
            const driverId = drivers[0].id;
            const summaries = await prisma.driverDaySummary.findMany({
                where: { driverId },
                orderBy: { date: 'desc' },
                take: 50
            });
            log(`Found ${summaries.length} summaries for ${drivers[0].fullName}`);
            summaries.forEach(s => {
                if (s.tripCount > 0) {
                    log(`  Date: ${s.date.toISOString().split('T')[0]}, Trips: ${s.tripCount}`);
                }
            });
        }
        
        // Also check some general stats
        const allSummaries = await prisma.driverDaySummary.aggregate({
            _sum: { tripCount: true },
            _count: { id: true }
        });
        log(`Total Summaries in DB: ${allSummaries._count.id}`);
        log(`Total Trips in DB: ${allSummaries._sum.tripCount}`);

    } catch (e) {
        log('Error: ' + e.message);
    } finally {
        fs.writeFileSync('c:\\Users\\mixx\\Documents\\Github\\CRM\\gravity-mvp\\debug_output_v2.txt', output, 'utf8');
        await prisma.$disconnect();
    }
}

main();
