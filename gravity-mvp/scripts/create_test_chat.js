
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
  const driver = await prisma.driver.findFirst()
  if (!driver) {
    console.error('No driver found')
    process.exit(1)
  }

  const chat = await prisma.chat.upsert({
    where: { externalChatId: 'test_chat_id' },
    update: {
      status: 'active',
      requiresResponse: true,
      unreadCount: 2,
      lastMessageAt: new Date()
    },
    create: {
      driverId: driver.id,
      channel: 'whatsapp',
      externalChatId: 'test_chat_id',
      name: 'Test Ivan',
      status: 'active',
      requiresResponse: true,
      unreadCount: 2,
      lastMessageAt: new Date()
    }
  })

  await prisma.message.create({
    data: {
      chatId: chat.id,
      direction: 'inbound',
      content: 'Hello from test!',
      status: 'delivered',
      sentAt: new Date()
    }
  })

  console.log('Test chat created:', chat.id)
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
