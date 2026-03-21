const { StringSession } = require('telegram/sessions');
const { TelegramClient } = require('telegram');
const { PrismaClient } = require('@prisma/client');
require('dotenv').config();

async function main() {
    const p = new PrismaClient();
    const c = await p.telegramConnection.findFirst({where:{isActive:true}});
    if (!c) return console.log('no conn');
    const client = new TelegramClient(new StringSession(c.sessionString), parseInt(c.apiId), c.apiHash, {connectionRetries: 1});
    await client.connect();
    console.log('connected');
    
    const dialogs = await client.getDialogs({ limit: 5 });
    for (const d of dialogs) {
        console.log(`Dialog: ${d.name}, unread: ${d.unreadCount}, id: ${d.id}`);
        if (d.unreadCount > 0) {
            const msgs = await client.getMessages(d.id, { limit: Math.min(d.unreadCount, 10) });
            console.log(`Fetched ${msgs.length} unread msgs for ${d.name}`);
        }
    }
    await client.disconnect();
    p.$disconnect();
}
main().catch(console.error);
