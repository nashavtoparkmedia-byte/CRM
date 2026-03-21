import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    console.log('Clearing CRM locks...');
    try {
        await prisma.$executeRawUnsafe(`UPDATE "Driver" SET "lastFleetCheckStatus" = NULL;`);
        console.log('CRM Locks healed!');
    } catch (e) {
        console.log('Could not clear CRM locks, might be running from scraper dir. Ignoring.');
    }

    console.log('Healing scraper account...');
    try {
        await prisma.account.updateMany({
            data: { healthScore: 100, failureStreak: 0, state: 'ACTIVE' }
        });
        await prisma.check.deleteMany({});
        console.log('Account healed and queue cleared!');
    } catch (e) {
        console.log('Error healing account:', e);
    }
}

main().catch(console.error).finally(() => prisma.$disconnect());
