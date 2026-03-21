require('dotenv').config()
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()
const fs = require('fs')

async function main() {
  const logFile = 'tg_debug.txt'
  const log = (msg) => fs.appendFileSync(logFile, msg + '\n')
  if (fs.existsSync(logFile)) fs.unlinkSync(logFile)

  log('--- TG DEBUG START ---')
  
  // 1. Latest Telegram messages
  const messages = await prisma.message.findMany({
    where: { 
        OR: [
            { channel: 'telegram' },
            { chatId: { contains: 'telegram' } }
        ]
    },
    orderBy: { sentAt: 'desc' },
    take: 20
  })

  log(`Latest TG messages found: ${messages.length}`)
  messages.forEach(m => {
    log(`[${m.sentAt.toISOString()}] Chat: ${m.chatId} | Status: ${m.status} | Content: "${m.content}"`)
  })

  // 2. Default TG connection status
  const connections = await prisma.telegramConnection.findMany({
    where: { isActive: true }
  })
  log(`Active TG connections: ${connections.length}`)
  connections.forEach(c => {
    log(`- ID: ${c.id} | Phone: ${c.phoneNumber} | Default: ${c.isDefault} | Session: ${c.sessionString ? 'YES' : 'NO'}`)
  })

  log('--- TG DEBUG END ---')
}

main().catch(e => fs.appendFileSync('tg_debug.txt', e.message)).finally(() => prisma.$disconnect())
