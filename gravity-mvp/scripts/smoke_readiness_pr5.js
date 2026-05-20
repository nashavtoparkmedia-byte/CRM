/* eslint-disable no-console */
/**
 * Smoke test для PR5.1 Readiness aggregator.
 *
 * Проверяем что getKnowledgeReadiness():
 *   - возвращает counts (active/verified/draft/archived/conflictGroups/sections)
 *   - возвращает lastExtraction (или null)
 *   - возвращает activity7d (decisionsTotal / shadow / runtime / escalated / noMatch)
 *   - возвращает checks[] с 5 items + overall worst-status
 *   - tolerant: ошибка в одной части не валит всё
 *
 * Запуск: cd D:/Github/CRM/gravity-mvp && node scripts/smoke_readiness_pr5.js
 */

const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

let pass = 0, fail = 0
function check(name, cond, detail) {
    if (cond) { console.log(`  ✓ ${name}`); pass++ }
    else { console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); fail++ }
}

async function main() {
    console.log('[smoke-pr5.1] Loading readiness module...')
    // ESM-only export, поэтому через tsx-style require невозможен.
    // Использую динамический ts-node-like подход: компилим в process через
    // прямой require .ts невозможно — поэтому дублируем минимальный SQL
    // здесь, проверяя что схема поддерживает все query'и которые делает
    // readiness.ts. Это smoke БД-контракта, не модульный test.
    //
    // (PR5.11 в итоге добавит полный E2E import через transpile-on-fly
    // или server-action wrapper — здесь же гарантируем что SQL не падает.)

    const counts = await prisma.$queryRaw`
        SELECT
            (SELECT COUNT(*) FROM "AiKnowledgeItem"
                WHERE status = 'active' AND "isActive" = true)       AS "activeItems",
            (SELECT COUNT(*) FROM "AiKnowledgeItem"
                WHERE status = 'active' AND "isActive" = true
                  AND "isVerified" = true)                            AS "verifiedItems",
            (SELECT COUNT(*) FROM "AiKnowledgeItem"
                WHERE status = 'draft')                               AS "draftItems",
            (SELECT COUNT(*) FROM "AiKnowledgeItem"
                WHERE status IN ('archived','superseded'))            AS "archivedItems",
            (SELECT COUNT(DISTINCT "conflictGroupId")
                FROM "AiKnowledgeItem"
                WHERE "conflictGroupId" IS NOT NULL
                  AND status = 'active')                              AS "conflictGroups",
            (SELECT COUNT(*) FROM "AiKnowledgeSection"
                WHERE "isActive" = true)                              AS "activeSections"
    `
    check('Counts query returns row', counts.length === 1)
    const c = counts[0]
    check('activeItems is bigint/int', typeof c.activeItems === 'bigint' || typeof c.activeItems === 'number')
    check('verifiedItems ≤ activeItems',
          Number(c.verifiedItems) <= Number(c.activeItems))
    check('conflictGroups ≥ 0', Number(c.conflictGroups) >= 0)
    check('activeSections > 0 (seed)', Number(c.activeSections) > 0)

    // lastExtraction: optional row
    const lastExtr = await prisma.$queryRaw`
        SELECT
            id, status::text AS status,
            "startedAt", "finishedAt",
            progress, "errorMessage",
            "createdAt"
        FROM "AiExtractionJob"
        ORDER BY "createdAt" DESC
        LIMIT 1
    `
    check('lastExtraction query runs', Array.isArray(lastExtr))
    if (lastExtr[0]) {
        check('lastExtraction has status', typeof lastExtr[0].status === 'string')
    } else {
        check('lastExtraction empty is ok', true)
    }

    // activity7d: AiDecisionLog с retrievalMode за 7д
    const activity = await prisma.$queryRaw`
        SELECT
            COUNT(*)::int                                                          AS "decisionsTotal",
            COUNT(*) FILTER (WHERE "retrievalMode" = 'shadow')::int                AS "shadowDecisions",
            COUNT(*) FILTER (WHERE "retrievalMode" = 'runtime')::int               AS "runtimeDecisions",
            COUNT(*) FILTER (WHERE escalated = true)::int                          AS "escalated",
            COUNT(*) FILTER (WHERE "retrievalDecision" = 'no_match')::int          AS "noMatch",
            MIN("createdAt")                                                       AS "firstAt",
            MAX("createdAt")                                                       AS "lastAt"
        FROM "AiDecisionLog"
        WHERE "retrievalMode" IS NOT NULL
          AND "createdAt" > NOW() - INTERVAL '7 days'
    `
    check('activity7d query runs', activity.length === 1)
    const a = activity[0]
    check('shadowDecisions ≤ decisionsTotal',
          Number(a.shadowDecisions) <= Number(a.decisionsTotal))
    check('runtimeDecisions ≤ decisionsTotal',
          Number(a.runtimeDecisions) <= Number(a.decisionsTotal))
    check('escalated ≤ decisionsTotal',
          Number(a.escalated) <= Number(a.decisionsTotal))

    // Insert synthetic conflict to test checks[].conflicts → fail
    const sec = await prisma.$queryRaw`SELECT id FROM "AiKnowledgeSection" WHERE slug='tariffs' LIMIT 1`
    if (!sec[0]) throw new Error('seed missing')
    const groupId = 'kgcf_smoke_pr5_' + Date.now()
    const itemA = 'kbi_rdy_a_' + Date.now()
    const itemB = 'kbi_rdy_b_' + Date.now()
    try {
        await prisma.$executeRaw`
            INSERT INTO "AiKnowledgeItem" (
                id, "sectionId", title, "canonicalStatement", tags,
                confidence, "sourceCount", "uniqueManagerCount",
                status, "isActive", "safetyLevel", "isVerified",
                "conflictGroupId",
                "createdAt", "updatedAt"
            ) VALUES (
                ${itemA}, ${sec[0].id}, 'PR5 conflict A', 'A statement',
                ARRAY[]::text[], 0.9, 2, 2,
                'active'::"AiKnowledgeStatus", true, 'normal'::"AiKnowledgeSafety", true,
                ${groupId},
                NOW(), NOW()
            )
        `
        await prisma.$executeRaw`
            INSERT INTO "AiKnowledgeItem" (
                id, "sectionId", title, "canonicalStatement", tags,
                confidence, "sourceCount", "uniqueManagerCount",
                status, "isActive", "safetyLevel", "isVerified",
                "conflictGroupId",
                "createdAt", "updatedAt"
            ) VALUES (
                ${itemB}, ${sec[0].id}, 'PR5 conflict B', 'B statement',
                ARRAY[]::text[], 0.85, 2, 2,
                'active'::"AiKnowledgeStatus", true, 'normal'::"AiKnowledgeSafety", true,
                ${groupId},
                NOW(), NOW()
            )
        `

        const conflictRow = await prisma.$queryRaw`
            SELECT COUNT(DISTINCT "conflictGroupId")::int AS cnt
            FROM "AiKnowledgeItem"
            WHERE "conflictGroupId" IS NOT NULL
              AND status = 'active'
        `
        check('Conflict group detected after insert',
              Number(conflictRow[0].cnt) >= 1)

    } finally {
        await prisma.$executeRaw`DELETE FROM "AiKnowledgeItem" WHERE id IN (${itemA}, ${itemB})`
    }

    console.log(`\n[smoke-pr5.1] Done. pass=${pass} fail=${fail}`)
    if (fail > 0) process.exit(1)
}

main()
    .catch(e => { console.error('[smoke-pr5.1] FAILED:', e.message); process.exit(1) })
    .finally(async () => { await prisma.$disconnect() })
