
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
    console.log('Searching for "2151" in Message table...');
    const msgs = await prisma.message.findMany({
        where: {
            content: { contains: '2151' }
        },
        include: {
            chat: {
                include: {
                    driver: true
                }
            }
        }
    });

    console.log(`Found ${msgs.length} messages:`);
    msgs.forEach(m => {
        console.log(`Msg ID: ${m.id}, Chat ID: ${m.chatId}, Channel: ${m.chat?.channel}, Driver ID: ${m.chat?.driverId || 'NULL'}, Driver Name: ${m.chat?.driver?.fullName || 'N/A'}, Content: ${m.content}`);
    });

    // Also check for "Ремезов Александр" chats
    console.log('\nChecking "Ремезов Александр" chats:');
    const remChat = await prisma.chat.findMany({
        where: {
            name: { contains: 'Ремезов' }
        },
        include: {
            driver: true
        }
    });
    remChat.forEach(c => {
        console.log(`Chat ID: ${c.id}, Name: ${c.name}, Channel: ${c.channel}, Driver ID: ${c.driverId || 'NULL'}, Driver Name: ${c.driver?.fullName || 'N/A'}`);
    });

    // Check for ANY chats with "Александр" and channel "max"
    console.log('\nChecking all "max" chats:');
    const maxChat = await prisma.chat.findMany({
        where: {
            channel: 'max'
        },
        include: {
            driver: true,
            messages: {
                orderBy: { createdAt: 'desc' },
                take: 1
            }
        }
    });
    maxChat.forEach(c => {
        console.log(`Chat ID: ${c.id}, Name: ${c.name}, Driver ID: ${c.driverId || 'NULL'}, LastMsg: ${c.messages[0]?.content}`);
    });
}

main().catch(console.error).finally(() => prisma.$disconnect());
