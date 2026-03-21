import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

async function main() {
  const wa = await prisma.whatsAppConnection.findMany()
  console.log('WA Connections:')
  wa.forEach(c => console.log(`  id=${c.id} name=${c.name} phone=${c.phoneNumber} status=${c.status}`))

  // Check recent messages in Ремезов chats
  const driver = await prisma.driver.findFirst({ where: { fullName: { contains: 'Ремезов' } } })
  if (driver) {
    const chats = await prisma.chat.findMany({ where: { driverId: driver.id } })
    console.log(`\nChats for Remezov (${driver.fullName}):`)
    chats.forEach(c => console.log(`  id=${c.id} channel=${c.channel} externalChatId=${c.externalChatId}`))

    for (const c of chats.slice(0, 5)) {
      const msgs = await prisma.message.findMany({ where: { chatId: c.id }, orderBy: { sentAt: 'desc' }, take: 5 })
      console.log(`  Messages in ${c.id}:`)
      msgs.forEach(m => console.log(`    dir=${m.direction} status=${m.status} content="${m.content?.substring(0, 30)}" ch=${m.channel}`))
    }

    // Also check unsaved (no driver) chats recently created
    const unsavedChats = await prisma.chat.findMany({
      where: { driverId: null, lastMessageAt: { gte: new Date(Date.now() - 1000 * 60 * 30) } }
    })
    console.log(`\nRecently updated chats with no driver:`)
    unsavedChats.forEach(c => console.log(`  id=${c.id} channel=${c.channel} externalChatId=${c.externalChatId} name=${c.name}`))
  }
}

main().catch(console.error).finally(() => prisma.$disconnect())
