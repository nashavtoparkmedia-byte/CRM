
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
    try {
        const connection = await prisma.apiConnection.findFirst({
            orderBy: { createdAt: 'desc' },
        });
        console.log('API Connection:', connection ? {
            parkId: connection.parkId,
            clid: connection.clid,
            hasApiKey: !!connection.apiKey
        } : 'None');

        const driversCount = await prisma.driver.count();
        console.log('Drivers count:', driversCount);

        const summariesCount = await prisma.driverDaySummary.count();
        console.log('Day summaries count:', summariesCount);

        const latestSummary = await prisma.driverDaySummary.findFirst({
            orderBy: { date: 'desc' }
        });
        console.log('Latest summary date:', latestSummary ? latestSummary.date : 'None');

    } catch (e) {
        console.error('Error:', e);
    } finally {
        await prisma.$disconnect();
    }
}

check();
