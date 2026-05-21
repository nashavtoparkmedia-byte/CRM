const { loadEnvConfig } = require('@next/env')
loadEnvConfig(process.cwd())
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
  const c = await prisma.contact.findUnique({
    where: { id: 'cmnjf1ctd06trvp082hhyciz9' },
    include: {
      phones: { where: { isActive: true }, select: { phone: true, isPrimary: true, isTemporary: true } },
      identities: { where: { isActive: true }, select: { channel: true, externalId: true } },
      driver: { select: { id: true, fullName: true } },
      _count: { select: { chats: true } },
    },
  })
  if (!c) { console.log('Contact not found'); process.exit(1) }
  console.log('Contact:', c.id)
  console.log(`  displayName: ${c.displayName}`)
  console.log(`  isArchived: ${c.isArchived}`)
  console.log(`  primaryChannel: ${c.primaryChannel}`)
  console.log(`  driver: ${c.driver?.id} (${c.driver?.fullName})`)
  console.log(`  phones: ${c.phones.map(p => `${p.phone}${p.isPrimary?'⭐':''}${p.isTemporary?' TEMP':''}`).join(', ')}`)
  console.log(`  identities: ${c.identities.map(i => `${i.channel}:${i.externalId}`).join(', ')}`)
  console.log(`  chats count: ${c._count.chats}`)
  
  // List all chats for this contact
  const chats = await prisma.chat.findMany({
    where: { contactId: c.id },
    select: { id: true, channel: true, externalChatId: true, isArchived: true, lastMessageAt: true },
  })
  console.log(`  Chats:`)
  chats.forEach(ch => console.log(`    ${ch.channel.padEnd(10)} ${ch.externalChatId} archived=${ch.isArchived} last=${ch.lastMessageAt?.toISOString()}`))
  
  await prisma.$disconnect()
}
main().catch(e => { console.error(e); process.exit(1) })
