/**
 * Full-channel junk audit: for every supported channel (whatsapp,
 * telegram, max, yandex_pro, phone) report the same hygiene metrics
 * so we can see if the non-WA channels have the same data-quality
 * issues we fixed in WA.
 */
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

const CHANNELS = ['whatsapp', 'telegram', 'max', 'yandex_pro', 'phone']
const MIN_TS = new Date('2015-01-01T00:00:00Z')
const MAX_ALLOWED = new Date(Date.now() + 60 * 60 * 1000)

async function auditChannel(channel) {
    const chatCount = await prisma.chat.count({ where: { channel } })
    if (chatCount === 0) return null

    const msgCount = await prisma.message.count({ where: { channel } })

    const emptyChats = await prisma.chat.findMany({
        where: { channel },
        select: { id: true, _count: { select: { messages: true } } },
    })
    const emptyChatCount = emptyChats.filter(c => c._count.messages === 0).length

    const emptyText = await prisma.message.findMany({
        where: { channel, type: 'text' },
        select: { id: true, content: true },
    })
    const emptyTextCount = emptyText.filter(m => !(m.content || '').trim()).length

    const badTs = await prisma.message.count({
        where: { channel, OR: [{ sentAt: { lt: MIN_TS } }, { sentAt: { gt: MAX_ALLOWED } }] },
    })

    const stuckOutbound = await prisma.message.count({
        where: {
            channel,
            direction: 'outbound',
            externalId: { not: null },
            status: { in: ['failed', 'sent', 'queued'] },
        },
    })

    const dateRange = await prisma.message.aggregate({
        where: { channel },
        _min: { sentAt: true },
        _max: { sentAt: true },
    })

    return {
        channel,
        chats: chatCount,
        messages: msgCount,
        emptyChats: emptyChatCount,
        emptyTextMessages: emptyTextCount,
        badTimestampMessages: badTs,
        stuckOutboundBackfill: stuckOutbound,
        oldestSentAt: dateRange._min.sentAt?.toISOString() ?? null,
        newestSentAt: dateRange._max.sentAt?.toISOString() ?? null,
    }
}

async function main() {
    console.log(`[AUDIT] Current time: ${new Date().toISOString()}`)
    console.log(`[AUDIT] Valid window: ${MIN_TS.toISOString()} .. ${MAX_ALLOWED.toISOString()}`)
    console.log()

    for (const ch of CHANNELS) {
        const result = await auditChannel(ch)
        if (!result) {
            console.log(`--- ${ch}: no chats`)
            continue
        }
        console.log(`--- ${ch} ---`)
        for (const [k, v] of Object.entries(result)) {
            if (k === 'channel') continue
            const flag = (k === 'emptyChats' || k === 'emptyTextMessages' || k === 'badTimestampMessages' || k === 'stuckOutboundBackfill') && typeof v === 'number' && v > 0
                ? ' ⚠️'
                : ''
            console.log(`  ${k}: ${v}${flag}`)
        }
        console.log()
    }
}

main().catch(console.error).finally(() => prisma.$disconnect())
