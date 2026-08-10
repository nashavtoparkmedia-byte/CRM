/**
 * PR-К: TG backfill через Bot API getChat (вместо MTProto который блокирован).
 *
 * Telegram Bot API (api.telegram.org) доступен из любой сети, в отличие
 * от MTProto (149.154.x.x). И Bot может вызвать getChat для любого
 * пользователя, с которым он уже общался (наш bot шлёт notifications).
 *
 * Логика:
 *   1. Найти TG chat где name placeholder ("TG NNN", numeric, ". .")
 *      или name=NULL.
 *   2. extract telegramId из externalChatId.
 *   3. GET https://api.telegram.org/bot{TOKEN}/getChat?chat_id={id}
 *   4. Имя = first_name + last_name; если оба пустые — "@username".
 *   5. Update chat.name, contact.displayName (если был placeholder).
 *
 * Token читается из ../tg-bot/.env (BOT_TOKEN). 30 req/s rate limit.
 *
 * Запуск: node scripts/backfill_tg_via_bot_api.js [--dry-run]
 */
const { PrismaClient } = require('@prisma/client')
const fs = require('fs')
const path = require('path')
const { ProxyAgent, fetch: undiciFetch } = require('undici')

const prisma = new PrismaClient()
const DRY_RUN = process.argv.includes('--dry-run')
const RATE_LIMIT_MS = 50  // ~20 req/s, ниже официального лимита

// Node fetch не подхватывает HTTPS_PROXY env — нужен explicit dispatcher
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY
const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined
if (proxyUrl) console.log(`[backfill-tg-bot] using proxy: ${proxyUrl}`)

function readBotToken() {
    const envPath = path.resolve(__dirname, '../../tg-bot/.env')
    if (!fs.existsSync(envPath)) throw new Error(`Не найден ${envPath}`)
    const content = fs.readFileSync(envPath, 'utf-8')
    const m = content.match(/^BOT_TOKEN=([^\r\n]+)/m)
    if (!m) throw new Error('BOT_TOKEN не найден в .env')
    return m[1].trim()
}

function isPlaceholder(name) {
    if (!name) return true
    const t = String(name).trim()
    if (!t) return true
    if (/^(TG|MAX|WA|Telegram|Max|WhatsApp)\s+\d+$/i.test(t)) return true
    if (/^\d+$/.test(t)) return true
    if (/^[.\s\-]+$/.test(t)) return true
    return false
}

function buildDisplayName(user) {
    const fn = (user.first_name ?? '').trim()
    const ln = (user.last_name  ?? '').trim()
    const full = [fn, ln].filter(Boolean).join(' ').trim()
    if (full) return full
    if (user.username) return `@${user.username}`
    return null
}

async function getChatViaBotApi(token, chatId) {
    const url = `https://api.telegram.org/bot${token}/getChat?chat_id=${chatId}`
    const r = await undiciFetch(url, dispatcher ? { dispatcher } : {})
    const json = await r.json()
    if (!json.ok) return { error: json.description || 'unknown' }
    return { user: json.result }
}

async function main() {
    console.log(`[backfill-tg-bot] ${DRY_RUN ? 'DRY RUN' : 'LIVE'} mode`)
    const token = readBotToken()
    console.log('[backfill-tg-bot] bot token loaded')

    // TG chats with placeholder
    const chats = await prisma.chat.findMany({
        where: { channel: 'telegram' },
        select: { id: true, name: true, externalChatId: true, contactId: true },
    })
    const candidates = chats.filter(c => {
        if (!c.externalChatId?.startsWith('telegram:')) return false
        if (c.externalChatId.startsWith('telegram:group:')) return false
        return isPlaceholder(c.name)
    })
    console.log(`[backfill-tg-bot] ${candidates.length} placeholder TG chats (of ${chats.length} total)`)

    let updated = 0, skipped = 0, failed = 0
    for (let i = 0; i < candidates.length; i++) {
        const chat = candidates[i]
        const idStr = chat.externalChatId.replace('telegram:', '')
        if (!/^\d+$/.test(idStr)) {
            console.warn(`  [${i+1}/${candidates.length}] skip — non-numeric id «${idStr}»`)
            skipped++
            continue
        }

        const resp = await getChatViaBotApi(token, idStr)
        if (resp.error) {
            console.warn(`  [${i+1}/${candidates.length}] ${idStr}: API error «${resp.error}»`)
            failed++
            await new Promise(r => setTimeout(r, RATE_LIMIT_MS))
            continue
        }

        const newName = buildDisplayName(resp.user)
        if (!newName) {
            console.log(`  [${i+1}/${candidates.length}] ${idStr}: no first_name/last_name/username, skip`)
            skipped++
            await new Promise(r => setTimeout(r, RATE_LIMIT_MS))
            continue
        }

        const username = resp.user.username ? `@${resp.user.username}` : null
        console.log(`  [${i+1}/${candidates.length}] ${idStr}: «${chat.name}» → «${newName}»${username ? ` (${username})` : ''}`)

        if (!DRY_RUN) {
            await prisma.chat.update({
                where: { id: chat.id },
                data: { name: newName },
            })
            if (chat.contactId) {
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
        await new Promise(r => setTimeout(r, RATE_LIMIT_MS))
    }

    await prisma.$disconnect()
    console.log(`\n[backfill-tg-bot] done. updated=${updated} skipped=${skipped} failed=${failed}`)
}

main().catch(e => { console.error('[backfill-tg-bot] fatal:', e); process.exit(1) })
