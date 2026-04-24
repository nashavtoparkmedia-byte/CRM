/**
 * Two dedup passes:
 *
 * 1. WA: merge duplicate Chat rows for the same phone.
 *    Some chats were created with externalChatId='<digits>@c.us' (raw
 *    JID from early live-handler builds) and later the same phone got
 *    a second Chat with externalChatId='whatsapp:<digits>' (normalized
 *    format the current code uses). The UI keys the list panel on one
 *    id, opens the other from history, and we end up with an "empty"
 *    conversation while all the messages sit in the sibling row.
 *
 *    Policy: the row with MORE messages wins. All messages, attachments
 *    (via message), and the duplicate chat row are cleaned up. Driver /
 *    contact links are moved to the winner if it's missing them.
 *
 * 2. MessageAttachment: remove exact duplicates (same messageId + same
 *    url). MAX stickers were coming through with two identical attachment
 *    rows — UI rendered two copies of the frog. Anything where two rows
 *    have the same messageId + url keeps the first and drops the rest.
 *
 * Idempotent — safe to re-run.
 */
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function mergeWaChat(loser, winner) {
    // Move Messages
    await prisma.message.updateMany({
        where: { chatId: loser.id },
        data:  { chatId: winner.id },
    })
    // Move missing driver/contact links
    const updateData = {}
    if (!winner.driverId && loser.driverId) updateData.driverId = loser.driverId
    if (!winner.contactId && loser.contactId) updateData.contactId = loser.contactId
    if (!winner.contactIdentityId && loser.contactIdentityId) updateData.contactIdentityId = loser.contactIdentityId
    if (Object.keys(updateData).length > 0) {
        await prisma.chat.update({ where: { id: winner.id }, data: updateData })
    }
    // Delete loser (messages already moved, FKs should be clear)
    await prisma.chat.delete({ where: { id: loser.id } })
}

function phoneKey(externalChatId) {
    if (!externalChatId) return null
    // "79025095972@c.us" → "79025095972"
    // "whatsapp:79025095972" → "79025095972"
    // "79025095972@lid" skipped — LID is opaque, not mergeable by digits
    const m = externalChatId.match(/^(\d{10,15})(@c\.us)?$/) ||
              externalChatId.match(/^whatsapp:(\d{10,15})$/)
    return m ? m[1] : null
}

async function dedupWaChats() {
    const chats = await prisma.chat.findMany({
        where: { channel: 'whatsapp' },
        include: { _count: { select: { messages: true } } },
    })

    // Group by phone digits
    const byPhone = new Map()
    for (const c of chats) {
        const key = phoneKey(c.externalChatId)
        if (!key) continue
        if (!byPhone.has(key)) byPhone.set(key, [])
        byPhone.get(key).push(c)
    }

    let merged = 0
    for (const [phone, group] of byPhone) {
        if (group.length < 2) continue

        // Winner = most messages. Tie → most recent lastMessageAt.
        group.sort((a, b) => {
            if (b._count.messages !== a._count.messages) return b._count.messages - a._count.messages
            const at = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0
            const bt = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0
            return bt - at
        })
        const [winner, ...losers] = group

        // Canonicalize winner's externalChatId to normalized format.
        const normalized = `whatsapp:${phone}`
        if (winner.externalChatId !== normalized) {
            try {
                await prisma.chat.update({
                    where: { id: winner.id },
                    data: { externalChatId: normalized },
                })
                winner.externalChatId = normalized
            } catch {
                // Someone else might already have 'whatsapp:<phone>' —
                // unique constraint. Skip rename, keep as is.
            }
        }

        for (const loser of losers) {
            console.log(`[DEDUP-WA] merge phone=${phone}  loser(${loser._count.messages}msg)=${loser.externalChatId}  →  winner(${winner._count.messages}msg)=${winner.externalChatId}`)
            await mergeWaChat(loser, winner)
            merged++
        }
    }
    console.log(`[DEDUP-WA] merged ${merged} duplicate chats`)
    return merged
}

async function dedupAttachments() {
    // Find (messageId, url) pairs with >1 rows
    const rows = await prisma.messageAttachment.findMany({
        select: { id: true, messageId: true, url: true },
        orderBy: { id: 'asc' },
    })
    const seen = new Set()
    const toDelete = []
    for (const row of rows) {
        if (!row.url) continue
        const key = `${row.messageId}::${row.url}`
        if (seen.has(key)) { toDelete.push(row.id); continue }
        seen.add(key)
    }
    if (toDelete.length > 0) {
        const r = await prisma.messageAttachment.deleteMany({ where: { id: { in: toDelete } } })
        console.log(`[DEDUP-ATT] removed ${r.count} duplicate attachment rows`)
    } else {
        console.log('[DEDUP-ATT] no duplicates')
    }
    return toDelete.length
}

async function main() {
    await dedupWaChats()
    await dedupAttachments()
}

main().catch(console.error).finally(() => prisma.$disconnect())
