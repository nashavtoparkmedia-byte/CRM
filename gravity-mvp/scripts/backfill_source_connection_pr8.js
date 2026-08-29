/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * PR8.B2 — idempotent backfill of AiKnowledgeSource.connectionId
 * for legacy Telegram + MAX sources.
 *
 * Context:
 *   PR8 расширил pairBuilder COALESCE'ом — для новых sources
 *   provenance работает для всех 3 каналов. Этот script заполняет
 *   уже существующие TG/MAX rows AiKnowledgeSource, где
 *   connectionId IS NULL и messageId связан через Chat.metadata.
 *
 *   Источник правды: Chat.metadata->>'connectionId' для не-WA
 *   каналов (записывается webhook-handler'ом и telegram-mtproto
 *   при ingest сообщений).
 *
 * Что делает:
 *   - Только TG/MAX sources с connectionId IS NULL
 *   - Resolve через Chat.metadata->>'connectionId'
 *   - Один atomic UPDATE statement
 *   - Idempotent: повторный запуск не делает ничего
 *
 * Safety:
 *   - DRY_RUN=1 — preview без записи
 *   - WHERE connectionId IS NULL — no destructive overwrite
 *   - WA sources не трогает (для них PR7.6.5b backfill уже отработал)
 *
 * Запуск:
 *   cd D:/Github/CRM/gravity-mvp
 *   node scripts/backfill_source_connection_pr8.js
 *   # preview без изменений:
 *   DRY_RUN=1 node scripts/backfill_source_connection_pr8.js
 */

const { PrismaClient } = require('@prisma/client')
const { backfillLegacyTelegramMaxSourceConnectionsV1 } = require('../src/modules/ai-knowledge/public/v1/legacy-prisma-source-connection-backfill-adapter')
const prisma = new PrismaClient()

const DRY_RUN = process.env.DRY_RUN === '1'

async function main() {
    console.log('[backfill] PR8.B2 — TG/MAX Knowledge Source connection provenance')
    if (DRY_RUN) console.log('[backfill] DRY_RUN mode — никаких изменений в БД')

    // ── 1. Statistics: before ────────────────────────────────────
    const beforeStats = await prisma.$queryRaw`
        SELECT
            channel::text AS channel,
            COUNT(*) FILTER (WHERE "connectionId" IS NULL)::int AS "nullCount",
            COUNT(*) FILTER (WHERE "connectionId" IS NOT NULL)::int AS "filledCount",
            COUNT(*)::int AS total
        FROM "AiKnowledgeSource"
        GROUP BY channel
        ORDER BY channel
    `
    console.log('\n[backfill] Source breakdown (before):')
    for (const r of beforeStats) {
        console.log(`  ${r.channel ?? '(NULL)'}: ${r.nullCount} NULL / ${r.filledCount} filled / ${r.total} total`)
    }

    // ── 2. Resolvable TG/MAX sources count ────────────────────────
    const resolvableRows = await prisma.$queryRaw`
        SELECT
            s.channel::text AS channel,
            COUNT(*)::int AS cnt
        FROM "AiKnowledgeSource" s
        JOIN "Chat" c ON c.id = s."chatId"
        WHERE s."connectionId" IS NULL
          AND s.channel::text IN ('telegram', 'max')
          AND c.metadata->>'connectionId' IS NOT NULL
        GROUP BY s.channel::text
        ORDER BY channel
    `
    console.log('\n[backfill] Resolvable TG/MAX sources (NULL → can be filled):')
    let totalResolvable = 0
    for (const r of resolvableRows) {
        console.log(`  ${r.channel}: ${r.cnt}`)
        totalResolvable += Number(r.cnt)
    }
    if (totalResolvable === 0) {
        console.log('  (нет)')
    }

    // ── 3. Orphans (NULL после backfill — chat без metadata.connectionId) ──
    const orphanRows = await prisma.$queryRaw`
        SELECT
            s.channel::text AS channel,
            COUNT(*)::int AS cnt
        FROM "AiKnowledgeSource" s
        WHERE s."connectionId" IS NULL
          AND s.channel::text IN ('telegram', 'max')
          AND s."chatId" IS NOT NULL
          AND NOT EXISTS (
              SELECT 1 FROM "Chat" c
              WHERE c.id = s."chatId"
                AND c.metadata->>'connectionId' IS NOT NULL
          )
        GROUP BY s.channel::text
        ORDER BY channel
    `
    if (orphanRows.length > 0) {
        console.log('\n[backfill] Orphan TG/MAX sources (без metadata.connectionId, останутся NULL):')
        for (const r of orphanRows) {
            console.log(`  ${r.channel}: ${r.cnt}`)
        }
    }

    if (DRY_RUN) {
        console.log(`\n[backfill] DRY_RUN — UPDATE would touch ${totalResolvable} rows. Re-run без DRY_RUN=1 для применения.`)
        return
    }

    if (totalResolvable === 0) {
        console.log('\n[backfill] Нечего обновлять. Возможно скрипт уже применялся (идемпотентно).')
        return
    }

    // ── 4. Apply UPDATE ──────────────────────────────────────────
    // Одним statement'ом atomic update.
    const updated = await backfillLegacyTelegramMaxSourceConnectionsV1()
    console.log(`\n[backfill] UPDATE done. Rows affected: ${updated}`)

    // ── 5. Verify after ──────────────────────────────────────────
    const afterStats = await prisma.$queryRaw`
        SELECT
            channel::text AS channel,
            COUNT(*) FILTER (WHERE "connectionId" IS NULL)::int AS "nullCount",
            COUNT(*) FILTER (WHERE "connectionId" IS NOT NULL)::int AS "filledCount",
            COUNT(*)::int AS total
        FROM "AiKnowledgeSource"
        GROUP BY channel
        ORDER BY channel
    `
    console.log('\n[backfill] Source breakdown (after):')
    for (const r of afterStats) {
        console.log(`  ${r.channel ?? '(NULL)'}: ${r.nullCount} NULL / ${r.filledCount} filled / ${r.total} total`)
    }
}

main()
    .catch(e => { console.error('[backfill] FAILED:', e.message); process.exit(1) })
    .finally(async () => { await prisma.$disconnect() })
