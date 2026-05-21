/**
 * Merge duplicate WhatsApp chats per contact.
 *
 * Why this exists: WhatsApp issues a LID alias (e.g. 61603068305553@lid)
 * separately from the user's actual phone number JID (e.g. 73068305553).
 * Our sync/live ingestion paths can land on different formats, so the
 * same contact ends up with two Chat rows — one LID-keyed, one phone-keyed.
 * The UI then routes clicks via channelMap.whatsapp to one of them, while
 * the messages live in the other. AmoCRM shows ONE thread, we want the same.
 *
 * Strategy:
 *   For each Contact with >1 active WA chat:
 *     1. Pick the survivor = chat with the most recent lastMessageAt
 *        (preferring "phone-format" externalChatId over @lid as a tiebreaker).
 *     2. Move ALL messages from the loser chats into the survivor.
 *        Drop duplicates (same externalId) to keep idempotency.
 *     3. Re-point ContactIdentity records and ChatEventLog rows to the
 *        survivor's id where applicable.
 *     4. Delete the loser chats.
 *     5. Refresh survivor's lastMessageAt / lastInboundAt / lastOutboundAt.
 *
 * Safe to re-run. Skips contacts that already have ≤1 WA chat.
 */
const { loadEnvConfig } = require('@next/env')
loadEnvConfig(process.cwd())
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

function isPhoneFormat(externalChatId) {
    if (!externalChatId) return false
    return externalChatId.startsWith('whatsapp:') || externalChatId.endsWith('@c.us')
}

async function mergeForContact(contactId, contactName) {
    const chats = await prisma.chat.findMany({
        where: { contactId, channel: 'whatsapp' },
        select: { id: true, externalChatId: true, name: true, lastMessageAt: true, _count: { select: { messages: true } } },
    })
    if (chats.length < 2) return { skipped: true }

    // Pick survivor: prefer phone-format, then newest lastMessageAt.
    chats.sort((a, b) => {
        const aPhone = isPhoneFormat(a.externalChatId) ? 1 : 0
        const bPhone = isPhoneFormat(b.externalChatId) ? 1 : 0
        if (aPhone !== bPhone) return bPhone - aPhone
        const ta = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0
        const tb = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0
        return tb - ta
    })
    const [survivor, ...losers] = chats

    console.log(`\n[${contactName ?? contactId}] ${chats.length} WA chats`)
    console.log(`  survivor: ${survivor.id} ext="${survivor.externalChatId}" msgs=${survivor._count.messages}`)

    let movedMessages = 0
    let droppedDuplicates = 0
    for (const loser of losers) {
        console.log(`  loser:    ${loser.id} ext="${loser.externalChatId}" msgs=${loser._count.messages}`)

        // Move messages, skipping duplicates by externalId
        const loserMsgs = await prisma.message.findMany({
            where: { chatId: loser.id },
            select: { id: true, externalId: true },
        })
        for (const m of loserMsgs) {
            if (m.externalId) {
                const existing = await prisma.message.findFirst({
                    where: { chatId: survivor.id, externalId: m.externalId },
                    select: { id: true },
                })
                if (existing) {
                    await prisma.message.delete({ where: { id: m.id } })
                    droppedDuplicates++
                    continue
                }
            }
            await prisma.message.update({
                where: { id: m.id },
                data: { chatId: survivor.id },
            })
            movedMessages++
        }

        // Re-point ChatEventLog (only field with NOT NULL chatId, others are
        // nullable FKs and will be set to null by Prisma onDelete: SetNull
        // if any exist).
        try {
            await prisma.chatEventLog.updateMany({
                where: { chatId: loser.id },
                data: { chatId: survivor.id },
            })
        } catch {}

        // Re-point ContactIdentity if it was attached to this Chat via its identity.
        // ContactIdentity is referenced by Chat via contactIdentityId (chat→identity),
        // so updating the Chat would be wrong direction. Instead: detach the
        // identity from the chat being deleted via setting Chat.contactIdentityId
        // on the loser to null (it's about to be deleted anyway).
        try {
            await prisma.chat.update({ where: { id: loser.id }, data: { contactIdentityId: null } })
        } catch {}

        // Delete the loser chat
        try {
            await prisma.chat.delete({ where: { id: loser.id } })
        } catch (e) {
            console.error(`    failed to delete ${loser.id}:`, e.message)
        }
    }

    // Refresh survivor's lastMessageAt / lastInboundAt / lastOutboundAt
    const latestIn = await prisma.message.findFirst({
        where: { chatId: survivor.id, direction: 'inbound' },
        orderBy: { sentAt: 'desc' },
        select: { sentAt: true },
    })
    const latestOut = await prisma.message.findFirst({
        where: { chatId: survivor.id, direction: 'outbound' },
        orderBy: { sentAt: 'desc' },
        select: { sentAt: true },
    })
    const latest = await prisma.message.findFirst({
        where: { chatId: survivor.id },
        orderBy: { sentAt: 'desc' },
        select: { sentAt: true },
    })
    await prisma.chat.update({
        where: { id: survivor.id },
        data: {
            lastMessageAt: latest?.sentAt ?? survivor.lastMessageAt,
            lastInboundAt: latestIn?.sentAt ?? null,
            lastOutboundAt: latestOut?.sentAt ?? null,
        },
    })

    return { skipped: false, movedMessages, droppedDuplicates, losersDeleted: losers.length }
}

async function main() {
    // Contacts with >1 WA chat
    const dups = await prisma.$queryRaw`
        SELECT "contactId", COUNT(*)::int AS cnt
        FROM "Chat"
        WHERE channel = 'whatsapp' AND "contactId" IS NOT NULL
        GROUP BY "contactId"
        HAVING COUNT(*) > 1
        ORDER BY cnt DESC
    `
    console.log(`Contacts with >1 WhatsApp chat: ${dups.length}\n`)

    let totalMerged = 0
    let totalMessages = 0
    let totalDuplicates = 0
    for (const d of dups) {
        const contact = await prisma.contact.findUnique({
            where: { id: d.contactId },
            select: { displayName: true },
        })
        const r = await mergeForContact(d.contactId, contact?.displayName)
        if (!r.skipped) {
            totalMerged += r.losersDeleted
            totalMessages += r.movedMessages
            totalDuplicates += r.droppedDuplicates
        }
    }

    console.log(`\n=== Summary ===`)
    console.log(`Contacts processed: ${dups.length}`)
    console.log(`Loser chats deleted: ${totalMerged}`)
    console.log(`Messages moved: ${totalMessages}`)
    console.log(`Duplicate messages dropped: ${totalDuplicates}`)

    await prisma.$disconnect()
}
main().catch(e => { console.error(e); process.exit(1) })
