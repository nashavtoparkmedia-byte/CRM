const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
prisma.driverDaySummary.findMany({
    where: { tripCount: { gt: 0 } },
    orderBy: { date: 'desc' },
    take: 5
}).then(res => console.log('Recent trips:', res))
.catch(e => console.error(e))
.finally(() => prisma.$disconnect());
