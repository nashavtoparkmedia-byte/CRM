const { loadEnvConfig } = require('@next/env')
loadEnvConfig(process.cwd())
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
  // Find Ivanov's chat — by phone 73068305553 from screenshot
  const chat = await prisma.chat.findFirst({
    where: { OR: [
      { name: { contains: 'Иванов' } },
      { externalChatId: { contains: '73068305553' } },
    ] },
    include: {
      _count: { select: { messages: true } },
      contact: { select: { id: true, displayName: true } },
      messages: { orderBy: { sentAt: 'desc' }, take: 5, select: { id: true, sentAt: true, direction: true, type: true, content: true, status: true, clientMessageId: true } },
    },
  })
  if (!chat) { console.log('chat not found'); process.exit(0) }
  console.log('Chat:', chat.id)
  console.log('  channel:', chat.channel)
  console.log('  externalChatId:', chat.externalChatId)
  console.log('  name:', chat.name)
  console.log('  contactId:', chat.contactId)
  console.log('  contact:', chat.contact)
  console.log('  status:', chat.status)
  console.log('  lastMessageAt:', chat.lastMessageAt?.toISOString())
  console.log('  totalMessages:', chat._count.messages)
  console.log('  last 5 messages:')
  chat.messages.forEach(m => console.log(`    ${m.sentAt?.toISOString()} ${m.direction} ${m.type} "${m.content?.slice(0, 60)}" clientMessageId="${m.clientMessageId?.slice(0,40)}" status=${m.status}`))
  
  await prisma.$disconnect()
}
main().catch(e => { console.error(e); process.exit(1) })
