/**
 * One-off cleanup: clamp any existing WA messages whose stored timestamp
 * is outside [2015-01-01 .. now()+1h].  For each bad row, sentAt/timestamp
 * is reset to createdAt if available, otherwise to now().
 *
 * Safe to re-run.
 */
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

const MIN = new Date('2015-01-01T00:00:00Z')

async function main() {
    const now = new Date()
    const maxAllowed = new Date(now.getTime() + 60 * 60 * 1000)
    console.log(`[CLAMP] Valid range: ${MIN.toISOString()}  ..  ${maxAllowed.toISOString()}`)

    // ── Unified Message (channel=whatsapp) ───────────────────────────
    const badUnified = await prisma.message.findMany({
        where: {
            channel: 'whatsapp',
            OR: [{ sentAt: { lt: MIN } }, { sentAt: { gt: maxAllowed } }],
        },
        select: { id: true, sentAt: true, createdAt: true },
    })
    console.log(`[CLAMP] Unified Message rows with bad sentAt: ${badUnified.length}`)
    for (const m of badUnified) {
        const replacement = m.createdAt && m.createdAt < maxAllowed && m.createdAt > MIN
            ? m.createdAt
            : now
        await prisma.message.update({
            where: { id: m.id },
            data: { sentAt: replacement },
        })
        console.log(`   [M] id=${m.id.slice(0, 8)}… sentAt ${m.sentAt?.toISOString()} → ${replacement.toISOString()}`)
    }

    // ── Legacy WhatsAppMessage ───────────────────────────────────────
    const badLegacy = await prisma.whatsAppMessage.findMany({
        where: {
            OR: [{ timestamp: { lt: MIN } }, { timestamp: { gt: maxAllowed } }],
        },
        select: { id: true, chatId: true, timestamp: true },
    })
    console.log(`[CLAMP] Legacy WhatsAppMessage rows with bad timestamp: ${badLegacy.length}`)
    for (const m of badLegacy) {
        await prisma.whatsAppMessage.update({
            where: { id_chatId: { id: m.id, chatId: m.chatId } },
            data: { timestamp: now },
        })
        console.log(`   [WM] id=${m.id.slice(0, 8)}… chat=${m.chatId}  ${m.timestamp?.toISOString()} → ${now.toISOString()}`)
    }

    // ── Summary ──────────────────────────────────────────────────────
    const afterUnified = await prisma.message.count({
        where: { channel: 'whatsapp', OR: [{ sentAt: { lt: MIN } }, { sentAt: { gt: maxAllowed } }] },
    })
    const afterLegacy = await prisma.whatsAppMessage.count({
        where: { OR: [{ timestamp: { lt: MIN } }, { timestamp: { gt: maxAllowed } }] },
    })
    console.log(`\n[CLAMP] Remaining after cleanup: unified=${afterUnified}, legacy=${afterLegacy} (expected 0/0)`)
}

main().catch(err => { console.error(err); process.exitCode = 1 }).finally(() => prisma.$disconnect())
