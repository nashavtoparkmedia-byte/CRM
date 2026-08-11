/**
 * Backfill TG/MAX placeholder chat.name из linked Driver.fullName или Contact.displayName.
 *
 * Логика:
 *   1. Найти Chat (channel='telegram' OR 'max') с placeholder name.
 *   2. Если есть Driver — взять Driver.fullName (приоритет 1).
 *   3. Иначе — Contact.displayName (приоритет 2).
 *   4. Обновить Chat.name. Если Contact.displayName тоже placeholder — обновить и его.
 *
 * Запуск: node scripts/backfill_from_linked.js [--dry-run]
 */
/* eslint-disable @typescript-eslint/no-require-imports */
const { PrismaClient } = require('@prisma/client')
const { restoreChatDisplayNameV1 } = require('../src/modules/messaging/public/v1/legacy-prisma-chat-name-maintenance-adapter')
const { restoreContactDisplayNameV1 } = require('../src/modules/contacts/public/v1/legacy-prisma-contact-name-maintenance-adapter')
const prisma = new PrismaClient()
const DRY_RUN = process.argv.includes('--dry-run')

function isPlaceholder(name) {
    if (!name) return true
    const t = String(name).trim()
    if (!t) return true
    if (/^(TG|MAX|WA|Telegram|Max|WhatsApp)\s+\d+$/i.test(t)) return true
    if (/^\d+$/.test(t)) return true
    if (/^[.\s\-]+$/.test(t)) return true
    return false
}

async function main() {
    console.log(`[backfill-linked] ${DRY_RUN ? 'DRY RUN' : 'LIVE'} mode`)

    const chats = await prisma.chat.findMany({
        where: { channel: { in: ['telegram', 'max'] } },
        select: {
            id: true, name: true, channel: true, externalChatId: true,
            driverId: true, contactId: true,
            driver: { select: { fullName: true } },
            contact: { select: { id: true, displayName: true } },
        },
    })

    const candidates = chats.filter(c => isPlaceholder(c.name))
    console.log(`[backfill-linked] ${candidates.length} placeholder chats (of ${chats.length} TG+MAX total)`)

    let fromDriver = 0, fromContact = 0, noSource = 0
    for (const chat of candidates) {
        let newName = null
        let src = null

        if (chat.driver && chat.driver.fullName && !isPlaceholder(chat.driver.fullName)) {
            newName = chat.driver.fullName.trim()
            src = 'driver'
        } else if (chat.contact && chat.contact.displayName && !isPlaceholder(chat.contact.displayName)) {
            newName = chat.contact.displayName.trim()
            src = 'contact'
        }

        if (!newName) {
            noSource++
            continue
        }

        console.log(`  [${chat.channel}] ${chat.externalChatId}: «${chat.name}» → «${newName}» (src=${src})`)
        if (src === 'driver') fromDriver++
        else fromContact++

        if (!DRY_RUN) {
            await restoreChatDisplayNameV1(chat.externalChatId, newName)
            // Если contact.displayName placeholder, а у нас имя из Driver — обновим
            if (chat.contactId && chat.contact && isPlaceholder(chat.contact.displayName)) {
                await restoreContactDisplayNameV1(chat.contactId, newName)
            }
        }
    }

    await prisma.$disconnect()
    console.log(`\n[backfill-linked] done. fromDriver=${fromDriver} fromContact=${fromContact} noSource=${noSource}`)
}

main().catch(e => { console.error('[backfill-linked] fatal:', e); process.exit(1) })
