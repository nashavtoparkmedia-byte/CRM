
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const fs = require('fs');

async function main() {
    let output = '--- MAX CHATS DEBUG ---\n';
    const chats = await prisma.chat.findMany({
        where: { channel: 'max' },
        include: { 
            driver: true,
            messages: {
                orderBy: { sentAt: 'desc' },
                take: 1
            }
        }
    });

    output += `Found ${chats.length} MAX chats:\n`;
    for (const c of chats) {
        output += `Chat ID: ${c.id}\n`;
        output += `  Name:   ${c.name}\n`;
        output += `  ExtID:  ${c.externalChatId}\n`;
        output += `  Driver: ${c.driver ? c.driver.fullName + ' (' + c.driverId + ')' : 'NULL'}\n`;
        output += `  Last:   ${c.messages[0]?.content || 'no msgs'}\n`;
        output += '------------------------\n';
    }

    const remChat = await prisma.chat.findMany({
        where: { name: { contains: 'Ремезов' } },
        include: { driver: true }
    });
    output += `\nFound ${remChat.length} chats for 'Ремезов':\n`;
    for (const c of remChat) {
        output += `Chat ID: ${c.id}, Channel: ${c.channel}, Driver: ${c.driver?.fullName || 'NULL'}\n`;
    }

    fs.writeFileSync('debug-max-chats.log', output);
    console.log('Done, see debug-max-chats.log');
}

main().catch(e => {
    fs.writeFileSync('debug-max-chats.err', e.stack);
    process.exit(1);
}).finally(() => prisma.$disconnect());
