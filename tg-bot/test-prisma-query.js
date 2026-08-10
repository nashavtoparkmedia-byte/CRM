const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { sanitizeLogValue } = require('./src/security/redactSecrets');
require('dotenv').config();

async function testQuery() {
    try {
        const botToken = process.env.BOT_TOKEN;
        const tokenStatus = botToken ? 'CONFIGURED' : 'MISSING';
        console.log('Testing configured bot mapping:', tokenStatus);

        const bot = await prisma.bot.findUnique({
            where: { token: botToken },
            include: {
                surveys: {
                    include: {
                        questions: { orderBy: { order: 'asc' } }
                    }
                }
            }
        });

        console.log('Bot result:', bot ? 'Found' : 'Not Found');
        if (bot) {
            console.log('Surveys:', bot.surveys ? bot.surveys.length : 'No surveys found');
            if (bot.surveys && bot.surveys.length > 0) {
                console.log('Questions in first survey:', bot.surveys[0].questions.length);
            }
        }
    } catch (err) {
        console.error('QUERY FAILED:', sanitizeLogValue(err));
    } finally {
        await prisma.$disconnect();
    }
}

testQuery();
