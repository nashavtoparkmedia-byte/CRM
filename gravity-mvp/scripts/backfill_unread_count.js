/**
 * Backfill unreadCount для чатов где последнее сообщение входящее,
 * но unreadCount = 0 (WA scraper и старые TG не вызывали onInboundMessage).
 *
 * Для каждого чата считаем входящие сообщения после последнего исходящего.
 * Если исходящих не было — все входящие считаются непрочитанными.
 */
/* eslint-disable @typescript-eslint/no-require-imports */

const { backfillUnreadCountV1 } = require('../src/modules/messaging/public/v1/legacy-prisma-chat-backfill-adapter')

async function main() {
    console.log('[BACKFILL-UNREAD] Starting unreadCount backfill...')

    const result = await backfillUnreadCountV1()

    console.log(`[BACKFILL-UNREAD] Updated ${result} chats`)
    console.log('[BACKFILL-UNREAD] Done.')
}

main()
    .catch(e => {
        console.error('[BACKFILL-UNREAD] Error:', e.message)
        process.exit(1)
    })
