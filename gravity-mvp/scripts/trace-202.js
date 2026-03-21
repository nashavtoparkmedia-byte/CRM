const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');

// Manually load .env
const envPath = path.join(__dirname, '../.env');
if (fs.existsSync(envPath)) {
    const env = fs.readFileSync(envPath, 'utf8');
    env.split('\n').forEach(line => {
        const [key, value] = line.split('=');
        if (key && value) process.env[key.trim()] = value.trim();
    });
}

const prisma = new PrismaClient();

async function main() {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    console.log(`Searching for "202" sent since ${tenMinutesAgo.toISOString()}...`);

    const messages = await prisma.message.findMany({
        where: {
            content: { contains: '202' },
            createdAt: { gte: tenMinutesAgo }
        },
        include: { chat: true }
    });

    if (messages.length === 0) {
        console.log('No such messages found in the Message table.');
    } else {
        messages.forEach(m => {
            console.log(`[Message Table] ID: ${m.id} | Chat: ${m.chat.name} (${m.chat.externalChatId}) | Status: ${m.status}`);
        });
    }

    const botMessages = await prisma.botChatMessage.findMany({
        where: {
            text: { contains: '202' },
            createdAt: { gte: tenMinutesAgo }
        }
    });

    if (botMessages.length === 0) {
        console.log('No such messages found in the BotChatMessage table.');
    } else {
        botMessages.forEach(m => {
            console.log(`[BotChatMessage Table] ID: ${m.id} | TelegramId: ${m.telegramId} | Direction: ${m.direction}`);
        });
    }
}

main().catch(console.error).finally(() => prisma.$disconnect());
