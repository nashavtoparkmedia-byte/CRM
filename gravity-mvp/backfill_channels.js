require('dotenv').config()
const { PrismaClient } = require('@prisma/client')
const { backfillMessageChannelV1 } = require('./src/modules/messaging/public/v1/legacy-prisma-chat-backfill-adapter')
const prisma = new PrismaClient()

async function main() {
  console.log('--- STARTING RAW BACKFILL ---')
  
  // 1. Get all chats with their channels
  const chats = await prisma.chat.findMany({ select: { id: true, channel: true } })
  console.log(`Processing ${chats.length} chats...`)

  for (const chat of chats) {
    // Sync all messages for this chat to its current channel
    // This handles both NULL and mismatches
    const messages = await prisma.message.findMany({ where: { chatId: chat.id, OR: [{ channel: null }, { channel: { not: chat.channel } }] }, select: { id: true } })
    for (const message of messages) await backfillMessageChannelV1(message.id, chat.channel)
    const count = messages.length
    
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
