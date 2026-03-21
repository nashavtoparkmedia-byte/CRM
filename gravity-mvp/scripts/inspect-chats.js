const { PrismaClient } = require('@prisma/client')

const prisma = new PrismaClient()

async function main() {
  console.log('--- ALL WHATSAPP CHATS ---')
  const chats = await prisma.chat.findMany({
    where: { channel: 'whatsapp' },
    include: { driver: true }
  })

  for (const chat of chats) {
    console.log(`ID: ${chat.id}`)
    console.log(`Name: ${chat.name}`)
    console.log(`ExternalChatId: ${chat.externalChatId}`)
    console.log(`Driver: ${chat.driver ? chat.driver.fullName : 'NONE'} (${chat.driverId})`)
    
    const messageCount = await prisma.message.count({ where: { chatId: chat.id } })
    console.log(`Messages: ${messageCount}`)
    
    const lastMsg = await prisma.message.findFirst({
        where: { chatId: chat.id },
        orderBy: { sentAt: 'desc' }
    })
    console.log(`Last Content: ${lastMsg ? lastMsg.content : 'N/A'}`)
    console.log('--------------------------')
  }
}

main()
  .catch(e => console.error(e))
  .finally(async () => await prisma.$disconnect())
