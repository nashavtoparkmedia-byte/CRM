/**
 * Wipe all WhatsApp message/chat data to prepare a fresh-backfill test.
 *
 * Deletes:
 *   - Message (channel=whatsapp)
 *   - Chat (channel=whatsapp)
 *   - WhatsAppMessage (all rows — this table only holds WA data)
 *   - WhatsAppChat (all rows)
 *   - WhatsAppChatRoster (all rows)
 *
 * Does NOT touch:
 *   - WhatsAppConnection (keeps phone/session binding)
 *   - Driver, Contact, User (core CRM data)
 *   - .wwebjs_auth folder (leaves the authenticated WA session alive)
 *
 * After running this + reloading UI → chats view should show empty.
 * Then trigger history backfill (last 7 days) from UI to refill.
 *
 * Usage:
 *   node scripts/wipe-whatsapp-data.js
 */

const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
    console.log('[WIPE] Starting WhatsApp data wipe...')
    const t0 = Date.now()

    // Delete in order that respects foreign keys. Messages reference chats,
    // so messages first.

    const waMsg = await prisma.whatsAppMessage.deleteMany({})
    console.log(`[WIPE] Deleted ${waMsg.count} WhatsAppMessage rows`)

    const msg = await prisma.message.deleteMany({ where: { channel: 'whatsapp' } })
    console.log(`[WIPE] Deleted ${msg.count} Message rows (channel=whatsapp)`)

    const waChat = await prisma.whatsAppChat.deleteMany({})
    console.log(`[WIPE] Deleted ${waChat.count} WhatsAppChat rows`)

    const chat = await prisma.chat.deleteMany({ where: { channel: 'whatsapp' } })
    console.log(`[WIPE] Deleted ${chat.count} Chat rows (channel=whatsapp)`)

    const roster = await prisma.whatsAppChatRoster.deleteMany({})
    console.log(`[WIPE] Deleted ${roster.count} WhatsAppChatRoster rows`)

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
    console.log(`[WIPE] Done in ${elapsed}s.`)
    console.log('[WIPE] Next steps:')
    console.log('  1. Refresh the CRM chats page — WA section should be empty.')
    console.log('  2. Open /settings/integrations/whatsapp → "Синхронизировать снова" (7 days).')
    console.log('  3. Verify messages reappear in chats.')
}

main()
    .catch(err => {
        console.error('[WIPE] FAILED:', err)
        process.exitCode = 1
    })
    .finally(() => prisma.$disconnect())
