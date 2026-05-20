/* eslint-disable no-console */
/**
 * Smoke test для PR2 extraction pipeline.
 *
 * Проверяет всё, что можно проверить БЕЗ траты LLM-токенов:
 *   - Schema delta PR2.1 применена (extractionQualityTier default
 *     'balanced', AiExtractionJob snapshot fields)
 *   - 10 секций seeded (PR1)
 *   - excerptHash unique constraint реально работает (idempotency)
 *   - Активный pipeline ответа клиентам НЕ затронут
 *
 * Полный end-to-end (запуск runExtraction с LLM) — отдельная manual
 * команда через UI, потому что требует API key и тратит токены.
 *
 * Запуск: cd D:/Github/CRM/gravity-mvp && node scripts/smoke_extraction_pr2.js
 */

const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

let pass = 0, fail = 0
function check(name, cond, detail) {
    if (cond) { console.log(`  ✓ ${name}`); pass++ }
    else { console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); fail++ }
}

async function main() {
    console.log('[smoke-pr2] Checking schema delta (PR2.1)...')

    const cfgCols = await prisma.$queryRaw`
        SELECT column_name, column_default
        FROM information_schema.columns
        WHERE table_name = 'AiAgentConfig'
          AND column_name IN ('extractionQualityTier', 'extractionPromptVersion')
    `
    const tierCol = cfgCols.find(c => c.column_name === 'extractionQualityTier')
    check('AiAgentConfig.extractionQualityTier exists', !!tierCol)
    check(
        'AiAgentConfig.extractionQualityTier default = balanced',
        tierCol && /balanced/.test(tierCol.column_default || ''),
        `actual default: ${tierCol?.column_default}`,
    )
    check(
        'AiAgentConfig.extractionPromptVersion exists',
        cfgCols.some(c => c.column_name === 'extractionPromptVersion'),
    )

    const jobCols = await prisma.$queryRaw`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'AiExtractionJob'
          AND column_name IN ('extractionProvider', 'extractionModel',
                              'extractionPromptVersion', 'extractionQualityTier')
    `
    check('AiExtractionJob snapshot columns (4)', jobCols.length === 4,
          `got: ${jobCols.map(c => c.column_name).join(', ')}`)

    const sectionCount = await prisma.$queryRaw`
        SELECT COUNT(*)::int AS cnt FROM "AiKnowledgeSection" WHERE "isActive" = true
    `
    check('AiKnowledgeSection has ≥ 10 active sections',
          sectionCount[0]?.cnt >= 10,
          `got: ${sectionCount[0]?.cnt}`)

    console.log('[smoke-pr2] Testing excerptHash idempotency...')
    let tempItemId = null
    try {
        const sec = await prisma.$queryRaw`
            SELECT id FROM "AiKnowledgeSection" WHERE slug = 'tariffs' LIMIT 1
        `
        if (!sec[0]) throw new Error('tariffs section missing')
        const tempSectionId = sec[0].id

        tempItemId = 'kbi_smoke_' + Date.now()
        await prisma.$executeRaw`
            INSERT INTO "AiKnowledgeItem" (
                id, "sectionId", title, "canonicalStatement", tags,
                confidence, "sourceCount", "uniqueManagerCount",
                status, "isActive", "safetyLevel",
                "createdBy", "createdAt", "updatedAt"
            ) VALUES (
                ${tempItemId}, ${tempSectionId}, 'SMOKE TEST item',
                'SMOKE TEST canonical statement (will be deleted)',
                ARRAY['smoke']::text[],
                0.9, 1, 0,
                'draft'::"AiKnowledgeStatus", false, 'normal'::"AiKnowledgeSafety",
                'smoke-test', NOW(), NOW()
            )
        `
        const sourceId1 = 'kbs_smoke_1_' + Date.now()
        const sourceId2 = 'kbs_smoke_2_' + Date.now()
        const hash = 'smoke-hash-fixed-' + Date.now()
        await prisma.$executeRaw`
            INSERT INTO "AiKnowledgeSource" (
                id, "itemId", "originType", excerpt, "excerptHash",
                confidence, "createdAt"
            ) VALUES (
                ${sourceId1}, ${tempItemId}, 'chat_message',
                'smoke excerpt', ${hash}, 0.9, NOW()
            )
        `
        check('First source insert OK', true)

        let secondInsertThrew = false
        try {
            await prisma.$executeRaw`
                INSERT INTO "AiKnowledgeSource" (
                    id, "itemId", "originType", excerpt, "excerptHash",
                    confidence, "createdAt"
                ) VALUES (
                    ${sourceId2}, ${tempItemId}, 'chat_message',
                    'smoke excerpt duplicate', ${hash}, 0.9, NOW()
                )
            `
        } catch {
            secondInsertThrew = true
        }
        check('Duplicate insert threw exception', secondInsertThrew)
        const finalCount = await prisma.$queryRaw`
            SELECT COUNT(*)::int AS cnt
            FROM "AiKnowledgeSource"
            WHERE "itemId" = ${tempItemId} AND "excerptHash" = ${hash}
        `
        check('Only 1 source row after dup attempt',
              finalCount[0]?.cnt === 1,
              `actual: ${finalCount[0]?.cnt}`)
    } finally {
        if (tempItemId) {
            await prisma.$executeRaw`DELETE FROM "AiKnowledgeSource" WHERE "itemId" = ${tempItemId}`
            await prisma.$executeRaw`DELETE FROM "AiKnowledgeItem"   WHERE id = ${tempItemId}`
        }
    }

    const kbCount = await prisma.$queryRaw`SELECT COUNT(*)::int AS cnt FROM "KnowledgeBaseEntry"`
    const dlCount = await prisma.$queryRaw`SELECT COUNT(*)::int AS cnt FROM "AiDecisionLog"`
    check('KnowledgeBaseEntry accessible (legacy not broken)', typeof kbCount[0]?.cnt === 'number')
    check('AiDecisionLog accessible (logs not broken)', typeof dlCount[0]?.cnt === 'number')

    const itemCount = await prisma.$queryRaw`SELECT COUNT(*)::int AS cnt FROM "AiKnowledgeItem"`
    const srcCount  = await prisma.$queryRaw`SELECT COUNT(*)::int AS cnt FROM "AiKnowledgeSource"`
    console.log(`[smoke-pr2] Knowledge state: items=${itemCount[0]?.cnt}, sources=${srcCount[0]?.cnt}`)

    console.log(`\n[smoke-pr2] Done. pass=${pass} fail=${fail}`)
    console.log(`[smoke-pr2] Full end-to-end (requires API key):`)
    console.log(`    /settings/ai → AI Провайдер → save key → Ядро знаний → Собрать ядро → Запустить`)
    if (fail > 0) process.exit(1)
}

main()
    .catch(e => { console.error('[smoke-pr2] FAILED:', e.message); process.exit(1) })
    .finally(async () => { await prisma.$disconnect() })
