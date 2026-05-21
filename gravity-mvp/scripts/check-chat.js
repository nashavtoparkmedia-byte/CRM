const { loadEnvConfig } = require('@next/env')
loadEnvConfig(process.cwd())
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
    const chatId = process.argv[2] ?? 'cmp7a5b080001vp1sz33nrbjx'
    const chat = await prisma.chat.findUnique({ where: { id: chatId } })
    console.log('CHAT:', JSON.stringify(chat, null, 2))

    const totalMsgs = await prisma.message.count({ where: { chatId } })
    console.log(`Total messages in chat: ${totalMsgs}`)

    const msgs = await prisma.message.findMany({
        where: { chatId },
        select: { id: true, type: true, channel: true, direction: true, content: true, sentAt: true, metadata: true },
        orderBy: { sentAt: 'desc' },
        take: 5,
    })
    console.log('Most recent 5:')
    msgs.forEach(m => console.log(`  ${m.sentAt.toISOString()} type=${m.type} channel=${m.channel} dir=${m.direction} content="${m.content}"`))

    // Also check all phone-channel chats
    console.log('\n--- All phone chats ---')
    const phoneChats = await prisma.chat.findMany({
        where: { channel: 'phone' },
        select: { id: true, externalChatId: true, contactId: true, name: true, lastMessageAt: true, _count: { select: { messages: true } } },
    })
    phoneChats.forEach(c => console.log(`  ${c.id} ext=${c.externalChatId} contact=${c.contactId} msgs=${c._count.messages} name=${c.name}`))

    await prisma.$disconnect()
}
main().catch(e => { console.error(e); process.exit(1) })
