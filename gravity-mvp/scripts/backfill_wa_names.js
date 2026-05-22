/**
 * PR-В: Backfill имён для WhatsApp чатов.
 *
 * Источник — externalChatId. WA pattern:
 *   "whatsapp:79221853150@s.whatsapp.net" — phone виден в первой части
 *   "whatsapp:NNNNNNNNNNNNN@lid"          — Business linked id, phone не извлечь
 *
 * Логика:
 *   1. Найти Chat где channel='whatsapp' AND (name placeholder OR name = externalChatId).
 *   2. Если externalChatId формата "...@s.whatsapp.net" — extract phone, set "+digits".
 *   3. Иначе — оставить как есть (для @lid нужен живой WA-client lookup).
 *   4. Обновить Contact.displayName если он тоже placeholder.
 *
 * Запуск: node scripts/backfill_wa_names.js [--dry-run]
 */
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()
const DRY_RUN = process.argv.includes('--dry-run')

function isPlaceholder(name) {
    if (!name) return true
    const t = name.trim()
    if (!t) return true
    if (/^WA\s+\d+$/i.test(t)) return true
    if (/^\d+$/.test(t)) return true
    if (/^[.\s\-]+$/.test(t)) return true
    if (/^\d+@(s\.whatsapp\.net|lid)$/.test(t)) return true  // raw jid as name
    if (/^whatsapp:/.test(t)) return true
    return false
}

function extractPhoneFromWaExternalId(externalChatId) {
    if (!externalChatId) return null
    // Формат "whatsapp:79221853150@s.whatsapp.net" — берём phone
    const m = externalChatId.match(/(?:whatsapp:)?(\d{10,15})@s\.whatsapp\.net/)
    if (m) return `+${m[1]}`
    return null
}

async function main() {
    console.log(`[backfill-wa] ${DRY_RUN ? 'DRY RUN — no DB changes' : 'LIVE'} mode`)

    const chats = await prisma.chat.findMany({
        where: { channel: 'whatsapp' },
        select: { id: true, name: true, externalChatId: true, contactId: true },
    })
    console.log(`[backfill-wa] scanning ${chats.length} WA chats…`)

    let updated = 0, skipped = 0, noPhone = 0
    for (const chat of chats) {
        const needsUpdate = isPlaceholder(chat.name)
        if (!needsUpdate) {
            skipped++
            continue
        }
        const phone = extractPhoneFromWaExternalId(chat.externalChatId)
        if (!phone) {
            // @lid формат — не извлечь без WA API
            noPhone++
            continue
        }
        console.log(`  ${chat.externalChatId} → name «${chat.name}» → «${phone}»`)
        if (!DRY_RUN) {
            await prisma.chat.update({
                where: { id: chat.id },
                data: { name: phone },
            })
            if (chat.contactId) {
                const contact = await prisma.contact.findUnique({
                    where: { id: chat.contactId },
                    select: { id: true, displayName: true },
                })
                if (contact && isPlaceholder(contact.displayName)) {
                    await prisma.contact.update({
                        where: { id: contact.id },
                        data: { displayName: phone },
                    })
                }
            }
        }
        updated++
    }

    await prisma.$disconnect()
    console.log(`\n[backfill-wa] done. updated=${updated} skipped(ok)=${skipped} noPhone(@lid)=${noPhone}`)
    if (noPhone > 0) {
        console.log(`\n[backfill-wa] note: ${noPhone} WA chats use @lid format (Business linked).`)
        console.log(`  Their phone requires live WA-client lookup — not implemented in this script.`)
        console.log(`  Manual: посмотри chat.name из chatRaw.name в WhatsAppService — там обычно номер уже сохранён.`)
    }
}

main().catch(e => {
    console.error('[backfill-wa] fatal:', e)
    process.exit(1)
})
