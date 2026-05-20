/* eslint-disable no-console */
/**
 * Smoke test для PR4 Explainability layer.
 *
 * Никаких новых таблиц — PR4 это visual+aggregator слой поверх traces
 * из PR3. Проверяем что SQL-агрегация корректно join'ит:
 *   - AiDecisionLog → Message (by messageId)
 *   - AiDecisionLog → AiKnowledgeUsageLog (by decisionLogId)
 *   - AiKnowledgeUsageLog → AiKnowledgeItem (by itemId) + Section
 *   - itemIds → AiKnowledgeSource
 *   - itemIds → AiKnowledgeAuditLog WHERE createdAt > decision.createdAt
 *     (audit AFTER, не BEFORE)
 *
 * Запуск: cd D:/Github/CRM/gravity-mvp && node scripts/smoke_explainability_pr4.js
 */

const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

let pass = 0, fail = 0
function check(name, cond, detail) {
    if (cond) { console.log(`  ✓ ${name}`); pass++ }
    else { console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); fail++ }
}

async function main() {
    console.log('[smoke-pr4] Setting up temp explainability fixture...')

    const sec = await prisma.$queryRaw`SELECT id, slug FROM "AiKnowledgeSection" WHERE slug='tariffs' LIMIT 1`
    if (!sec[0]) throw new Error('tariffs section missing')
    const sectionId = sec[0].id

    const itemId   = 'kbi_smoke_pr4_' + Date.now()
    const itemId2  = 'kbi_smoke_pr4_2_' + Date.now()
    const dlogId   = 'adl_smoke_pr4_' + Date.now()
    const ulogId   = 'kul_smoke_pr4_' + Date.now()
    const ulogId2  = 'kul_smoke_pr4_2_' + Date.now()
    const audBefId = 'aud_smoke_pr4_bef_' + Date.now()
    const audAftId = 'aud_smoke_pr4_aft_' + Date.now()
    const decisionCreatedAt = new Date()

    try {
        // 1. Item with verified=true (для display badge)
        await prisma.$executeRaw`
            INSERT INTO "AiKnowledgeItem" (
                id, "sectionId", title, "canonicalStatement", tags,
                confidence, "sourceCount", "uniqueManagerCount",
                status, "isActive", "safetyLevel", "isVerified",
                "createdBy", "createdAt", "updatedAt"
            ) VALUES (
                ${itemId}, ${sectionId}, 'PR4 used item', 'used statement',
                ARRAY['smoke']::text[],
                0.9, 2, 2,
                'active'::"AiKnowledgeStatus", true, 'normal'::"AiKnowledgeSafety", true,
                'smoke', NOW(), NOW()
            )
        `
        // 2. Filtered item
        await prisma.$executeRaw`
            INSERT INTO "AiKnowledgeItem" (
                id, "sectionId", title, "canonicalStatement", tags,
                confidence, "sourceCount", "uniqueManagerCount",
                status, "isActive", "safetyLevel", "isVerified",
                "createdAt", "updatedAt"
            ) VALUES (
                ${itemId2}, ${sectionId}, 'PR4 filtered item', 'filtered statement',
                ARRAY[]::text[], 0.6, 1, 1,
                'active'::"AiKnowledgeStatus", true, 'normal'::"AiKnowledgeSafety", false,
                NOW(), NOW()
            )
        `

        // 3. Audit BEFORE decision — НЕ должна попасть в bundle
        await prisma.$executeRaw`
            INSERT INTO "AiKnowledgeAuditLog" (id, "itemId", actor, action, "createdAt")
            VALUES (${audBefId}, ${itemId}, 'smoke',
                    'created'::"AiKnowledgeAuditAction",
                    ${new Date(decisionCreatedAt.getTime() - 60000)})
        `

        // 4. DecisionLog с retrieval metadata
        const shadowJson = JSON.stringify({ decision: 'answer', topItemIds: [itemId], candidateCount: 2, durationMs: 42 })
        await prisma.$executeRaw`
            INSERT INTO "AiDecisionLog" (
                id, "messageId", "chatId", channel,
                "detectedIntent", confidence, decision, "selectedModel",
                "generatedReply", "replySent", escalated,
                "retrievalMode", "retrievalDecision", "escalationReason",
                "knowledgeRuntimeVersion", "shadowRetrievalSummary",
                "createdAt"
            ) VALUES (
                ${dlogId}, NULL, NULL, 'whatsapp',
                'smoke_intent', 0.9, 'auto_reply', 'claude-haiku-4-5',
                'smoke generated reply', true, false,
                'runtime', 'answer', NULL,
                'rerank:v1 policy:v1', ${shadowJson}::jsonb,
                ${decisionCreatedAt}
            )
        `

        // 5. UsageLog: used + filtered (улучшение #2 проверка)
        await prisma.$executeRaw`
            INSERT INTO "AiKnowledgeUsageLog" (
                id, "itemId", "runtimeContext", "decisionLogId",
                "retrievalScore", "rerankScore", "usedInReply",
                "policyDecision", "shadowMode", "escalationReason",
                "usedAt"
            ) VALUES (
                ${ulogId}, ${itemId}, 'chat_reply'::"AiKnowledgeRuntime", ${dlogId},
                0.72, 0.91, true,
                'used', false, NULL,
                NOW()
            )
        `
        await prisma.$executeRaw`
            INSERT INTO "AiKnowledgeUsageLog" (
                id, "itemId", "runtimeContext", "decisionLogId",
                "retrievalScore", "policyDecision", "shadowMode", "usedInReply", "usedAt"
            ) VALUES (
                ${ulogId2}, ${itemId2}, 'chat_reply'::"AiKnowledgeRuntime", ${dlogId},
                0.45, 'filtered_low_confidence', false, false, NOW()
            )
        `

        // 6. Audit AFTER decision — должна попасть
        await prisma.$executeRaw`
            INSERT INTO "AiKnowledgeAuditLog" (id, "itemId", actor, action, "createdAt")
            VALUES (${audAftId}, ${itemId}, 'smoke',
                    'edited'::"AiKnowledgeAuditAction",
                    ${new Date(decisionCreatedAt.getTime() + 60000)})
        `

        // ── Test 1: decision row
        console.log('[smoke-pr4] Testing aggregation queries...')
        const decisionRows = await prisma.$queryRaw`
            SELECT id, decision, "retrievalMode", "knowledgeRuntimeVersion", "shadowRetrievalSummary"
            FROM "AiDecisionLog" WHERE id = ${dlogId} LIMIT 1
        `
        check('Decision row found', decisionRows.length === 1)
        check('retrievalMode=runtime preserved', decisionRows[0]?.retrievalMode === 'runtime')
        check('knowledgeRuntimeVersion preserved',
              decisionRows[0]?.knowledgeRuntimeVersion === 'rerank:v1 policy:v1')
        check('shadowRetrievalSummary JSON preserved',
              !!decisionRows[0]?.shadowRetrievalSummary?.topItemIds)

        // ── Test 2: usage logs joined with item + section
        const usageRows = await prisma.$queryRaw`
            SELECT
                ul.id, ul."itemId", ul."retrievalScore", ul."rerankScore",
                ul."policyDecision",
                ki.title AS "item_title",
                ki."isVerified" AS "item_isVerified",
                ks.title AS "section_title",
                ks.slug AS "section_slug"
            FROM "AiKnowledgeUsageLog" ul
            LEFT JOIN "AiKnowledgeItem"    ki ON ki.id = ul."itemId"
            LEFT JOIN "AiKnowledgeSection" ks ON ks.id = ki."sectionId"
            WHERE ul."decisionLogId" = ${dlogId}
            ORDER BY ul."retrievalScore" DESC
        `
        check('Usage logs found (2: used + filtered)', usageRows.length === 2)
        check('First (top score) joined with item',
              usageRows[0]?.item_title === 'PR4 used item' && usageRows[0]?.item_isVerified === true)
        check('Section slug joined', usageRows[0]?.section_slug === 'tariffs')
        const usedCount = usageRows.filter(u => u.policyDecision === 'used').length
        const filteredCount = usageRows.filter(u => u.policyDecision?.startsWith('filtered_')).length
        check('Mix used + filtered (улучшение #2)',
              usedCount === 1 && filteredCount === 1)

        // ── Test 3: audit AFTER window (BEFORE excluded)
        const auditAfter = await prisma.$queryRaw`
            SELECT id, action::text AS action
            FROM "AiKnowledgeAuditLog"
            WHERE "itemId" = ${itemId}
              AND "createdAt" > ${decisionCreatedAt}
            ORDER BY "createdAt" ASC
        `
        check('Audit-after window: 1 entry', auditAfter.length === 1)
        check('Audit-after is the AFTER one (edited)',
              auditAfter[0]?.id === audAftId && auditAfter[0]?.action === 'edited')
        const allAudit = await prisma.$queryRaw`SELECT id FROM "AiKnowledgeAuditLog" WHERE "itemId" = ${itemId}`
        check('Total audit for item = 2 (sanity)', allAudit.length === 2)

        // ── Test 4: sources by itemIds
        await prisma.$executeRaw`
            INSERT INTO "AiKnowledgeSource" (
                id, "itemId", "originType", excerpt, "excerptHash",
                confidence, "createdAt"
            ) VALUES (
                ${'kbs_smoke_pr4_' + Date.now()},
                ${itemId}, 'chat_message', 'test excerpt PII-masked',
                'hash-smoke-pr4', 0.9, NOW()
            )
        `
        const sources = await prisma.$queryRaw`
            SELECT id, excerpt FROM "AiKnowledgeSource"
            WHERE "itemId" = ANY(${[itemId, itemId2]})
        `
        check('Sources loadable by itemIds (≥ 1)', sources.length >= 1)

    } finally {
        await prisma.$executeRaw`DELETE FROM "AiKnowledgeSource"   WHERE "itemId" IN (${itemId}, ${itemId2})`
        await prisma.$executeRaw`DELETE FROM "AiKnowledgeAuditLog" WHERE "itemId" IN (${itemId}, ${itemId2})`
        await prisma.$executeRaw`DELETE FROM "AiKnowledgeUsageLog" WHERE "decisionLogId" = ${dlogId}`
        await prisma.$executeRaw`DELETE FROM "AiDecisionLog"       WHERE id = ${dlogId}`
        await prisma.$executeRaw`DELETE FROM "AiKnowledgeItem"     WHERE id IN (${itemId}, ${itemId2})`
    }

    console.log(`\n[smoke-pr4] Done. pass=${pass} fail=${fail}`)
    console.log(`[smoke-pr4] UI E2E через /settings/ai → Журнал → "Почему AI так ответил?":`)
    console.log(`    1. Кнопка появляется под каждой записью AiDecisionLog`)
    console.log(`    2. Модал: вопрос/ответ/mode/policy/used items/filtered items/sources(admin)/audit-timeline/retry`)
    console.log(`    3. Manager: sources=[], нет per-item actions, нет retry, нет advanced`)
    console.log(`    4. Knowledge изменён после → badge "изменено после ответа"`)
    console.log(`    5. Retry preview: durations в advanced accordion (retrieval/rerank/generator/total Ms)`)
    if (fail > 0) process.exit(1)
}

main()
    .catch(e => { console.error('[smoke-pr4] FAILED:', e.message); process.exit(1) })
    .finally(async () => { await prisma.$disconnect() })
