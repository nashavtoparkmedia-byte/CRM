const { PrismaClient } = require('@prisma/client')
const fs = require('fs')
const path = require('path')

// Manually load .env
const envPath = path.join(__dirname, '..', '.env')
if (fs.existsSync(envPath)) {
  const envFile = fs.readFileSync(envPath, 'utf8')
  const lines = envFile.split('\n')
  for (const line of lines) {
    const [key, value] = line.split('=')
    if (key && value) {
      process.env[key.trim()] = value.trim().replace(/^"|"$/g, '')
    }
  }
}

const prisma = new PrismaClient()

async function main() {
  const phone = '79222155750'
  console.log(`--- LATEST MESSAGES FOR ${phone} ---`)
  
  const messages = await prisma.message.findMany({
    where: { 
      chat: {
        OR: [
          { externalChatId: `whatsapp:${phone}` },
          { externalChatId: { contains: phone } }
        ]
      }
    },
    include: { chat: true },
    orderBy: { createdAt: 'desc' },
    take: 20
  })

  console.log(`Found ${messages.length} recent messages.`)
  for (const m of messages) {
    console.log(`[${m.createdAt.toISOString()}] ${m.direction}: "${m.content}" (ChatID: ${m.chatId})`)
  }
}

main().catch(console.error).finally(() => prisma.$disconnect())
