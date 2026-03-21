
import { PrismaClient } from '@prisma/client';
import 'dotenv/config';

const prisma = new PrismaClient();

async function main() {
    console.log('--- Searching for Alexander-related chats and messages ---');
    
    // 1. Find all chats with "Александр"
    const chats = await prisma.chat.findMany({
        where: {
            OR: [
                { name: { contains: 'Александр' } },
                { externalChatId: { contains: 'Александр' } }
            ]
        },
        include: {
            driver: true,
            _count: {
                select: { messages: true }
            }
        }
    });

    console.log(`Found ${chats.length} chats:`);
    for (const chat of chats) {
        console.log(`ID: ${chat.id}, Name: ${chat.name}, ExtID: ${chat.externalChatId}, DriverID: ${chat.driverId}, MsgCount: ${chat._count.messages}`);
        if (chat.driver) {
            console.log(`  -> Driver: ${chat.driver.fullName} (${chat.driver.phone})`);
        }
        
        // Find the last 5 messages for each chat
        const lastMessages = await prisma.message.findMany({
            where: { chatId: chat.id },
            orderBy: { sentAt: 'desc' },
            take: 5
        });
        
        for (const msg of lastMessages) {
            console.log(`    [${msg.sentAt.toISOString()}] ${msg.direction}: ${msg.content.substring(0, 50)}`);
        }
    }
}

main().catch(console.error).finally(() => prisma.$disconnect());
