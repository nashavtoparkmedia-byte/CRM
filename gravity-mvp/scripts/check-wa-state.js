/**
 * Quick snapshot of WA data in the DB.
 */
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
    const [chatCount, msgCount, waChat, waMsg, byDirection, byChat, jidJunk, emptyChats] = await Promise.all([
        prisma.chat.count({ where: { channel: 'whatsapp' } }),
        prisma.message.count({ where: { channel: 'whatsapp' } }),
        prisma.whatsAppChat.count(),
        prisma.whatsAppMessage.count(),
        prisma.message.groupBy({
            by: ['direction'],
            where: { channel: 'whatsapp' },
            _count: true,
        }),
        prisma.message.groupBy({
            by: ['chatId'],
            where: { channel: 'whatsapp' },
            _count: true,
            orderBy: { _count: { chatId: 'desc' } },
            take: 20,
        }),
        prisma.message.findMany({
            where: {
                channel: 'whatsapp',
                OR: [
                    { content: { contains: '@c.us' } },
                    { content: { contains: '@lid' } },
                    { content: { contains: '@g.us' } },
                ],
            },
            select: { id: true, chatId: true, content: true },
            take: 10,
        }),
        prisma.chat.findMany({
            where: { channel: 'whatsapp' },
            select: { id: true, externalChatId: true, name: true, _count: { select: { messages: true } } },
        }),
    ])

    console.log('=== WA state ===')
    console.log(`  Chat (unified):    ${chatCount}`)
    console.log(`  Message (unified): ${msgCount}`)
    console.log(`  WhatsAppChat:      ${waChat}`)
    console.log(`  WhatsAppMessage:   ${waMsg}`)
    console.log(`  By direction:`, byDirection)

    console.log('\n=== Chats with message counts ===')
    for (const c of emptyChats) {
        console.log(`  [${c._count.messages}] ${c.externalChatId}  name="${c.name}"`)
    }

    console.log(`\n=== Top chats by message count ===`)
    const chatIds = byChat.map(x => x.chatId)
    const chatDetails = await prisma.chat.findMany({ where: { id: { in: chatIds } }, select: { id: true, externalChatId: true, name: true } })
    const chatMap = new Map(chatDetails.map(c => [c.id, c]))
    for (const row of byChat) {
        const c = chatMap.get(row.chatId)
        console.log(`  [${row._count}] ${c?.externalChatId}  name="${c?.name}"`)
    }

    console.log(`\n=== JID-like content messages (should be 0) ===`)
    console.log(`Count: ${jidJunk.length}`)
    for (const m of jidJunk) console.log(`  chatId=${m.chatId} content="${m.content}"`)

    // Check Message created around "now" vs older. Window configurable
    // via first CLI arg or WA_AUDIT_DAYS env (defaults to 7).
    const days = Number(process.argv[2] || process.env.WA_AUDIT_DAYS || 7)
    const now = new Date()
    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
    const messagesRecent = await prisma.message.count({
        where: { channel: 'whatsapp', sentAt: { gte: cutoff } },
    })
    const messagesOlder = await prisma.message.count({
        where: { channel: 'whatsapp', sentAt: { lt: cutoff } },
    })
    console.log(`\n=== Date distribution (channel=whatsapp, window=${days}d) ===`)
    console.log(`  sentAt >= ${days}d ago (${cutoff.toISOString()}): ${messagesRecent}`)
    console.log(`  sentAt <  ${days}d ago (older):                  ${messagesOlder}`)

    // Check date range
    const dateRange = await prisma.message.aggregate({
        where: { channel: 'whatsapp' },
        _min: { sentAt: true },
        _max: { sentAt: true },
    })
    console.log(`  oldest sentAt: ${dateRange._min.sentAt?.toISOString()}`)
    console.log(`  newest sentAt: ${dateRange._max.sentAt?.toISOString()}`)
}

main().catch(console.error).finally(() => prisma.$disconnect())
