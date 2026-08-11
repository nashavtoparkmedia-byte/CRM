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
/* eslint-disable @typescript-eslint/no-require-imports */
const { PrismaClient } = require('@prisma/client')
const { restoreChatDisplayNameV1 } = require('../src/modules/messaging/public/v1/legacy-prisma-chat-name-maintenance-adapter')
const { restoreContactDisplayNameV1 } = require('../src/modules/contacts/public/v1/legacy-prisma-contact-name-maintenance-adapter')
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
    // Реальное имя — содержит буквы и не сплошные символы-мусор (".", "$$", "...")
    const hasRealName = /[А-Яа-яA-Za-z]/.test(full) && !/^[.\s\-_$]+$/.test(full)
    if (hasRealName) return full
    if (user.username) return `@${user.username}`
    if (full) return full  // last resort — хоть какой-то
    return null
}

async function main() {
    console.log(`[backfill-tg] ${DRY_RUN ? 'DRY RUN — no DB changes' : 'LIVE'} mode`)

    // 1. Все активные TG сессии — chats могли быть созданы через разные.
    const connections = await prisma.telegramConnection.findMany({
        where: { isActive: true, sessionString: { not: null } },
        select: { id: true, name: true, sessionString: true, apiId: true, apiHash: true },
        orderBy: { isDefault: 'desc' },
    })
    if (connections.length === 0) {
        console.error('[backfill-tg] No active TelegramConnection with sessionString.')
        await prisma.$disconnect()
        process.exit(1)
    }
    console.log(`[backfill-tg] ${connections.length} active connections found`)

    const proxyConfig = process.env.TG_PROXY_PORT
        ? { ip: '127.0.0.1', port: Number(process.env.TG_PROXY_PORT), socksType: 5, timeout: 5 }
        : { ip: '127.0.0.1', port: 10808, socksType: 5, timeout: 5 }
    console.log(`[backfill-tg] using SOCKS5 proxy ${proxyConfig.ip}:${proxyConfig.port}`)

    // 2. TG чаты с placeholder name
    const chats = await prisma.chat.findMany({
        where: { channel: 'telegram' },
        select: { id: true, name: true, externalChatId: true, contactId: true },
    })
    let candidates = chats.filter(c => {
        if (!c.externalChatId?.startsWith('telegram:')) return false
        if (c.externalChatId.startsWith('telegram:group:')) return false
        return isPlaceholder(c.name)
    })
    console.log(`[backfill-tg] ${candidates.length} placeholder TG chats to resolve`)

    let totalUpdated = 0, totalSkipped = 0, totalFailed = 0
    const resolved = new Set()  // chat.id уже разрешённые

    // 3. Идём по каждой сессии и пробуем разрешить
    for (const conn of connections) {
        if (candidates.length === resolved.size) break  // все разрешены
        console.log(`\n[backfill-tg] === session ${conn.id} (${conn.name}) ===`)

        const session = new StringSession(conn.sessionString)
        const client = new TelegramClient(session, conn.apiId, conn.apiHash, {
            connectionRetries: 2,
            proxy: proxyConfig,
        })
        try {
            await client.connect()
            if (!(await client.isUserAuthorized())) {
                console.warn(`  session not authorized, skip`)
                await client.disconnect()
                continue
            }
            console.log(`  connected, loading dialogs...`)
            const dialogs = await client.getDialogs({ limit: 500 })
            console.log(`  loaded ${dialogs.length} dialogs`)

            for (let i = 0; i < candidates.length; i++) {
                const chat = candidates[i]
                if (resolved.has(chat.id)) continue
                const idStr = chat.externalChatId.replace('telegram:', '')
                const idNum = Number(idStr)
                if (!Number.isFinite(idNum)) continue

                try {
                    const user = await client.getEntity(idNum)
                    const newName = buildDisplayName(user)
                    if (!newName) {
                        console.log(`  [${i+1}/${candidates.length}] ${idStr}: no name/username`)
                        resolved.add(chat.id)  // нечего ещё пробовать
                        totalSkipped++
                        continue
                    }
                    const usernameStr = user.username ? ` (@${user.username})` : ''
                    console.log(`  [${i+1}/${candidates.length}] ${idStr}: «${chat.name}» → «${newName}»${usernameStr}`)
                    if (!DRY_RUN) {
                        await restoreChatDisplayNameV1(chat.externalChatId, newName)
                        if (chat.contactId) {
                            const contact = await prisma.contact.findUnique({
                                where: { id: chat.contactId },
                                select: { id: true, displayName: true },
                            })
                            if (contact && isPlaceholder(contact.displayName)) {
                                await restoreContactDisplayNameV1(contact.id, newName)
                            }
                        }
                    }
                    resolved.add(chat.id)
                    totalUpdated++
                } catch (e) {
                    // не в этой сессии — попробуем следующую
                }
                await new Promise(r => setTimeout(r, RATE_LIMIT_MS))
            }
            await client.disconnect()
        } catch (e) {
            console.warn(`  session error: ${e.message}`)
            try { await client.disconnect() } catch {}
        }
    }

    totalFailed = candidates.length - totalUpdated - totalSkipped

    await prisma.$disconnect()
    console.log(`\n[backfill-tg] done. updated=${totalUpdated} skipped=${totalSkipped} failed=${totalFailed}`)
}

main().catch(e => {
    console.error('[backfill-tg] fatal:', e)
    process.exit(1)
})
