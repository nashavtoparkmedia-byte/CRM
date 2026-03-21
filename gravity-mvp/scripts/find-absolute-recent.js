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
    console.log('--- RECENT MESSAGES (Top 10) ---');
    const messages = await prisma.message.findMany({
        take: 10,
        orderBy: { createdAt: 'desc' },
        include: { chat: true }
    });

    if (messages.length === 0) {
        console.log('No messages found.');
    }

    messages.forEach(m => {
        console.log(`[${m.createdAt.toISOString()}] ID: ${m.id} | Content: "${m.content}" | Channel: ${m.chat.channel} | Direction: ${m.direction} | ChatName: ${m.chat.name}`);
    });
}

main().catch(console.error).finally(() => prisma.$disconnect());
