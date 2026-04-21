// Diagnose Казбек's unread counter: actual DB state vs displayed value
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
  console.log('=== Searching for Казбек chats ===')

  // Find all chats matching "Казбек" by name
  const chats = await prisma.$queryRaw`
    SELECT id, "driverId", "contactId", channel, "externalChatId", name,
           "unreadCount", "lastMessageAt", "lastInboundAt", "lastOutboundAt", status
    FROM "Chat"
    WHERE name ILIKE '%казбек%' OR name ILIKE '%kazbek%'
    ORDER BY "lastMessageAt" DESC NULLS LAST
  `

  console.log(`\nFound ${chats.length} chats with "Казбек" in name:`)
  for (const c of chats) {
    console.log(`\n  Chat: ${c.id}`)
    console.log(`    channel:         ${c.channel}`)
    console.log(`    externalChatId:  ${c.externalChatId}`)
    console.log(`    name:            ${c.name}`)
    console.log(`    driverId:        ${c.driverId}`)
    console.log(`    contactId:       ${c.contactId}`)
    console.log(`    unreadCount:     ${c.unreadCount}`)
    console.log(`    status:          ${c.status}`)
    console.log(`    lastMessageAt:   ${c.lastMessageAt}`)
    console.log(`    lastInboundAt:   ${c.lastInboundAt}`)
    console.log(`    lastOutboundAt:  ${c.lastOutboundAt}`)

    // Count actual messages in chat
    const inbound = await prisma.$queryRaw`
      SELECT COUNT(*)::int AS c FROM "Message"
      WHERE "chatId" = ${c.id} AND direction = 'inbound'
    `
    const outbound = await prisma.$queryRaw`
      SELECT COUNT(*)::int AS c FROM "Message"
      WHERE "chatId" = ${c.id} AND direction = 'outbound'
    `

    // Count inbound after last outbound
    const newInbound = c.lastOutboundAt
      ? await prisma.$queryRaw`
          SELECT COUNT(*)::int AS c FROM "Message"
          WHERE "chatId" = ${c.id} AND direction = 'inbound'
            AND "sentAt" > ${c.lastOutboundAt}
        `
      : [{ c: 0 }]

    console.log(`    --- Messages analytics ---`)
    console.log(`    inbound total:   ${inbound[0].c}`)
    console.log(`    outbound total:  ${outbound[0].c}`)
    console.log(`    inbound after last outbound: ${newInbound[0].c}`)
  }

  // Also check Чат.name containing "6669908482" or relevant phone
  console.log('\n=== Checking for Chat with specific contact/driver grouping ===')
  if (chats.length > 0) {
    const first = chats[0]
    if (first.contactId) {
      const groupChats = await prisma.$queryRaw`
        SELECT id, channel, name, "unreadCount", "lastMessageAt"
        FROM "Chat"
        WHERE "contactId" = ${first.contactId}
        ORDER BY "lastMessageAt" DESC NULLS LAST
      `
      console.log(`\nAll chats for contactId=${first.contactId}:`)
      for (const c of groupChats) {
        console.log(`  ${c.channel.padEnd(12)} ${c.id}  unread=${c.unreadCount}  ${c.name}`)
      }
      const sum = groupChats.reduce((s, c) => s + c.unreadCount, 0)
      console.log(`  SUM unreadCount: ${sum}`)
    } else if (first.driverId) {
      const groupChats = await prisma.$queryRaw`
        SELECT id, channel, name, "unreadCount", "lastMessageAt"
        FROM "Chat"
        WHERE "driverId" = ${first.driverId}
        ORDER BY "lastMessageAt" DESC NULLS LAST
      `
      console.log(`\nAll chats for driverId=${first.driverId}:`)
      for (const c of groupChats) {
        console.log(`  ${c.channel.padEnd(12)} ${c.id}  unread=${c.unreadCount}  ${c.name}`)
      }
      const sum = groupChats.reduce((s, c) => s + c.unreadCount, 0)
      console.log(`  SUM unreadCount: ${sum}`)
    }
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
