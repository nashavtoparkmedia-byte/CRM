const { loadEnvConfig } = require('@next/env')
loadEnvConfig(process.cwd())
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
  const chat = await prisma.chat.findFirst({ where: { channel: 'phone' } })
  if (!chat) { console.log('No phone chat'); process.exit(0) }
  
  const msgs = await prisma.message.findMany({
    where: { chatId: chat.id },
    orderBy: { createdAt: 'desc' },
    take: 12,
    select: { id: true, direction: true, type: true, content: true, metadata: true, createdAt: true, sentAt: true },
  })
  console.log(`Last 12 messages in phone-chat ${chat.id}:`)
  msgs.forEach(m => {
    const callId = (m.metadata && m.metadata.callId) ? m.metadata.callId.slice(-8) : '-'
    console.log(`  ${m.sentAt?.toISOString() ?? m.createdAt.toISOString()} ${m.direction.padEnd(8)} ${m.type.padEnd(6)} callId=${callId} "${m.content?.slice(0,40)}"`)
  })
  
  await prisma.$disconnect()
}
main().catch(e => { console.error(e); process.exit(1) })
