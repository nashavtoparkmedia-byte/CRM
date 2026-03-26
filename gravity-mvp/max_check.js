const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
prisma.driverDaySummary.groupBy({
    by: ['driverId'],
    _sum: { tripCount: true },
    orderBy: { _sum: { tripCount: 'desc' }}
}).then(res => console.log('Top trips:', res.slice(0, 5)))
.catch(e => console.error(e))
.finally(() => prisma.$disconnect());
