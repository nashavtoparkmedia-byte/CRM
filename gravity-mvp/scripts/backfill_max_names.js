/**
 * PR-Г: Backfill имён для MAX чатов.
 *
 * Источник: либо последнее сообщение с senderName в metadata, либо
 * externalChatId (как fallback phone). MAX scraper иногда передаёт
 * имя в Message.metadata.senderName при ингесте.
 *
 * Логика:
 *   1. Найти MAX chats где name placeholder (". .", "TG NN", numeric).
 *   2. Look at last 10 inbound messages — извлечь senderName из metadata.
 *   3. Если есть осмысленное имя — обновить chat.name.
 *   4. Иначе попытаться извлечь phone из externalChatId.
 *
 * Запуск: node scripts/backfill_max_names.js [--dry-run]
 */
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()
const DRY_RUN = process.argv.includes('--dry-run')

function isPlaceholder(name) {
    if (!name) return true
    const t = name.trim()
    if (!t) return true
    if (/^(TG|MAX|WA|Telegram|Max|WhatsApp)\s+\d+$/i.test(t)) return true
    if (/^\d+$/.test(t)) return true
    if (/^[.\s\-]+$/.test(t)) return true
    return false
}

function tryExtractPhone(externalChatId) {
    if (!externalChatId) return null
    // "max:79221853150" → +79221853150
    const m = externalChatId.match(/^(?:max:)?(\d{10,15})$/)
    if (m) return `+${m[1]}`
    return null
}

async function main() {
    console.log(`[backfill-max] ${DRY_RUN ? 'DRY RUN — no DB changes' : 'LIVE'} mode`)

    const chats = await prisma.chat.findMany({
        where: { channel: 'max' },
        select: { id: true, name: true, externalChatId: true, contactId: true },
    })
    console.log(`[backfill-max] scanning ${chats.length} MAX chats…`)

    let updated = 0, skipped = 0, noName = 0
    for (const chat of chats) {
        if (!isPlaceholder(chat.name)) {
            skipped++
            continue
        }
        // 1. Попытка из senderName в Message metadata
        const messages = await prisma.message.findMany({
            where: { chatId: chat.id, direction: 'inbound' },
            orderBy: { sentAt: 'desc' },
            take: 10,
            select: { metadata: true },
        })
        let bestName = null
        for (const m of messages) {
            const sn = m.metadata?.senderName ?? m.metadata?.driverName ?? null
            if (sn && !isPlaceholder(sn)) {
                bestName = sn
                break
            }
        }
        // 2. Fallback на phone из externalChatId
        if (!bestName) {
            bestName = tryExtractPhone(chat.externalChatId)
        }
        if (!bestName) {
            noName++
            continue
        }
        console.log(`  ${chat.externalChatId} → name «${chat.name}» → «${bestName}»`)
        if (!DRY_RUN) {
            await prisma.chat.update({
                where: { id: chat.id },
                data: { name: bestName },
            })
            if (chat.contactId) {
                const contact = await prisma.contact.findUnique({
                    where: { id: chat.contactId },
                    select: { id: true, displayName: true },
                })
                if (contact && isPlaceholder(contact.displayName)) {
                    await prisma.contact.update({
                        where: { id: contact.id },
                        data: { displayName: bestName },
                    })
                }
            }
        }
        updated++
    }

    await prisma.$disconnect()
    console.log(`\n[backfill-max] done. updated=${updated} skipped(ok)=${skipped} noName=${noName}`)
}

main().catch(e => {
    console.error('[backfill-max] fatal:', e)
    process.exit(1)
})
