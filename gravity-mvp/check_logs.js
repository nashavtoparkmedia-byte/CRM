
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkLogs() {
    try {
        const count = await prisma.apiLog.count();
        console.log(`ApiLog Count: ${count}`);

        const lastLog = await prisma.apiLog.findFirst({
            orderBy: { createdAt: 'desc' }
        });
        if (lastLog) {
            console.log(`Last Status: ${lastLog.statusCode} at ${lastLog.createdAt.toISOString()}`);
            console.log(`URL: ${lastLog.requestUrl}`);
        } else {
            console.log('No logs found.');
        }

    } catch (e) {
        console.error('Error:', e.message);
    } finally {
        await prisma.$disconnect();
    }
}

checkLogs();
