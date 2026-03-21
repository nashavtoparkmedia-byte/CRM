import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  console.log('--- ALL WHATSAPP CHATS ---')
  const chats = await (prisma.chat as any).findMany({
    where: { channel: 'whatsapp' },
    include: { driver: true }
  })

  for (const chat of chats) {
    console.log(`ID: ${chat.id}`)
    console.log(`Name: ${chat.name}`)
    console.log(`ExternalChatId: ${chat.externalChatId}`)
    console.log(`Driver: ${chat.driver?.fullName || 'NONE'} (${chat.driverId})`)
    
    const messageCount = await (prisma.message as any).count({ where: { chatId: chat.id } })
    console.log(`Messages: ${messageCount}`)
    
    const lastMsg = await (prisma.message as any).findFirst({
        where: { chatId: chat.id },
        orderBy: { sentAt: 'desc' }
    })
    console.log(`Last Content: ${lastMsg?.content || 'N/A'}`)
    console.log('--------------------------')
  }
}

main()
  .catch(e => console.error(e))
  .finally(async () => await prisma.$disconnect())
