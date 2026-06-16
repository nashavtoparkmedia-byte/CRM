/**
 * One-shot: merge phone-format WA chat into the @lid chat that has the actual
 * conversation, then rename the @lid chat to the canonical phone format.
 *
 * Chats in question (found via logs):
 *   KEEP  cmqfw19gs0002sg2639z1tz9g  165193082482905@lid  (has messages, current)
 *   DEL   cmq9z45jy02e9l3243rrql7ik  whatsapp:79222155750 (empty duplicate)
 */
const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()

const KEEP_ID  = 'cmqfw19gs0002sg2639z1tz9g'   // @lid chat — we keep this
const DEL_ID   = 'cmq9z45jy02e9l3243rrql7ik'   // phone chat — we delete this
const PHONE_EXT = 'whatsapp:79222155750'         // target externalChatId for KEEP

async function main() {
  // 1. Sanity check
  const [keep, del] = await Promise.all([
    p.chat.findUnique({ where: { id: KEEP_ID }, select: { id: true, externalChatId: true, name: true } }),
    p.chat.findUnique({ where: { id: DEL_ID  }, select: { id: true, externalChatId: true, name: true } }),
  ])
  if (!keep) throw new Error(`KEEP chat ${KEEP_ID} not found`)
  if (!del)  { console.log('DEL chat already gone — only rename needed'); }
  console.log('KEEP:', JSON.stringify(keep))
  console.log('DEL: ', JSON.stringify(del))

  // 2. Move messages from DEL to KEEP
  if (del) {
    const moved = await p.message.updateMany({
      where: { chatId: DEL_ID },
      data:  { chatId: KEEP_ID },
    })
    console.log(`Moved ${moved.count} messages from DEL to KEEP`)

    // 3. Delete the phone chat (cascade should handle FK'd messages now moved)
    await p.chat.delete({ where: { id: DEL_ID } })
    console.log('Deleted DEL chat')
  }

  // 4. Rename KEEP to canonical phone format
  await p.chat.update({
    where: { id: KEEP_ID },
    data:  { externalChatId: PHONE_EXT },
  })
  console.log(`Renamed KEEP externalChatId → ${PHONE_EXT}`)

  // 5. Also fix the WhatsAppChat legacy row if it still uses @lid
  const waChat = await p.whatsAppChat.findUnique({ where: { id: '165193082482905@lid' } })
  if (waChat) {
    // Can't rename PK — create phone row, delete old one
    await p.whatsAppChat.upsert({
      where:  { id: '79222155750@c.us' },
      update: { lastMessageAt: waChat.lastMessageAt },
      create: { id: '79222155750@c.us', connectionId: waChat.connectionId, lastMessageAt: waChat.lastMessageAt },
    })
    await p.whatsAppMessage.updateMany({ where: { chatId: '165193082482905@lid' }, data: { chatId: '79222155750@c.us' } })
    await p.whatsAppChat.delete({ where: { id: '165193082482905@lid' } })
    console.log('Fixed legacy WhatsAppChat row')
  }

  console.log('Done.')
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => p.$disconnect())
