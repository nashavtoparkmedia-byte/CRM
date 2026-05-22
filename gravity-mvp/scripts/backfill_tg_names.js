/**
 * PR-Б: Backfill реальных имён для existing TG-чатов через MTProto.
 *
 * Logic:
 *   1. Достать первый active TelegramConnection.sessionString из БД.
 *   2. Подключиться через gramjs (telegram package).
 *   3. Найти все Chat где channel='telegram' AND name LIKE 'TG %' OR
 *      name ~ '^\d+$' (placeholder из ingest).
 *   4. Для каждого extract telegramId из externalChatId ("telegram:NNN").
 *   5. client.getEntity(BigInt(id)) → user object с firstName/lastName/username.
 *   6. Update Chat.name + Contact.displayName (если != placeholder).
 *
 * Rate limit: 10 req/s — sleep 100ms между запросами.
 * Idempotent: повторный запуск пропускает уже разрешённые чаты.
 *
 * Запуск: node scripts/backfill_tg_names.js [--dry-run]
 */
const { PrismaClient } = require('@prisma/client')
const { TelegramClient, Api } = require('telegram')
const { StringSession } = require('telegram/sessions')

const prisma = new PrismaClient()
const DRY_RUN = process.argv.includes('--dry-run')
const RATE_LIMIT_MS = 100

function isPlaceholder(name) {
    if (!name) return true
    if (/^TG\s+\d+$/i.test(name.trim())) return true
    if (/^\d+$/.test(name.trim())) return true
    if (/^[.\s\-]+$/.test(name.trim())) return true
    return false
}

function buildDisplayName(user) {
    const fn = (user.firstName ?? '').trim()
    const ln = (user.lastName  ?? '').trim()
    const full = [fn, ln].filter(Boolean).join(' ').trim()
    if (full) return full
    if (user.username) return `@${user.username}`
    return null
}

async function main() {
    console.log(`[backfill-tg] ${DRY_RUN ? 'DRY RUN — no DB changes' : 'LIVE'} mode`)

    // 1. Сессия
    const conn = await prisma.telegramConnection.findFirst({
        where: { isActive: true, sessionString: { not: null } },
        select: { id: true, name: true, sessionString: true, apiId: true, apiHash: true },
    })
    if (!conn || !conn.sessionString) {
        console.error('[backfill-tg] No active TelegramConnection with sessionString. Подключи TG-аккаунт в /settings/integrations/telegram сначала.')
        await prisma.$disconnect()
        process.exit(1)
    }
    console.log(`[backfill-tg] using connection ${conn.id} (${conn.name})`)

    const session = new StringSession(conn.sessionString)
    const client = new TelegramClient(session, conn.apiId, conn.apiHash, {
        connectionRetries: 3,
    })
    await client.connect()
    if (!(await client.isUserAuthorized())) {
        console.error('[backfill-tg] Session not authorized')
        await prisma.$disconnect()
        process.exit(1)
    }
    console.log(`[backfill-tg] connected to Telegram`)

    // 2. Найти TG чаты с placeholder name
    const chats = await prisma.chat.findMany({
        where: { channel: 'telegram' },
        select: { id: true, name: true, externalChatId: true, contactId: true },
    })
    const candidates = chats.filter(c => {
        if (!c.externalChatId?.startsWith('telegram:')) return false
        if (c.externalChatId.startsWith('telegram:group:')) return false  // groups не трогаем
        return isPlaceholder(c.name)
    })
    console.log(`[backfill-tg] found ${candidates.length} chats with placeholder name (of ${chats.length} total TG chats)`)

    let updated = 0, skipped = 0, failed = 0
    for (let i = 0; i < candidates.length; i++) {
        const chat = candidates[i]
        const idStr = chat.externalChatId.replace('telegram:', '')
        const idNum = Number(idStr)
        if (!Number.isFinite(idNum)) {
            console.warn(`  [${i+1}/${candidates.length}] skip ${chat.id}: bad id «${idStr}»`)
            skipped++
            continue
        }

        try {
            const user = await client.getEntity(idNum)
            const newName = buildDisplayName(user)
            if (!newName) {
                console.log(`  [${i+1}/${candidates.length}] ${idStr}: TG user has no name/username, skip`)
                skipped++
            } else {
                console.log(`  [${i+1}/${candidates.length}] ${idStr}: «${chat.name}» → «${newName}»`)
                if (!DRY_RUN) {
                    await prisma.chat.update({
                        where: { id: chat.id },
                        data: { name: newName },
                    })
                    if (chat.contactId) {
                        // Обновим Contact.displayName только если он тоже placeholder
                        const contact = await prisma.contact.findUnique({
                            where: { id: chat.contactId },
                            select: { id: true, displayName: true },
                        })
                        if (contact && isPlaceholder(contact.displayName)) {
                            await prisma.contact.update({
                                where: { id: contact.id },
                                data: { displayName: newName },
                            })
                        }
                    }
                }
                updated++
            }
        } catch (e) {
            console.warn(`  [${i+1}/${candidates.length}] ${idStr}: error ${e.message}`)
            failed++
        }

        // Rate limit
        await new Promise(r => setTimeout(r, RATE_LIMIT_MS))
    }

    await client.disconnect()
    await prisma.$disconnect()

    console.log(`\n[backfill-tg] done. updated=${updated} skipped=${skipped} failed=${failed}`)
}

main().catch(e => {
    console.error('[backfill-tg] fatal:', e)
    process.exit(1)
})
