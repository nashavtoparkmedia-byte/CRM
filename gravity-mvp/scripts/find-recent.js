console.log('--- STARTING DIAGNOSTIC SCRIPT ---')
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
  console.log('--- RECENT MESSAGES (Last Hour) ---')
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)
  
  const messages = await prisma.message.findMany({
    where: { 
      createdAt: { gte: oneHourAgo }
    },
    include: { chat: true },
    orderBy: { createdAt: 'desc' }
  })

  if (messages.length === 0) {
    console.log('No messages found in the last hour.')
  } else {
    for (const m of messages) {
      console.log(`Msg ID: ${m.id}`)
      console.log(`Content: "${m.content}"`)
      console.log(`Direction: ${m.direction}`)
      console.log(`Chat ID: ${m.chatId}`)
      console.log(`Chat External ID: ${m.chat.externalChatId}`)
      console.log(`Chat Name: ${m.chat.name}`)
      console.log(`Created At: ${m.createdAt.toISOString()}`)
      console.log('--------------------------')
    }
  }
}

main().catch(console.error).finally(() => prisma.$disconnect())
