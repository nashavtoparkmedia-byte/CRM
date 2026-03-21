const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkDb() {
    try {
        const bots = await prisma.bot.count();
        const users = await prisma.user.count();
        const events = await prisma.analyticsEvent.count();
        const surveys = await prisma.survey.count();

        console.log('Database Stats:');
        console.log(`Bots: ${bots}`);
        console.log(`Users: ${users}`);
        console.log(`Events: ${events}`);
        console.log(`Surveys: ${surveys}`);

        if (bots > 0) {
            const firstBot = await prisma.bot.findFirst();
            console.log(`\nFirst Bot ID: ${firstBot.id}`);
            console.log(`First Bot Name: ${firstBot.name}`);
        }
    } catch (err) {
        console.error(err);
    } finally {
        await prisma.$disconnect();
    }
}

checkDb();
