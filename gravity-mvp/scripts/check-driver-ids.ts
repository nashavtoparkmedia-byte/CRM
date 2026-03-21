
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
    const waChat = await prisma.chat.findUnique({ where: { id: 'cmms4a8py0001vpnsde1ex208' } })
    const maxChat = await prisma.chat.findUnique({ where: { id: 'chat_1773610553234' } })
    
    console.log(`WA Chat DriverID: ${waChat?.driverId}`)
    console.log(`MAX Chat DriverID: ${maxChat?.driverId}`)

    await prisma.$disconnect()
}

main()
