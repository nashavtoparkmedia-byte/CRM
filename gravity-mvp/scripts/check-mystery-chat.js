const { loadEnvConfig } = require('@next/env')
loadEnvConfig(process.cwd())
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()
async function main() {
  const chatId = 'cmp8acx6o00dyvpr4r7fvp6n3'
  const chat = await prisma.chat.findUnique({
    where: { id: chatId },
    include: {
      _count: { select: { messages: true } },
      contact: { select: { id: true, displayName: true } },
      contactIdentity: true,
      messages: { orderBy: { sentAt: 'desc' }, take: 10 },
    },
  })
  if (!chat) { console.log('chat not found'); process.exit(0) }
  console.log('Chat:', chat.id)
  console.log('  channel:', chat.channel)
  console.log('  externalChatId:', chat.externalChatId)
  console.log('  name:', chat.name)
  console.log('  contactId:', chat.contactId)
  console.log('  contact:', chat.contact)
  console.log('  contactIdentity:', chat.contactIdentity)
  console.log('  metadata:', JSON.stringify(chat.metadata))
  console.log('  lastMessageAt:', chat.lastMessageAt?.toISOString())
  console.log('  totalMessages:', chat._count.messages)
  console.log('  messages:')
  chat.messages.forEach(m => console.log(`    ${m.sentAt?.toISOString()} ${m.direction} ${m.type} ch=${m.channel} "${(m.content || '').slice(0, 80)}" externalId="${m.externalId?.slice(0,40)}"`))
  
  // Also check other chats with this contact
  if (chat.contactId) {
    const others = await prisma.chat.findMany({
      where: { contactId: chat.contactId, NOT: { id: chatId } },
      select: { id: true, channel: true, externalChatId: true, name: true, lastMessageAt: true, _count: { select: { messages: true } } },
    })
    console.log()
    console.log(`Other chats for same contact (${chat.contactId}):`)
    others.forEach(o => console.log(`  ${o.id} ch=${o.channel} ext="${o.externalChatId}" name="${o.name}" msgs=${o._count.messages} last=${o.lastMessageAt?.toISOString()}`))
  }
  
  // Check identities for this contact
  if (chat.contactId) {
    const idents = await prisma.contactIdentity.findMany({
      where: { contactId: chat.contactId },
    })
    console.log()
    console.log('Identities:')
    idents.forEach(i => console.log(`  ${i.channel}:${i.externalId} active=${i.isActive}`))
  }
  
  await prisma.$disconnect()
}
main().catch(e => { console.error(e); process.exit(1) })
