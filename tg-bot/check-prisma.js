const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { sanitizeLogValue } = require('./src/security/redactSecrets');
require('dotenv').config();

async function checkDb() {
    const token = process.env.BOT_TOKEN;
    const tokenStatus = token ? 'CONFIGURED' : 'MISSING';
    console.log('Current BOT_TOKEN from .env:', tokenStatus);

    const bots = await prisma.bot.findMany({
        select: { id: true, domain: true },
    });
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
            console.log('Registered bot mappings:');
            bots.forEach(b => console.log(`- ${b.id} (${b.domain})`));
        }
    }
    process.exit(0);
}

checkDb().catch(error => {
    console.error('Database check failed:', sanitizeLogValue(error));
    process.exit(1);
});
