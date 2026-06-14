/**
 * Импортирует пропущенные исходящие (и входящие) сообщения из TG
 * для конкретного чата по externalChatId.
 *
 * Запускать после деплоя: node scripts/import_tg_missed_outbound.js
 */
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
    // Найти TG соединение
    const conn = await prisma.messagingConnection.findFirst({
        where: { channel: 'telegram', status: 'active' },
        select: { id: true, credentials: true },
    })
    if (!conn) {
        console.log('[IMPORT] No active TG connection found')
        return
    }
    console.log(`[IMPORT] Using TG connection ${conn.id}`)

    // Загружаем GramJS и переиспользуем логику из tg-actions
    // Запускаем через API endpoint вместо прямого вызова
    const res = await fetch('http://localhost:3002/api/tg-import-history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId: conn.id, limit: 50 }),
    })
    const data = await res.json()
    console.log('[IMPORT] Result:', JSON.stringify(data))
}

main()
    .catch(e => {
        console.error('[IMPORT] Error:', e.message)
        process.exit(1)
    })
    .finally(() => prisma.$disconnect())
