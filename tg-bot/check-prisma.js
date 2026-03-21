const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
require('dotenv').config();

async function checkDb() {
    const token = process.env.BOT_TOKEN;
    console.log('Current BOT_TOKEN from .env:', token ? token.substring(0, 5) + '...' : 'MISSING');

    const bots = await prisma.bot.findMany();
    console.log('Total bots in DB:', bots.length);

    const targetBot = await prisma.bot.findUnique({
        where: { token: token },
        include: { survey: { include: { questions: true } } }
    });

    if (targetBot) {
        console.log('MATCH FOUND!');
        console.log('Bot Domain:', targetBot.domain);
        console.log('Survey ID:', targetBot.survey ? targetBot.survey.id : 'NONE');
        console.log('Questions count:', targetBot.survey?.questions?.length || 0);
    } else {
        console.log('NO MATCH for current token.');
        if (bots.length > 0) {
            console.log('Registered tokens in DB:');
            bots.forEach(b => console.log(`- ${b.token.substring(0, 5)}... (${b.domain})`));
        }
    }
    process.exit(0);
}

checkDb();
