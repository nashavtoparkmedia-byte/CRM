
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
    console.log("--- INVESTIGATING CHAT chat_1773610553234 ---")
    
    const chat = await prisma.chat.findUnique({
        where: { id: 'chat_1773610553234' },
        include: { driver: true }
    })

    if (!chat) {
        console.log("Chat not found!")
    } else {
        console.log(`Chat ID: ${chat.id}`)
        console.log(`Channel: ${chat.channel}`)
        console.log(`External ID: ${chat.externalChatId}`)
        console.log(`Driver: ${chat.driver?.fullName || 'N/A'} (ID: ${chat.driverId})`)
        console.log(`Metadata: ${JSON.stringify(chat.metadata)}`)
    }

    await prisma.$disconnect()
}

main()
