
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
    console.log("--- DEBUGGING MISSING MAX MESSAGE ---")
    
    // 1. Find the chat for Remezov +79222155750
    const chat = await prisma.chat.findFirst({
        where: {
            OR: [
                { externalChatId: '79222155750' },
                { externalChatId: '+79222155750' }
            ]
        },
        include: {
            driver: true
        }
    })

    if (!chat) {
        console.log("Chat not found for 79222155750")
        return
    }

    console.log(`Found Chat: ID=${chat.id}, channel=${chat.channel}, externalChatId=${chat.externalChatId}`)
    console.log(`Driver: ${chat.driver?.fullName}`)

    // 2. List last 10 messages for this chat
    const messages = await prisma.message.findMany({
        where: { chatId: chat.id },
        orderBy: { createdAt: 'desc' },
        take: 10
    })

    console.log(`Messages found: ${messages.length}`)
    messages.forEach(m => {
        console.log(`[${m.createdAt.toISOString()}] ${m.direction} | content="${m.content}" | status=${m.status} | channel=${m.channel}`)
    })

    // 3. Search for "Тест2" globally just in case
    const globalSearch = await prisma.message.findMany({
        where: { content: { contains: 'Тест2' } },
        orderBy: { createdAt: 'desc' },
        take: 5
    })

    if (globalSearch.length > 0) {
        console.log(`\nGlobal Search for "Тест2" found ${globalSearch.length} results:`)
        globalSearch.forEach(m => {
            console.log(`ID=${m.id}, chatId=${m.chatId}, content="${m.content}", status=${m.status}`)
        })
    } else {
        console.log('\nGlobal search for "Тест2" found NOTHING.')
    }

    await prisma.$disconnect()
}

main()
