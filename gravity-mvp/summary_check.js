const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
prisma.driverDaySummary.count().then(c => console.log('Summaries: ' + c))
.then(() => prisma.driverDaySummary.count({where:{tripCount:{gt:0}}}))
.then(c => console.log('Summaries > 0: ' + c))
.catch(e => console.error(e))
.finally(() => prisma.$disconnect());
