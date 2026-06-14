/**
 * Backfill unreadCount для чатов где последнее сообщение входящее,
 * но unreadCount = 0 (WA scraper и старые TG не вызывали onInboundMessage).
 *
 * Для каждого чата считаем входящие сообщения после последнего исходящего.
 * Если исходящих не было — все входящие считаются непрочитанными.
 */
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
    console.log('[BACKFILL-UNREAD] Starting unreadCount backfill...')

    const result = await prisma.$executeRaw`
        UPDATE "Chat" c
        SET "unreadCount" = sub."unreadCount"
        FROM (
            SELECT
                m."chatId",
                COUNT(*) AS "unreadCount"
            FROM "Message" m
            WHERE m.direction = 'inbound'
              AND m."sentAt" > COALESCE(
                (SELECT MAX(m2."sentAt") FROM "Message" m2
                 WHERE m2."chatId" = m."chatId" AND m2.direction = 'outbound'),
                '1970-01-01'::timestamptz
              )
            GROUP BY m."chatId"
        ) sub
        WHERE c.id = sub."chatId"
          AND c."unreadCount" = 0
          AND sub."unreadCount" > 0
    `

    console.log(`[BACKFILL-UNREAD] Updated ${result} chats`)
    console.log('[BACKFILL-UNREAD] Done.')
}

main()
    .catch(e => {
        console.error('[BACKFILL-UNREAD] Error:', e.message)
        process.exit(1)
    })
    .finally(() => prisma.$disconnect())
