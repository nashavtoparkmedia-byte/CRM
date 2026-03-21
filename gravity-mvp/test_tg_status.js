require('dotenv').config()
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()
const fs = require('fs')

async function main() {
  const logFile = 'tg_status_check.txt'
  const log = (msg) => fs.appendFileSync(logFile, msg + '\n')
  if (fs.existsSync(logFile)) fs.unlinkSync(logFile)

  log('--- TG STATUS CHECK START ---')
  const now = new Date()
  const thirtyMinAgo = new Date(now.getTime() - 30 * 60 * 1000)

  const messages = await prisma.message.findMany({
    where: {
      sentAt: { gte: thirtyMinAgo },
      chat: { channel: 'telegram' }
    },
    include: {
      chat: true
    },
    orderBy: { sentAt: 'desc' }
  })

  log(`Found ${messages.length} Telegram messages in the last 30 min`)
  messages.forEach(m => {
    log(`MSG: ${m.id} | Status: ${m.status} | Content: "${m.content}"`)
    log(`  Chat: ${m.chat.id} | Ext: ${m.chat.externalChatId} | Metadata: ${JSON.stringify(m.chat.metadata)}`)
  })

  log('--- TG STATUS CHECK END ---')
}

main().catch(e => fs.appendFileSync('tg_status_check.txt', e.message)).finally(() => prisma.$disconnect())
