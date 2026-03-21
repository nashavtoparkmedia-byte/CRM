const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');

// Load .env
const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
    const env = fs.readFileSync(envPath, 'utf8');
    env.split('\n').forEach(line => {
        const [key, value] = line.split('=');
        if (key && value) process.env[key.trim()] = value.trim();
    });
}

const prisma = new PrismaClient();

async function checkMessages() {
    const queries = ['380', '400'];
    console.log(`Checking messages for: ${queries.join(', ')}`);

    for (const q of queries) {
        const msgs = await prisma.message.findMany({
            where: { content: { contains: q } },
            include: { chat: true }
        });

        console.log(`\n--- Results for "${q}" ---`);
        if (msgs.length === 0) {
            console.log('No messages found in Message table.');
        } else {
            msgs.forEach(m => {
                console.log(`ID: ${m.id} | Chat: ${m.chat.name} (${m.chat.externalChatId}) | Channel: ${m.chat.channel} | Status: ${m.status} | SentAt: ${m.sentAt}`);
            });
        }
    }
}

checkMessages().catch(console.error).finally(() => prisma.$disconnect());
