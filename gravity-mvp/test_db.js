require('dotenv').config()
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
  console.log('--- DB DIAGNOSTIC START ---')
  const driver = await prisma.driver.findFirst({
    where: { phone: { contains: '9222155750' } }
  })
  console.log('DRIVER:', driver ? `${driver.fullName} (${driver.id})` : 'NOT FOUND')

  if (driver) {
    const chats = await prisma.chat.findMany({
      where: { driverId: driver.id },
      include: {
        _count: {
          select: { messages: true }
        }
      }
    })
    console.log(`CHATS FOUND: ${chats.length}`)

    for (const chat of chats) {
      console.log(`- Chat: ${chat.id} | Channel: ${chat.channel} | Messages: ${chat._count.messages}`)
      const latest = await prisma.message.findMany({
        where: { chatId: chat.id },
        orderBy: { sentAt: 'desc' },
        take: 3
      })
      latest.forEach(m => {
        console.log(`  [${m.sentAt.toISOString()}] ${m.direction} | ${m.status} | "${m.content.substring(0, 20)}..."`)
      })
    }
  }
  console.log('--- DB DIAGNOSTIC END ---')
}

main()
  .catch(e => console.error(e))
  .finally(async () => await prisma.$disconnect())
