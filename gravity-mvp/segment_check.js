const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
prisma.driver.count({where:{segment:'profitable'}}).then(c => console.log('Profitable: ' + c))
.then(() => prisma.driver.count({where:{segment:'medium'}}).then(c => console.log('Medium: ' + c)))
.then(() => prisma.driver.count({where:{segment:'small'}}).then(c => console.log('Small: ' + c)))
.then(() => prisma.driver.count({where:{segment:'dropped'}}).then(c => console.log('Dropped: ' + c)))
.catch(e => console.error(e))
.finally(() => prisma.$disconnect());
