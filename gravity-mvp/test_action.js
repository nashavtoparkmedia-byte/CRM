require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function run() {
    try {
        console.log("Testing triggerRecalculation directly...");
        const { triggerRecalculation } = require('./src/app/drivers/segmentation-actions.ts');
        const res = await triggerRecalculation();
        console.log("Result:", res);
        
        const counts = await Promise.all([
            prisma.driver.count({ where: { segment: 'profitable' } }),
            prisma.driver.count({ where: { segment: 'medium' } }),
            prisma.driver.count({ where: { segment: 'small' } }),
            prisma.driver.count({ where: { segment: 'dropped' } })
        ]);
            
        console.log(`Final Segments - Profitable: ${counts[0]}, Medium: ${counts[1]}, Small: ${counts[2]}, Dropped: ${counts[3]}`);
        
    } catch(e) {
        console.error(e);
    } finally {
        await prisma.$disconnect();
    }
}

run();
