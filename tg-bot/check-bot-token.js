const { PrismaClient } = require('@prisma/client');
const config = require('./src/config');
const prisma = new PrismaClient();

async function main() {
    const dbBots = await prisma.bot.findMany();
    console.log('--- DB BOTS ---');
    dbBots.forEach(b => console.log(`ID: ${b.id} | Token: ${b.token.substring(0, 15)}...`));

    console.log('\n--- CONFIG BOT TOKEN ---');
    const token = config.botToken;
    console.log(`Config token: ${token ? token.substring(0, 15) : 'NULL'}...`);

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
main().then(() => process.exit(0));
