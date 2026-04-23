/**
 * Targeted cleanup of WA junk in DB (keeps real chats/messages):
 *   1. Empty Chat rows — WA chats with zero messages (UI ghosts).
 *   2. Messages where content/body is a raw JID literal (protocol noise).
 *   3. Empty text messages — type=text with empty content (renders as
 *      blank bubbles in the UI).
 *   4. Outbound backfill messages with missing/queued status — bump to
 *      'delivered' (they already left the phone by the time we ingested
 *      them; "Повторить" button is misleading).
 *   5. Their corresponding legacy WhatsAppChat / WhatsAppMessage rows.
 */
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

const JID_LIKE = /^[\d+]+@(c\.us|lid|g\.us|broadcast)$/i

async function main() {
    console.log('[CLEANUP] Starting targeted WA junk cleanup...')

    // ── PART 1 — remove junk messages (body = raw JID) ───────────────
    const junkUnified = await prisma.message.findMany({
        where: { channel: 'whatsapp' },
        select: { id: true, content: true },
    })
    const junkUnifiedIds = junkUnified
        .filter(m => {
            const c = (m.content || '').trim()
            return c && JID_LIKE.test(c)
        })
        .map(m => m.id)

    if (junkUnifiedIds.length > 0) {
        const r = await prisma.message.deleteMany({ where: { id: { in: junkUnifiedIds } } })
        console.log(`[CLEANUP] Deleted ${r.count} unified Messages with JID-like content`)
    } else {
        console.log(`[CLEANUP] No junk unified messages found`)
    }

    const junkLegacy = await prisma.whatsAppMessage.findMany({ select: { id: true, chatId: true, body: true } })
    const junkLegacyPairs = junkLegacy
        .filter(m => {
            const b = (m.body || '').trim()
            return b && JID_LIKE.test(b)
        })
        .map(m => ({ id: m.id, chatId: m.chatId }))

    if (junkLegacyPairs.length > 0) {
        for (const p of junkLegacyPairs) {
            await prisma.whatsAppMessage.delete({ where: { id_chatId: { id: p.id, chatId: p.chatId } } }).catch(() => {})
        }
        console.log(`[CLEANUP] Deleted ${junkLegacyPairs.length} legacy WhatsAppMessages with JID body`)
    } else {
        console.log(`[CLEANUP] No junk legacy messages found`)
    }

    // ── PART 1b — remove empty text messages (type=text, content="") ─
    const emptyText = await prisma.message.findMany({
        where: { channel: 'whatsapp', type: 'text' },
        select: { id: true, content: true },
    })
    const emptyTextIds = emptyText.filter(m => !(m.content || '').trim()).map(m => m.id)
    if (emptyTextIds.length > 0) {
        const r = await prisma.message.deleteMany({ where: { id: { in: emptyTextIds } } })
        console.log(`[CLEANUP] Deleted ${r.count} empty-text unified Messages`)
    } else {
        console.log(`[CLEANUP] No empty-text messages`)
    }

    const emptyTextLegacy = await prisma.whatsAppMessage.findMany({
        where: { type: 'chat' },
        select: { id: true, chatId: true, body: true },
    })
    const emptyTextLegacyPairs = emptyTextLegacy.filter(m => !(m.body || '').trim()).map(m => ({ id: m.id, chatId: m.chatId }))
    if (emptyTextLegacyPairs.length > 0) {
        for (const p of emptyTextLegacyPairs) {
            await prisma.whatsAppMessage.delete({ where: { id_chatId: { id: p.id, chatId: p.chatId } } }).catch(() => {})
        }
        console.log(`[CLEANUP] Deleted ${emptyTextLegacyPairs.length} empty-text legacy WhatsAppMessages`)
    } else {
        console.log(`[CLEANUP] No empty-text legacy messages`)
    }

    // ── PART 1c — fix backfilled outbound that got "failed" by recovery ─
    // MessageService.recoverStuckMessages marks outbound status='sent'
    // older than 5min as 'failed', mistaking backfilled-from-WA-Store
    // messages for stuck-in-delivery ones. Those have externalId !== null
    // (came from WA Web, already delivered). Reset them to delivered.
    const stuckOutbound = await prisma.message.updateMany({
        where: {
            channel: 'whatsapp',
            direction: 'outbound',
            externalId: { not: null },
            status: { in: ['failed', 'sent', 'queued'] },
        },
        data: { status: 'delivered' },
    })
    console.log(`[CLEANUP] Updated ${stuckOutbound.count} backfilled outbound messages to status=delivered`)

    // ── PART 2 — remove empty unified Chat rows ──────────────────────
    const waChats = await prisma.chat.findMany({
        where: { channel: 'whatsapp' },
        select: { id: true, externalChatId: true, _count: { select: { messages: true } } },
    })
    const emptyChatIds = waChats.filter(c => c._count.messages === 0).map(c => c.id)
    const emptyExternalIds = waChats.filter(c => c._count.messages === 0).map(c => c.externalChatId)

    if (emptyChatIds.length > 0) {
        const r = await prisma.chat.deleteMany({ where: { id: { in: emptyChatIds } } })
        console.log(`[CLEANUP] Deleted ${r.count} empty unified Chat rows`)
    } else {
        console.log(`[CLEANUP] No empty unified Chat rows`)
    }

    // ── PART 3 — remove empty legacy WhatsAppChat + its roster row ───
    // (a WhatsAppChat is "empty" if it has no WhatsAppMessage rows)
    const waChatsLegacy = await prisma.whatsAppChat.findMany({
        select: { id: true, _count: { select: { messages: true } } },
    })
    const emptyLegacyIds = waChatsLegacy.filter(c => c._count.messages === 0).map(c => c.id)

    if (emptyLegacyIds.length > 0) {
        // Roster uses `jid` not `chatId` and isn't FK-linked, so delete is independent.
        const rosterDel = await prisma.whatsAppChatRoster.deleteMany({
            where: { jid: { in: emptyLegacyIds } },
        })
        const legacyDel = await prisma.whatsAppChat.deleteMany({ where: { id: { in: emptyLegacyIds } } })
        console.log(`[CLEANUP] Deleted ${legacyDel.count} empty legacy WhatsAppChat rows (+ ${rosterDel.count} roster entries)`)
    } else {
        console.log(`[CLEANUP] No empty legacy WhatsAppChat rows`)
    }

    // ── Final summary ───────────────────────────────────────────────
    const finalCount = await prisma.chat.count({ where: { channel: 'whatsapp' } })
    const finalMsgCount = await prisma.message.count({ where: { channel: 'whatsapp' } })
    const finalWAChatCount = await prisma.whatsAppChat.count()
    const finalWAMsgCount = await prisma.whatsAppMessage.count()

    console.log(`\n[CLEANUP] Final state:`)
    console.log(`   Chat    (whatsapp): ${finalCount}`)
    console.log(`   Message (whatsapp): ${finalMsgCount}`)
    console.log(`   WhatsAppChat:       ${finalWAChatCount}`)
    console.log(`   WhatsAppMessage:    ${finalWAMsgCount}`)
}

main()
    .catch(err => { console.error('[CLEANUP] FAILED:', err); process.exitCode = 1 })
    .finally(() => prisma.$disconnect())
