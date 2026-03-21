const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
    console.log('--- WhatsApp Connections ---')
    const wa = await prisma.whatsAppConnection.findMany()
    console.table(wa.map(c => ({ id: c.id, name: c.name, status: c.status, phone: c.phoneNumber })))

    console.log('\n--- MAX Connections ---')
    const max = await prisma.maxConnection.findMany()
    console.table(max.map(c => ({ id: c.id, name: c.name, active: c.isActive })))

    console.log('\n--- Telegram Connections ---')
    const tg = await prisma.telegramConnection.findMany()
    console.table(tg.map(c => ({ id: c.id, name: c.name, active: c.isActive, default: c.isDefault })))
}

main().catch(console.error).finally(() => prisma.$disconnect())
