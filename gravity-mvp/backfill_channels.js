require('dotenv').config()
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
  console.log('--- STARTING RAW BACKFILL ---')
  
  // 1. Get all chats with their channels
  const chats = await prisma.chat.findMany({ select: { id: true, channel: true } })
  console.log(`Processing ${chats.length} chats...`)

  for (const chat of chats) {
    // Sync all messages for this chat to its current channel
    // This handles both NULL and mismatches
    const count = await prisma.$executeRawUnsafe(`
      UPDATE "Message" 
      SET channel = '${chat.channel}'::"ChatChannel"
      WHERE "chatId" = '${chat.id}' 
      AND (channel IS NULL OR channel != '${chat.channel}'::"ChatChannel")
    `)
    
    if (count > 0) {
      console.log(`Updated ${count} messages for chat ${chat.id} -> ${chat.channel}`)
    }
  }

  console.log('--- RAW BACKFILL COMPLETE ---')
}

main().catch(e => {
  console.error('ERROR:', e.message)
  process.exit(1)
}).finally(() => prisma.$disconnect())
