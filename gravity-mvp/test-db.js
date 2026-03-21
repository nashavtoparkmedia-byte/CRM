const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    try {
        console.log('Testing connection...');
        const driver = await prisma.driver.findFirst();
        console.log('Successfully queried driver model.');
        
        // Try to query the new fields
        const test = await prisma.driver.findMany({
            take: 1,
            select: {
                id: true,
                hiredAt: true
            }
        });
        console.log('New fields are accessible at runtime.');
    } catch (e) {
        console.error('Prisma Error:', e.message);
        if (e.message.includes('Unknown argument')) {
            console.log('CONCLUSION: Runtime client does NOT know about the new fields.');
        } else if (e.message.includes('column "hiredAt" does not exist')) {
            console.log('CONCLUSION: Database schema is missing the columns.');
        }
    } finally {
        await prisma.$disconnect();
    }
}

main();
