/**
 * Audit: check if any group (@g.us) chats or messages leaked into the DB.
 * We expect zero of each after Stage-1 fixes; anything > 0 is a regression
 * or a path that still bypasses the filter.
 */
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
    // 1. Legacy WhatsAppChat table — id is the raw WA JID.
    const waGroupChats = await prisma.whatsAppChat.findMany({
        where: { id: { contains: '@g.us' } },
        select: { id: true, name: true, lastMessageAt: true },
        take: 20,
    })
    const waGroupChatCount = await prisma.whatsAppChat.count({
        where: { id: { contains: '@g.us' } },
    })
    console.log(`[AUDIT] WhatsAppChat with @g.us: ${waGroupChatCount}`)
    if (waGroupChats.length > 0) {
        console.log('[AUDIT] Sample group chats:')
        for (const c of waGroupChats) {
            console.log(`   id=${c.id} name="${c.name}" last=${c.lastMessageAt?.toISOString()}`)
        }
    }

    // 2. Unified Chat table — externalChatId could contain the JID.
    const unifiedGroupChats = await prisma.chat.count({
        where: {
            channel: 'whatsapp',
            OR: [
                { externalChatId: { contains: '@g.us' } },
                { externalChatId: { contains: 'g.us' } }, // defensive
            ],
        },
    })
    console.log(`[AUDIT] Unified Chat (channel=whatsapp) with @g.us: ${unifiedGroupChats}`)

    // 3. WhatsAppMessage — chatId points to WhatsAppChat.id which is the JID.
    const waGroupMsgs = await prisma.whatsAppMessage.count({
        where: { chatId: { contains: '@g.us' } },
    })
    console.log(`[AUDIT] WhatsAppMessage linked to @g.us chat: ${waGroupMsgs}`)

    // 4. Cross-check: sample actual chat JIDs present, see what the shape looks like
    const sample = await prisma.whatsAppChat.findMany({
        select: { id: true, name: true },
        take: 10,
        orderBy: { lastMessageAt: 'desc' },
    })
    console.log(`[AUDIT] Sample of ${sample.length} most-recent WhatsAppChat JIDs:`)
    for (const c of sample) console.log(`   ${c.id}  name="${c.name}"`)

    // 5. Check for odd suffixes — anything that's not @c.us / @g.us / @lid
    // Note: Postgres uses STRPOS, not INSTR (SQLite). POSITION() works too.
    const distinctSuffixes = await prisma.$queryRawUnsafe(`
        SELECT DISTINCT
            SUBSTRING(id FROM STRPOS(id, '@')) AS suffix,
            COUNT(*) AS cnt
        FROM "WhatsAppChat"
        WHERE STRPOS(id, '@') > 0
        GROUP BY suffix
        ORDER BY cnt DESC
    `)
    console.log(`[AUDIT] Distinct JID suffixes in WhatsAppChat:`)
    console.log(distinctSuffixes)
}

main()
    .catch(err => {
        console.error('[AUDIT] FAILED:', err)
        process.exitCode = 1
    })
    .finally(() => prisma.$disconnect())
