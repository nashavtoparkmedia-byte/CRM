require('dotenv').config()
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()
const fs = require('fs')

async function main() {
  const logFile = 'db_log.txt'
  const log = (msg) => {
    console.log(msg)
    fs.appendFileSync(logFile, msg + '\n')
  }

  if (fs.existsSync(logFile)) fs.unlinkSync(logFile)

  log('--- DB DIAGNOSTIC START ---')
  const chatId = 'cmmtnhhlt00upvpgks9dydnzw'
  log(`Checking ChatId: ${chatId}`)

  const chat = await prisma.chat.findUnique({
    where: { id: chatId },
    include: {
        driver: true,
        _count: { select: { messages: true } }
    }
  })

  if (!chat) {
    log('ERROR: Chat not found')
  } else {
    log(`CHAT: ${chat.name} | Channel: ${chat.channel} | Driver: ${chat.driver?.fullName} | Msgs: ${chat._count.messages}`)
    const messages = await prisma.message.findMany({
      where: { chatId: chatId },
      orderBy: { sentAt: 'desc' },
      take: 10
    })
    messages.forEach(m => {
      log(`  [${m.sentAt.toISOString()}] ${m.direction} | ${m.status} | "${m.content}"`)
    })

    // Check if there are other chats for the same driver
    const otherChats = await prisma.chat.findMany({
        where: { driverId: chat.driverId },
        include: { _count: { select: { messages: true } } }
    })
    log(`Other chats for driver ${chat.driverId}:`)
    otherChats.forEach(c => {
        log(`  - ${c.id} | ${c.channel} | Msgs: ${c._count.messages}`)
    })
  }

  log('--- DB DIAGNOSTIC END ---')
}

main()
  .catch(e => {
    fs.appendFileSync('db_log.txt', 'FATAL ERROR: ' + e.message + '\n')
    console.error(e)
  })
  .finally(async () => await prisma.$disconnect())
