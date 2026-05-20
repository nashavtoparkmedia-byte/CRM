/* eslint-disable no-console */
/**
 * Debug helper — выводит текущее состояние AiAgentConfig в БД.
 * Для разбора UX-проблем с "ключ не проверен" / "Собрать ядро disabled".
 */
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
    const rows = await prisma.$queryRaw`
        SELECT
            id,
            enabled,
            mode::text AS mode,
            provider::text AS provider,
            CASE WHEN "apiKeyEncrypted" IS NULL OR "apiKeyEncrypted" = ''
                 THEN '(empty)'
                 ELSE '(set, len=' || length("apiKeyEncrypted") || ')'
            END AS "apiKey",
            "classificationModel",
            "responseModel",
            "connectionStatus",
            "lastConnectionCheckAt",
            "updatedAt"
        FROM "AiAgentConfig" WHERE id = 'singleton'
    `
    console.log(JSON.stringify(rows[0] ?? null, null, 2))
}

main().catch(e => { console.error(e.message); process.exit(1) })
    .finally(() => prisma.$disconnect())
