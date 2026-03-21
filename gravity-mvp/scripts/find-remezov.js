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
  console.log('--- FINDING ALL CHATS FOR "РЕМЕЗОВ" ---')
  const chats = await prisma.chat.findMany({
    where: { 
      OR: [
        { name: { contains: 'Ремезов', mode: 'insensitive' } },
        { name: { contains: 'Саша', mode: 'insensitive' } },
        { externalChatId: { contains: '79222155750' } }
      ]
    },
    include: { driver: true }
  })

  console.log(`Found ${chats.length} chats.`)
  for (const c of chats) {
    console.log(`ID: ${c.id}`)
    console.log(`Name: ${c.name}`)
    console.log(`Channel: ${c.channel}`)
    console.log(`ExternalChatId: ${c.externalChatId}`)
    console.log(`Driver: ${c.driver ? c.driver.fullName : 'NONE'} (${c.driverId})`)
    console.log('--------------------------')
  }
}

main().catch(console.error).finally(() => prisma.$disconnect())
