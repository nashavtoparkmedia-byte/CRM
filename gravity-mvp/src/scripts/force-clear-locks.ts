import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    console.log('Force clearing all CRM driver lock statuses...');
    const result = await prisma.driver.updateMany({
        data: { lastFleetCheckStatus: null }
    });
    console.log(`Successfully cleared ${result.count} locks!`);
}

main()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
