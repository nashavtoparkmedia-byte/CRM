const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
  console.log('--- Searching for message "203" ---')
  const messages = await prisma.message.findMany({
    where: { content: { contains: '203' } },
    include: { chat: true }
  })

  if (messages.length === 0) {
    console.log('Message "203" NOT FOUND in the Message table.')
  } else {
    for (const m of messages) {
      console.log(`Msg ID: ${m.id}`)
      console.log(`Content: ${m.content}`)
      console.log(`Chat ID: ${m.chatId}`)
      console.log(`Chat External ID: ${m.chat.externalChatId}`)
      console.log(`Chat Name: ${m.chat.name}`)
      console.log(`Direction: ${m.direction}`)
      console.log('--------------------------')
    }
  }
}

main().catch(console.error).finally(() => prisma.$disconnect())
