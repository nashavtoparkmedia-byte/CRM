const { PrismaClient } = require('@prisma/client');
const config = require('./src/config');
const { sanitizeLogValue } = require('./src/security/redactSecrets');
const prisma = new PrismaClient();

async function main() {
    const dbBots = await prisma.bot.findMany({ select: { id: true } });
    console.log('--- DB BOTS ---');
    dbBots.forEach(b => console.log(`ID: ${b.id}`));

    console.log('\n--- CONFIG BOT TOKEN ---');
    const token = config.botToken;
    const tokenStatus = token ? 'CONFIGURED' : 'MISSING';
    console.log(`Config token: ${tokenStatus}`);

    const bot = await prisma.bot.findUnique({
        where: { token: token },
        include: { surveys: { where: { isActive: true } } }
    });

    console.log('\n--- MATCH ---');
    console.log(`Bot found: ${bot ? 'YES' : 'NO'}`);
    if (bot && bot.surveys) {
        console.log(`Surveys: ${bot.surveys.map(s => s.triggerButton).join(', ')}`);
    }
}
main()
    .then(() => process.exit(0))
    .catch(error => {
        console.error('Bot mapping check failed:', sanitizeLogValue(error));
        process.exit(1);
    });
