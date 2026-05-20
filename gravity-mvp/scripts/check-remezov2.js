const { loadEnvConfig } = require('@next/env')
loadEnvConfig(process.cwd())
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
  const chats = await prisma.chat.findMany({
    where: { contactId: 'cmnjf1ctd06trvp082hhyciz9' },
    select: {
      id: true, channel: true, externalChatId: true, status: true,
      lastMessageAt: true, _count: { select: { messages: true } },
    },
    orderBy: { lastMessageAt: 'desc' },
  })
  console.log(`Ремезов has ${chats.length} chats:`)
  chats.forEach(ch => console.log(`  ${ch.channel.padEnd(10)} ${ch.externalChatId.padEnd(30)} msgs=${ch._count.messages} last=${ch.lastMessageAt?.toISOString()}`))
  await prisma.$disconnect()
}
main().catch(e => { console.error(e); process.exit(1) })
