const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    try {
        const rows = await prisma.scoringThreshold.findMany();
        console.log('Thresholds:', JSON.stringify(rows));
        
        const count = await prisma.driver.count();
        console.log('Total Drivers:', count);
    } catch (e) {
        console.error(e);
    } finally {
        await prisma.$disconnect();
    }
}

main();
