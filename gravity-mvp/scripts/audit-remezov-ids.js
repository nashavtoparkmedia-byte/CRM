const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function audit() {
    const driver = await prisma.driver.findFirst({
        where: { fullName: { contains: 'Ремезов' } },
        include: {
            telegrams: true,
            chats: {
                where: { channel: 'telegram' }
            }
        }
    });

    console.log('--- Driver Audit: Ремезов ---');
    if (!driver) {
        console.log('Driver not found');
        return;
    }
    console.log('Driver ID:', driver.id);
    console.log('Telegrams linked:', JSON.stringify(driver.telegrams, (k,v) => typeof v === 'bigint' ? v.toString() : v, 2));
    console.log('TG Chats existing:', driver.chats.map(c => ({ id: c.id, externalChatId: c.externalChatId, name: c.name })));

    const chatsWithYoko = await (prisma.chat as any).findMany({
        where: { 
            OR: [
                { externalChatId: { contains: 'Yoko' } },
                { name: { contains: 'Yoko' } }
            ]
        }
    });
    console.log('Overall Chats with "Yoko":', chatsWithYoko.map(c => ({ id: c.id, externalChatId: c.externalChatId, channel: c.channel })));
}

audit().catch(console.error).finally(() => prisma.$disconnect());
