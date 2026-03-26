const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function run() {
    const analysisDate = new Date();
    analysisDate.setDate(analysisDate.getDate() - 30);
    analysisDate.setHours(0, 0, 0, 0);

    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const drivers = await prisma.driver.findMany({
        where: {
            dismissedAt: null,
            OR: [
                { daySummaries: { some: { date: { gte: analysisDate }, tripCount: { gt: 0 } } } },
                { hiredAt: { gte: analysisDate } }
            ]
        },
        select: {
            id: true, lastOrderAt: true, hiredAt: true,
            daySummaries: {
                where: { date: { gte: analysisDate } },
                select: { tripCount: true, date: true }
            }
        }
    });

    console.log(`Matched drivers: ${drivers.length}`);

    let counts = { profitable: 0, medium: 0, small: 0, dropped: 0, inactive: 0 };
    for(const d of drivers) {
        const periodTrips = d.daySummaries.reduce((s, x) => s + x.tripCount, 0);
        let lastTripDate = d.daySummaries.filter(x => x.tripCount > 0).sort((a,b)=>b.date-a.date)[0]?.date;
        let lastActive = lastTripDate || d.lastOrderAt || d.hiredAt;
        let daysWithout = 999;
        if(lastActive) {
            daysWithout = Math.floor((todayEnd.getTime() - lastActive.getTime()) / (1000*60*60*24));
        }

        let segment = 'small';
        if (periodTrips === 0) segment = 'inactive';
        else if(daysWithout >= 7) segment = 'dropped';
        else if(periodTrips >= 100) segment = 'profitable';
        else if(periodTrips >= 50) segment = 'medium';
        else if(periodTrips >= 10) segment = 'small';
        
        counts[segment]++;
    }
    console.log('Result counts:', counts);
}

run().catch(console.error).finally(()=>prisma.$disconnect());
