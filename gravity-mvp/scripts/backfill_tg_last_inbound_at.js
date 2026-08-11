/**
 * Одноразовый бэкфилл: заполняет lastInboundAt для TG/WA/MAX чатов
 * на основе самого позднего входящего сообщения в каждом чате.
 *
 * Запускать: node scripts/backfill_tg_last_inbound_at.js
 */
/* eslint-disable @typescript-eslint/no-require-imports */

const { backfillLastInboundAtV1 } = require('../src/modules/messaging/public/v1/legacy-prisma-chat-backfill-adapter')

async function main() {
    console.log('[BACKFILL] Starting lastInboundAt backfill...')

    const result = await backfillLastInboundAtV1()

    console.log(`[BACKFILL] Updated ${result} chats with lastInboundAt`)
    console.log('[BACKFILL] Done.')
}

main().catch(e => {
    console.error('[BACKFILL] Error:', e.message)
    process.exit(1)
})
