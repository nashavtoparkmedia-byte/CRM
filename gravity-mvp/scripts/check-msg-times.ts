
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
    const msg = await prisma.message.findFirst({
        where: { content: { contains: 'Тест2' } },
        orderBy: { createdAt: 'desc' }
    })
    
    if (msg) {
        console.log(`Content: ${msg.content}`)
        console.log(`SentAt: ${msg.sentAt.toISOString()}`)
        console.log(`CreatedAt: ${msg.createdAt.toISOString()}`)
        console.log(`Now: ${new Date().toISOString()}`)
        console.log(`Status: ${msg.status}`)
        console.log(`ChatID: ${msg.chatId}`)
    } else {
        console.log("Message not found!")
    }

    await prisma.$disconnect()
}

main()
