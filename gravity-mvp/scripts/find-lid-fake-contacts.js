const { loadEnvConfig } = require('@next/env')
loadEnvConfig(process.cwd())
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
    // Find all messages with @lid externalId, then check if their chat's
    // externalChatId is a fake "whatsapp:7XXXXXXXXXX" fabricated from
    // the LID's tail-10 digits.
    const msgs = await prisma.message.findMany({
        where: {
            channel: 'whatsapp',
            externalId: { contains: '@lid_' },
        },
        select: { chatId: true, externalId: true },
    })
    console.log(`Messages with @lid externalId: ${msgs.length}`)

    const chatIds = [...new Set(msgs.map(m => m.chatId))]
    console.log(`Unique chats with @lid messages: ${chatIds.length}\n`)

    let fakeCount = 0
    const fakeChats = []
    for (const chatId of chatIds) {
        const chat = await prisma.chat.findUnique({
            where: { id: chatId },
            include: {
                _count: { select: { messages: true } },
                contact: {
                    include: {
                        phones: { select: { phone: true, isActive: true, isPrimary: true } },
                        identities: { select: { channel: true, externalId: true } },
                        _count: { select: { chats: true } },
                    },
                },
            },
        })
        if (!chat) continue
        if (chat.externalChatId?.includes('@lid')) continue
        const sample = msgs.find(m => m.chatId === chatId)
        const lidMatch = sample?.externalId?.match(/_(\d+)@lid_/)
        const lid = lidMatch?.[1]
        if (!lid || lid.length < 10) continue
        const fakePhone = '7' + lid.slice(-10)
        if (chat.externalChatId !== `whatsapp:${fakePhone}`) continue
        fakeCount++
        fakeChats.push({ chat, lid, fakePhone })
        console.log(`Fake-LID chat #${fakeCount}: ${chat.id}`)
        console.log(`  externalChatId: ${chat.externalChatId}`)
        console.log(`  LID: ${lid}`)
        console.log(`  contact: ${chat.contactId} (${chat.contact?.displayName})`)
        console.log(`  contact.phones: ${chat.contact?.phones?.map(p => p.phone).join(', ')}`)
        console.log(`  contact.identities: ${chat.contact?.identities?.map(i => `${i.channel}:${i.externalId}`).join(', ')}`)
        console.log(`  contact.chats count: ${chat.contact?._count?.chats}`)
        console.log(`  messages: ${chat._count.messages}`)
        console.log()
    }

    console.log(`Total fake-LID chats: ${fakeCount}`)
    await prisma.$disconnect()
}
main().catch(e => { console.error(e); process.exit(1) })
