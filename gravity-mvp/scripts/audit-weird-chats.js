/**
 * Diagnose the "empty chat" + "body is JID" pathology from the UI screenshots.
 */
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
    // 1. Look at the specific JIDs from the screenshots.
    const jids = ['156204152127588@lid', '79827333894@c.us']
    for (const jid of jids) {
        console.log(`\n========== ${jid} ==========`)

        const waChat = await prisma.whatsAppChat.findUnique({ where: { id: jid } })
        console.log(`WhatsAppChat:`, waChat ? { name: waChat.name, lastMessageAt: waChat.lastMessageAt } : 'NOT FOUND')

        const unifiedChat = await prisma.chat.findFirst({
            where: { channel: 'whatsapp', OR: [{ externalChatId: jid }, { externalChatId: { contains: jid } }] },
        })
        console.log(`Unified Chat:`, unifiedChat ? { id: unifiedChat.id, name: unifiedChat.name, externalChatId: unifiedChat.externalChatId, lastMessageAt: unifiedChat.lastMessageAt } : 'NOT FOUND')

        const waMsgs = await prisma.whatsAppMessage.findMany({ where: { chatId: jid }, take: 10, orderBy: { timestamp: 'desc' } })
        console.log(`WhatsAppMessage count: ${waMsgs.length}`)
        for (const m of waMsgs) console.log(`   [${m.timestamp?.toISOString()}] fromMe=${m.fromMe} type=${m.type} body="${(m.body || '').substring(0, 80)}"`)

        if (unifiedChat) {
            const unifiedMsgs = await prisma.message.findMany({ where: { chatId: unifiedChat.id }, take: 10, orderBy: { createdAt: 'desc' } })
            console.log(`Unified Message count: ${unifiedMsgs.length}`)
            for (const m of unifiedMsgs) console.log(`   [${m.createdAt?.toISOString()}] dir=${m.direction} content="${(m.content || '').substring(0, 80)}"`)
        }
    }

    // 2. Survey — how many chats have zero messages in the unified table?
    const allWAChats = await prisma.chat.findMany({
        where: { channel: 'whatsapp' },
        select: { id: true, name: true, externalChatId: true, lastMessageAt: true, _count: { select: { messages: true } } },
    })
    const emptyChats = allWAChats.filter(c => c._count.messages === 0)
    console.log(`\n\n========== EMPTY CHATS (Chat rows with 0 Messages) ==========`)
    console.log(`Total WA chats: ${allWAChats.length}, empty: ${emptyChats.length}`)
    for (const c of emptyChats.slice(0, 20)) {
        console.log(`   ext=${c.externalChatId} name="${c.name}" last=${c.lastMessageAt?.toISOString()}`)
    }

    // 3. Survey — how many messages have body that looks like a JID?
    const junkMsgs = await prisma.whatsAppMessage.findMany({
        where: { OR: [{ body: { contains: '@c.us' } }, { body: { contains: '@lid' } }, { body: { contains: '@g.us' } }] },
        take: 20,
        orderBy: { timestamp: 'desc' },
    })
    console.log(`\n========== MESSAGES WITH JID-LIKE BODY (WhatsAppMessage) ==========`)
    console.log(`Count (max 20 shown): ${junkMsgs.length}`)
    for (const m of junkMsgs) {
        console.log(`   chatId=${m.chatId} fromMe=${m.fromMe} type=${m.type} body="${m.body}"`)
    }

    // Same for unified
    const junkUnified = await prisma.message.findMany({
        where: { channel: 'whatsapp', OR: [{ content: { contains: '@c.us' } }, { content: { contains: '@lid' } }, { content: { contains: '@g.us' } }] },
        take: 20,
        orderBy: { createdAt: 'desc' },
    })
    console.log(`\n========== MESSAGES WITH JID-LIKE CONTENT (unified Message) ==========`)
    console.log(`Count (max 20 shown): ${junkUnified.length}`)
    for (const m of junkUnified) {
        console.log(`   chatId=${m.chatId} dir=${m.direction} content="${m.content}"`)
    }
}

main()
    .catch(err => { console.error(err); process.exitCode = 1 })
    .finally(() => prisma.$disconnect())
