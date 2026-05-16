const { loadEnvConfig } = require('@next/env')
loadEnvConfig(process.cwd())
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()
async function main() {
  const chats = await prisma.chat.findMany({
    where: { contactId: 'cmp7xm4v10048vp6kyzjikiaz' },
    include: {
      _count: { select: { messages: true } },
      contactIdentity: { select: { id: true, channel: true, externalId: true } },
    },
  })
  console.log(`Found ${chats.length} chats for Ivanov contact:`)
  for (const c of chats) {
    console.log(`  ${c.id}`)
    console.log(`    channel: ${c.channel}`)
    console.log(`    externalChatId: ${c.externalChatId}`)
    console.log(`    name: ${c.name}`)
    console.log(`    contactIdentityId: ${c.contactIdentityId}`)
    console.log(`    contactIdentity: ${JSON.stringify(c.contactIdentity)}`)
    console.log(`    metadata: ${JSON.stringify(c.metadata)}`)
    console.log(`    messages: ${c._count.messages}`)
    console.log(`    lastMessageAt: ${c.lastMessageAt?.toISOString()}`)
    console.log(`    createdAt: ${c.createdAt?.toISOString()}`)
    console.log('')
  }
  // Also fetch ContactIdentity for this contact
  const idents = await prisma.contactIdentity.findMany({
    where: { contactId: 'cmp7xm4v10048vp6kyzjikiaz' },
  })
  console.log('Identities:')
  idents.forEach(i => console.log(`  ${i.id} ch=${i.channel} ext=${i.externalId} active=${i.isActive} meta=${JSON.stringify(i.metadata)}`))
  await prisma.$disconnect()
}
main().catch(e => { console.error(e); process.exit(1) })
