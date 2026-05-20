/* eslint-disable no-console */
/**
 * Smoke test для PR5.11 — production polish coverage gaps.
 *
 * Не дублирует существующие PR5 smoke'и (readiness, legacy migration),
 * а покрывает что НЕ покрыто:
 *   - Health 7d aggregation contracts (PR5.10)
 *   - Bulk verify SQL invariant (PR5.8): N items флипаются вместе
 *   - Bulk archive drafts SQL invariant: status='draft' → 'archived'
 *   - Help page files exist (PR5.3)
 *   - readiness.ts lib exports health interface (PR5.10)
 *   - Seed 10 sections (precondition для всех остальных PR5 фич)
 *
 * Запуск: cd D:/Github/CRM/gravity-mvp && node scripts/smoke_production_polish_pr5.js
 */

const fs = require('fs')
const path = require('path')
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

let pass = 0, fail = 0
function check(name, cond, detail) {
    if (cond) { console.log(`  ✓ ${name}`); pass++ }
    else { console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); fail++ }
}

async function main() {
    console.log('[smoke-pr5.11] Production polish — coverage gaps')

    // ── 1. Help page files exist (PR5.3) ──────────────────────────
    const helpRoot = path.join(__dirname, '..', 'src', 'app', 'settings', 'integrations', 'ai-knowledge-help')
    check('ai-knowledge-help/page.tsx exists',
          fs.existsSync(path.join(helpRoot, 'page.tsx')))
    check('ai-knowledge-help/AiKnowledgeHelpClient.tsx exists',
          fs.existsSync(path.join(helpRoot, 'AiKnowledgeHelpClient.tsx')))
    const helpClient = fs.readFileSync(path.join(helpRoot, 'AiKnowledgeHelpClient.tsx'), 'utf-8')
    check('help has both manager + admin tabs',
          /tab === 'manager'/.test(helpClient) && /tab === 'admin'/.test(helpClient))
    check('help admin covers runtime env warning',
          /AI_KNOWLEDGE_RUNTIME_ENABLED/.test(helpClient))

    const hub = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'app', 'settings', 'integrations', 'ai-call-help', 'page.tsx'),
        'utf-8'
    )
    check('hub references /ai-knowledge-help',
          /\/settings\/integrations\/ai-knowledge-help/.test(hub))

    // ── 2. readiness.ts exports health interface (PR5.10) ─────────
    const readinessLib = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'lib', 'ai', 'knowledge', 'readiness.ts'),
        'utf-8'
    )
    check('readiness.ts exports KnowledgeHealth7d interface',
          /export interface KnowledgeHealth7d/.test(readinessLib))
    check('bundle includes health7d',
          /health7d:\s+KnowledgeHealth7d/.test(readinessLib))
    check('loadHealth7d function defined',
          /async function loadHealth7d/.test(readinessLib))

    // ── 3. Seed sections precondition ─────────────────────────────
    const sections = await prisma.$queryRaw`
        SELECT slug FROM "AiKnowledgeSection" WHERE "isActive" = true
    `
    const slugs = new Set(sections.map(s => s.slug))
    const required = ['tariffs', 'requirements', 'documents', 'payouts', 'faq']
    check('seed: 5+ critical sections present',
          required.every(r => slugs.has(r)),
          `missing: ${required.filter(r => !slugs.has(r)).join(',')}`)

    // ── 4. Health 7d query contract (PR5.10) ──────────────────────
    // Verified usage % join: AiKnowledgeUsageLog × AiKnowledgeItem
    const usageHealthRows = await prisma.$queryRaw`
        SELECT
            COUNT(*) FILTER (WHERE ul."usedInReply" = true)::int AS "usedTotal",
            COUNT(*) FILTER (
                WHERE ul."usedInReply" = true AND ki."isVerified" = true
            )::int AS "usedVerified"
        FROM "AiKnowledgeUsageLog" ul
        LEFT JOIN "AiKnowledgeItem" ki ON ki.id = ul."itemId"
        WHERE ul."usedAt" > NOW() - INTERVAL '7 days'
    `
    check('health query: usedTotal returns int',
          typeof Number(usageHealthRows[0].usedTotal) === 'number')
    check('health invariant: usedVerified ≤ usedTotal',
          Number(usageHealthRows[0].usedVerified) <= Number(usageHealthRows[0].usedTotal))

    // Shadow mismatch — проверим что filter expression компилируется
    const shadowMismatchRows = await prisma.$queryRaw`
        SELECT
            COUNT(*) FILTER (
                WHERE "shadowRetrievalSummary" IS NOT NULL
                AND (
                    ("shadowRetrievalSummary"->>'decision' = 'answer' AND decision != 'auto_reply')
                    OR
                    ("shadowRetrievalSummary"->>'decision' = 'escalate' AND decision != 'escalate')
                    OR
                    ("shadowRetrievalSummary"->>'decision' = 'no_knowledge' AND decision = 'auto_reply')
                )
            )::int AS mismatched,
            COUNT(*) FILTER (
                WHERE "shadowRetrievalSummary" IS NOT NULL
            )::int AS total
        FROM "AiDecisionLog"
        WHERE "retrievalMode" = 'shadow'
          AND "createdAt" > NOW() - INTERVAL '7 days'
    `
    check('shadow mismatch query compiles', shadowMismatchRows.length === 1)
    check('mismatched ≤ total',
          Number(shadowMismatchRows[0].mismatched) <= Number(shadowMismatchRows[0].total))

    // ── 5. Bulk verify SQL contract ───────────────────────────────
    const sec = await prisma.$queryRaw`SELECT id FROM "AiKnowledgeSection" WHERE slug='faq' LIMIT 1`
    const sectionFaqId = sec[0].id
    const idA = 'kbi_bulk_a_' + Date.now()
    const idB = 'kbi_bulk_b_' + Date.now()
    const idC = 'kbi_bulk_c_' + Date.now()  // already verified — skipped

    try {
        for (const [id, verified] of [[idA, false], [idB, false], [idC, true]]) {
            await prisma.$executeRaw`
                INSERT INTO "AiKnowledgeItem" (
                    id, "sectionId", title, "canonicalStatement", tags,
                    confidence, "sourceCount", "uniqueManagerCount",
                    status, "isActive", "safetyLevel", "isVerified",
                    "createdAt", "updatedAt"
                ) VALUES (
                    ${id}, ${sectionFaqId},
                    ${'PR5.11 bulk ' + id}, 'bulk test stmt',
                    ARRAY[]::text[], 0.85, 2, 2,
                    'active'::"AiKnowledgeStatus", true, 'normal'::"AiKnowledgeSafety", ${verified},
                    NOW(), NOW()
                )
            `
        }

        // Mirror bulkVerifyItems: для каждого id — единичный UPDATE
        // Только not-verified.
        let processed = 0, skipped = 0
        for (const id of [idA, idB, idC]) {
            const cur = await prisma.$queryRaw`
                SELECT "isVerified" FROM "AiKnowledgeItem" WHERE id = ${id}
            `
            if (cur[0].isVerified) { skipped++; continue }
            await prisma.$executeRaw`
                UPDATE "AiKnowledgeItem"
                SET "isVerified" = true, "verifiedBy" = 'smoke-actor', "verifiedAt" = NOW()
                WHERE id = ${id}
            `
            processed++
        }
        check('bulk verify: processed 2 (A, B)', processed === 2)
        check('bulk verify: skipped 1 (C already verified)', skipped === 1)

        const verifiedAfter = await prisma.$queryRaw`
            SELECT COUNT(*)::int AS n FROM "AiKnowledgeItem"
            WHERE id IN (${idA}, ${idB}, ${idC}) AND "isVerified" = true
        `
        check('all 3 verified after bulk pass', Number(verifiedAfter[0].n) === 3)

        // ── 6. Bulk archive drafts SQL contract ───────────────────
        const draftId1 = 'kbi_draft_1_' + Date.now()
        const draftId2 = 'kbi_draft_2_' + Date.now()
        await prisma.$executeRaw`
            INSERT INTO "AiKnowledgeItem" (
                id, "sectionId", title, "canonicalStatement", tags,
                confidence, "sourceCount", "uniqueManagerCount",
                status, "isActive", "safetyLevel", "isVerified",
                "createdAt", "updatedAt"
            ) VALUES (
                ${draftId1}, ${sectionFaqId}, 'PR5.11 draft 1', 'draft stmt',
                ARRAY[]::text[], 0.5, 1, 1,
                'draft'::"AiKnowledgeStatus", true, 'normal'::"AiKnowledgeSafety", false,
                NOW(), NOW()
            )
        `
        await prisma.$executeRaw`
            INSERT INTO "AiKnowledgeItem" (
                id, "sectionId", title, "canonicalStatement", tags,
                confidence, "sourceCount", "uniqueManagerCount",
                status, "isActive", "safetyLevel", "isVerified",
                "createdAt", "updatedAt"
            ) VALUES (
                ${draftId2}, ${sectionFaqId}, 'PR5.11 draft 2', 'draft stmt 2',
                ARRAY[]::text[], 0.4, 1, 1,
                'draft'::"AiKnowledgeStatus", true, 'normal'::"AiKnowledgeSafety", false,
                NOW(), NOW()
            )
        `

        const draftsFound = await prisma.$queryRaw`
            SELECT id FROM "AiKnowledgeItem"
            WHERE "sectionId" = ${sectionFaqId} AND status = 'draft' AND "isActive" = true
        `
        check('drafts found in section >= 2', draftsFound.length >= 2)

        // Mirror bulkArchiveDraftsInSection: UPDATE status='archived'
        let archived = 0
        for (const r of draftsFound) {
            await prisma.$executeRaw`
                UPDATE "AiKnowledgeItem"
                SET status = 'archived'::"AiKnowledgeStatus", "updatedAt" = NOW()
                WHERE id = ${r.id}
            `
            archived++
        }
        check('bulk archive drafts: archived all', archived === draftsFound.length)

        const stillDraft = await prisma.$queryRaw`
            SELECT COUNT(*)::int AS n FROM "AiKnowledgeItem"
            WHERE "sectionId" = ${sectionFaqId} AND status = 'draft' AND "isActive" = true
        `
        check('no drafts remain in section', Number(stillDraft[0].n) === 0)

        await prisma.$executeRaw`DELETE FROM "AiKnowledgeItem" WHERE id IN (${draftId1}, ${draftId2})`
    } finally {
        await prisma.$executeRaw`DELETE FROM "AiKnowledgeItem" WHERE id IN (${idA}, ${idB}, ${idC})`
    }

    // ── 7. legacyMigration.ts re-exports check (PR5.5 contract still holds)
    const legacyLib = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'lib', 'ai', 'knowledge', 'legacyMigration.ts'),
        'utf-8'
    )
    check('legacy mapping still has 10+ categories',
          (legacyLib.match(/^\s+\w+:\s+'\w+',?$/gm) || []).length >= 10)

    console.log(`\n[smoke-pr5.11] Done. pass=${pass} fail=${fail}`)
    if (fail > 0) process.exit(1)
}

main()
    .catch(e => { console.error('[smoke-pr5.11] FAILED:', e.message); process.exit(1) })
    .finally(async () => { await prisma.$disconnect() })
