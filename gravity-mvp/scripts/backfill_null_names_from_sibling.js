/**
 * PR-И: WA dedup-backfill — копирует chat.name из sibling-чатов того же Contact.
 *
 * Контекст: WhatsApp Business может породить НЕСКОЛЬКО Chat-записей
 * для одного контакта через разные @lid идентификаторы. У одних
 * chat.name = "+7 982 707-22-57" (из pushname), у других chat.name=NULL.
 *
 * Этот script:
 *   1. Находит WA-чаты где chat.name IS NULL
 *   2. Для каждого ищет sibling — другой Chat того же contactId/driverId
 *      где chat.name НЕ NULL и не placeholder
 *   3. Копирует name. Также копирует driverId если он null.
 *
 * Запуск: node scripts/backfill_null_names_from_sibling.js [--dry-run]
 */
const { PrismaClient } = require('@prisma/client')
const { backfillSiblingChatV1 } = require('../src/modules/messaging/public/v1/legacy-prisma-chat-name-maintenance-adapter')
const prisma = new PrismaClient()
const DRY_RUN = process.argv.includes('--dry-run')

function isUseful(name) {
    if (!name) return false
    const t = String(name).trim()
    if (!t) return false
    if (/^[.\s\-]+$/.test(t)) return false
    if (/^(TG|MAX|WA|Telegram|Max|WhatsApp)\s+\d+$/i.test(t)) return false
    // голые цифры без + и пробелов — internal ID, не телефон
    if (/^\d+$/.test(t) && t.length < 10) return false
    return true
}

async function main() {
    console.log(`[backfill-sibling] ${DRY_RUN ? 'DRY RUN' : 'LIVE'} mode`)

    // 1. WA chats with null name
    const nullChats = await prisma.chat.findMany({
        where: { channel: 'whatsapp', name: null },
        select: { id: true, externalChatId: true, contactId: true, driverId: true, name: true },
    })
    console.log(`[backfill-sibling] found ${nullChats.length} WA chats with name=NULL`)

    let updated = 0, noSibling = 0
    for (const chat of nullChats) {
        if (!chat.contactId && !chat.driverId) {
            // не на что опереться
            noSibling++
            continue
        }

        // 2. Ищем sibling
        const siblingWhere = []
        if (chat.contactId) siblingWhere.push({ contactId: chat.contactId })
        if (chat.driverId) siblingWhere.push({ driverId: chat.driverId })

        const siblings = await prisma.chat.findMany({
            where: {
                AND: [
                    { id: { not: chat.id } },
                    { channel: 'whatsapp' },
                    { name: { not: null } },
                    { OR: siblingWhere },
                ],
            },
            select: { id: true, name: true, driverId: true },
            orderBy: { lastMessageAt: 'desc' },
            take: 5,
        })

        const goodSibling = siblings.find(s => isUseful(s.name))
        if (!goodSibling) {
            noSibling++
            continue
        }

        const updates = { name: goodSibling.name }
        if (!chat.driverId && goodSibling.driverId) {
            updates.driverId = goodSibling.driverId
        }

        console.log(`  ${chat.externalChatId}: null → «${goodSibling.name}» (donor: ${goodSibling.id}${updates.driverId ? ', +driverId' : ''})`)

        if (!DRY_RUN) {
            await backfillSiblingChatV1(chat.id, updates)
        }
        updated++
    }

    await prisma.$disconnect()
    console.log(`\n[backfill-sibling] done. updated=${updated} noSibling=${noSibling}`)
}

main().catch(e => { console.error('[backfill-sibling] fatal:', e); process.exit(1) })
