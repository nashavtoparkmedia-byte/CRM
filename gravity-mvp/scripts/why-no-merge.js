const { loadEnvConfig } = require('@next/env')
loadEnvConfig(process.cwd())
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
  const chats = await prisma.chat.findMany({
    where: { OR: [{ contactId: 'cmnjf1ctd06trvp082hhyciz9' }, { driverId: 'cmmn7mq4h0003vpz8dxibq1dy' }] },
    select: { id: true, channel: true, externalChatId: true, contactId: true, driverId: true, lastMessageAt: true },
  })
  console.log(`Found ${chats.length} chats for Ремезов:`)
  for (const c of chats) {
    console.log(`  ${c.channel.padEnd(10)} ${c.externalChatId}`)
    console.log(`    chatId=${c.id}`)
    console.log(`    contactId=${c.contactId}`)
    console.log(`    driverId=${c.driverId}`)
    console.log(`    lastMessageAt=${c.lastMessageAt?.toISOString()}`)
  }
  await prisma.$disconnect()
}
main().catch(e => { console.error(e); process.exit(1) })
