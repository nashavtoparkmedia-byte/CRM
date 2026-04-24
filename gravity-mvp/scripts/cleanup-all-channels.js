/**
 * Channel-agnostic junk cleanup. Removes the same class of mess the
 * WA cleanup script handles — now across whatsapp / telegram / max /
 * yandex_pro / phone. Safe to re-run.
 *
 * Removes:
 *   1. Messages with type='text' and empty content (protocol noise)
 *   2. Chats with zero surviving messages (UI ghosts)
 *   3. Fixes backfilled outbound (externalId != null) with status in
 *      {failed,sent,queued} → status='delivered' (symptom: "Повторить"
 *      button on old sent messages).
 *   4. Messages with sentAt outside [2015-01-01 .. now+1h] — clamped
 *      to createdAt if that's sane, otherwise now().
 */
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

const CHANNELS = ['whatsapp', 'telegram', 'max', 'yandex_pro', 'phone']
const MIN_TS = new Date('2015-01-01T00:00:00Z')
const MAX_ALLOWED = () => new Date(Date.now() + 60 * 60 * 1000)

async function cleanChannel(channel) {
    console.log(`\n── ${channel} ──`)

    // 1. Empty text messages
    const emptyText = await prisma.message.findMany({
        where: { channel, type: 'text' },
        select: { id: true, content: true },
    })
    const emptyTextIds = emptyText.filter(m => !(m.content || '').trim()).map(m => m.id)
    if (emptyTextIds.length > 0) {
        const r = await prisma.message.deleteMany({ where: { id: { in: emptyTextIds } } })
        console.log(`  Deleted ${r.count} empty-text messages`)
    }

    // 2. Bad timestamps — clamp to createdAt if sane, else now()
    const now = new Date()
    const maxAllowed = MAX_ALLOWED()
    const badTs = await prisma.message.findMany({
        where: {
            channel,
            OR: [{ sentAt: { lt: MIN_TS } }, { sentAt: { gt: maxAllowed } }],
        },
        select: { id: true, sentAt: true, createdAt: true },
    })
    for (const m of badTs) {
        const replacement = m.createdAt && m.createdAt < maxAllowed && m.createdAt > MIN_TS
            ? m.createdAt
            : now
        await prisma.message.update({ where: { id: m.id }, data: { sentAt: replacement } })
    }
    if (badTs.length > 0) console.log(`  Fixed ${badTs.length} bad-timestamp messages`)

    // 3. Stuck outbound (backfilled, externalId set, still marked non-delivered)
    const stuckFix = await prisma.message.updateMany({
        where: {
            channel,
            direction: 'outbound',
            externalId: { not: null },
            status: { in: ['failed', 'sent', 'queued'] },
        },
        data: { status: 'delivered' },
    })
    if (stuckFix.count > 0) console.log(`  Marked ${stuckFix.count} backfilled outbound as delivered`)

    // 4. Empty chats (no messages)
    const all = await prisma.chat.findMany({
        where: { channel },
        select: { id: true, _count: { select: { messages: true } } },
    })
    const emptyChatIds = all.filter(c => c._count.messages === 0).map(c => c.id)
    if (emptyChatIds.length > 0) {
        const r = await prisma.chat.deleteMany({ where: { id: { in: emptyChatIds } } })
        console.log(`  Deleted ${r.count} empty chats`)
    }
}

async function main() {
    for (const ch of CHANNELS) {
        await cleanChannel(ch)
    }

    console.log('\n── Final totals ──')
    for (const ch of CHANNELS) {
        const [c, m] = await Promise.all([
            prisma.chat.count({ where: { channel: ch } }),
            prisma.message.count({ where: { channel: ch } }),
        ])
        if (c + m > 0) console.log(`  ${ch}: ${c} chats, ${m} messages`)
    }
}

main().catch(console.error).finally(() => prisma.$disconnect())
