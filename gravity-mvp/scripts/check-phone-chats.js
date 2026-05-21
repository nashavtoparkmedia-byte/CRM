const { loadEnvConfig } = require('@next/env')
loadEnvConfig(process.cwd())
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
    const chats = await prisma.chat.findMany({
        where: { channel: 'phone' },
        include: {
            _count: { select: { messages: true } },
            contact: { select: { id: true, displayName: true, isArchived: true } },
        },
        orderBy: { lastMessageAt: 'desc' },
    })
    console.log(`Phone-chats: ${chats.length}\n`)
    chats.forEach(c => {
        console.log(`Chat ${c.id}`)
        console.log(`  externalChatId: ${c.externalChatId}`)
        console.log(`  contactId: ${c.contactId} (${c.contact?.displayName}${c.contact?.isArchived ? ' ARCHIVED' : ''})`)
        console.log(`  driverId: ${c.driverId}`)
        console.log(`  status: ${c.status}`)
        console.log(`  requiresResponse: ${c.requiresResponse}`)
        console.log(`  lastMessageAt: ${c.lastMessageAt?.toISOString()}`)
        console.log(`  lastInboundAt:  ${c.lastInboundAt?.toISOString() ?? 'null'}`)
        console.log(`  lastOutboundAt: ${c.lastOutboundAt?.toISOString() ?? 'null'}`)
        console.log(`  messages: ${c._count.messages}`)
        console.log('')
    })

    // Also check what 'conversations' API would see — let's count by channel
    const byChannel = await prisma.chat.groupBy({
        by: ['channel'],
        _count: { _all: true },
    })
    console.log('Chats by channel:')
    byChannel.forEach(b => console.log(`  ${b.channel}: ${b._count._all}`))

    await prisma.$disconnect()
}
main().catch(e => { console.error(e); process.exit(1) })
