/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * PR7.6.5b — idempotent backfill of AiKnowledgeSource.connectionId
 * for legacy WhatsApp sources.
 *
 * Context:
 *   PR7.1 добавил AiKnowledgeSource.connectionId (nullable). PR7.6.5a
 *   научил Extractor его писать для новых items. Этот script
 *   заполняет existing WA sources, созданных до PR7 — без него
 *   PR7b disable/reset для legacy items работать не будет.
 *
 * Что делает:
 *   - Только WhatsApp sources с connectionId IS NULL
 *   - Resolve через Chat.externalChatId → WhatsAppChat.connectionId
 *   - UPDATE применяется одним statement'ом (atomic)
 *   - Idempotent: повторный запуск не делает ничего (нет matching NULL)
 *   - TG/MAX sources остаются NULL — schema не хранит chat-level provenance
 *
 * Safety:
 *   - DRY_RUN=1 — только preview, без записей
 *   - WHERE connectionId IS NULL — no destructive overwrite
 *   - Никаких DELETE
 *
 * Запуск:
 *   cd D:/Github/CRM/gravity-mvp
 *   node scripts/backfill_source_connection_pr7.js
 *   # preview без изменений:
 *   DRY_RUN=1 node scripts/backfill_source_connection_pr7.js
 */

const { PrismaClient } = require('@prisma/client')
const { backfillLegacyWhatsAppSourceConnectionsV1 } = require('../src/modules/ai-knowledge/public/v1/legacy-prisma-source-connection-backfill-adapter')
const prisma = new PrismaClient()

const DRY_RUN = process.env.DRY_RUN === '1'

async function main() {
    console.log('[backfill] PR7.6.5b — Knowledge Source connection provenance')
    if (DRY_RUN) console.log('[backfill] DRY_RUN mode — никаких изменений в БД')

    // ── 1. Statistics: before ────────────────────────────────────
    const beforeStats = await prisma.$queryRaw`
        SELECT
            channel::text AS channel,
            COUNT(*) FILTER (WHERE "connectionId" IS NULL)::int AS "nullCount",
            COUNT(*)::int AS total
        FROM "AiKnowledgeSource"
        GROUP BY channel
        ORDER BY channel
    `
    console.log('\n[backfill] Source breakdown (before):')
    for (const r of beforeStats) {
        console.log(`  ${r.channel ?? '(NULL)'}: ${r.nullCount} NULL / ${r.total} total`)
    }

    // ── 2. Resolvable WA sources count (dry calc) ────────────────
    const resolvableRows = await prisma.$queryRaw`
        SELECT COUNT(*)::int AS cnt
        FROM "AiKnowledgeSource" s
        JOIN "Chat"          c  ON c.id  = s."chatId"
        JOIN "WhatsAppChat"  wc ON wc.id = c."externalChatId"
        WHERE s."connectionId" IS NULL
          AND s.channel::text  = 'whatsapp'
    `
    const resolvableCount = Number(resolvableRows[0].cnt)
    console.log(`\n[backfill] Resolvable WA sources (NULL → can be filled): ${resolvableCount}`)

    // ── 3. WA sources с broken chat-link (можно отдельно warn) ───
    const orphanRows = await prisma.$queryRaw`
        SELECT COUNT(*)::int AS cnt
        FROM "AiKnowledgeSource" s
        WHERE s."connectionId" IS NULL
          AND s.channel::text  = 'whatsapp'
          AND s."chatId" IS NOT NULL
          AND NOT EXISTS (
              SELECT 1 FROM "Chat" c
              JOIN "WhatsAppChat" wc ON wc.id = c."externalChatId"
              WHERE c.id = s."chatId"
          )
    `
    const orphanCount = Number(orphanRows[0].cnt)
    if (orphanCount > 0) {
        console.log(`[backfill] WARNING: ${orphanCount} WA sources without resolvable chat — останутся NULL`)
    }

    if (DRY_RUN) {
        console.log(`\n[backfill] DRY_RUN — UPDATE would touch ${resolvableCount} rows. Re-run без DRY_RUN=1 для применения.`)
        return
    }

    if (resolvableCount === 0) {
        console.log('\n[backfill] Нечего обновлять. Возможно скрипт уже применялся (идемпотентно).')
        return
    }

    // ── 4. Apply UPDATE ──────────────────────────────────────────
    // PostgreSQL UPDATE...FROM с JOIN-style sub-query. Один statement,
    // atomic, без race conditions.
    const updated = await backfillLegacyWhatsAppSourceConnectionsV1()
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

    const waNullAfter = afterStats.find(r => r.channel === 'whatsapp')?.nullCount ?? 0
    if (waNullAfter === 0) {
        console.log('\n[backfill] ✅ Все WA sources имеют connectionId')
    } else {
        console.log(`\n[backfill] ${waNullAfter} WA sources всё ещё NULL — это orphan'ы (chat-link broken).`)
    }
    console.log('[backfill] TG/MAX sources с NULL — это намеренно. Schema не хранит chat-level provenance для них.')
}

main()
    .catch(e => { console.error('[backfill] FAILED:', e.message); process.exit(1) })
    .finally(async () => { await prisma.$disconnect() })
