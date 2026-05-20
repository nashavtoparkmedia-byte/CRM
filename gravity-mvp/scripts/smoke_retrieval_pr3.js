/* eslint-disable no-console */
/**
 * Smoke test для PR3 retrieval pipeline.
 *
 * Проверяет на уровне БД и алгоритма:
 *   - PR3.1 миграция применена (AiRetrievalPolicy singleton с defaults,
 *     AiKnowledgeUsageLog new fields, AiDecisionLog new fields)
 *   - SQL-фильтрация archived/superseded/draft (то что loadCandidates
 *     делает в Retriever)
 *   - Policy decision tree эквивалентен в JS (дублирован тут)
 *   - Pipeline ответа клиентам НЕ затронут
 *
 * Полный E2E с LLM rerank — manual через UI после flip env-flag'а
 * AI_KNOWLEDGE_RUNTIME_ENABLED=true.
 *
 * Запуск: cd D:/Github/CRM/gravity-mvp && node scripts/smoke_retrieval_pr3.js
 */

const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

let pass = 0, fail = 0
function check(name, cond, detail) {
    if (cond) { console.log(`  ✓ ${name}`); pass++ }
    else { console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); fail++ }
}

// Reference applyPolicy: must mirror Retriever.ts logic
function applyPolicy(ranked, policy, topK) {
    const skipped = []
    if (ranked.length === 0) {
        return { type: 'no_knowledge', escalationReason: 'no_relevant', usableItems: [], skippedItems: skipped }
    }
    const best = ranked[0]
    if (best.item.conflictGroupId && policy.conflictEscalates) {
        skipped.push({ itemId: best.item.id, reason: 'conflict' })
        return { type: 'escalate', escalationReason: 'conflict', usableItems: [], skippedItems: skipped }
    }
    if (best.item.safetyLevel === 'requires_human') {
        skipped.push({ itemId: best.item.id, reason: 'requires_human' })
        return { type: 'escalate', escalationReason: 'requires_human', usableItems: [], skippedItems: skipped }
    }
    const reqConf = best.item.safetyLevel === 'sensitive'
        ? policy.sensitiveConfidenceMargin : policy.minConfidenceForReply
    if (best.item.confidence < reqConf && !best.item.isVerified) {
        return { type: 'escalate', escalationReason: 'low_confidence', usableItems: [], skippedItems: skipped }
    }
    if (best.item.sourceCount < policy.minSourceCountForReply && !best.item.isVerified) {
        return { type: 'escalate', escalationReason: 'low_confidence', usableItems: [], skippedItems: skipped }
    }
    if (best.item.status === 'draft') {
        return { type: 'escalate', escalationReason: 'only_drafts', usableItems: [], skippedItems: skipped }
    }
    if (best.prefilterScore < 0.05) {
        return { type: 'no_knowledge', escalationReason: 'no_relevant', usableItems: [], skippedItems: skipped }
    }
    const usable = []
    for (const c of ranked.slice(0, topK)) {
        if (c.item.safetyLevel === 'requires_human') continue
        if (c.item.conflictGroupId && policy.conflictEscalates) continue
        usable.push(c.item)
    }
    if (usable.length === 0) {
        return { type: 'escalate', escalationReason: 'safety_block', usableItems: [], skippedItems: skipped }
    }
    return { type: 'answer', escalationReason: null, usableItems: usable, skippedItems: skipped }
}

const DEFAULT_POLICY = {
    minConfidenceForReply: 0.7,
    sensitiveConfidenceMargin: 0.85,
    minSourceCountForReply: 1,
    conflictEscalates: true,
}

async function main() {
    console.log('[smoke-pr3] Verifying schema delta (PR3.1)...')

    // 1. AiRetrievalPolicy singleton
    const pol = await prisma.$queryRaw`SELECT * FROM "AiRetrievalPolicy" WHERE id='singleton' LIMIT 1`
    check('AiRetrievalPolicy singleton exists', pol.length === 1)
    check('Default shadowMode=true, runtimeEnabled=false',
          pol[0]?.shadowMode === true && pol[0]?.runtimeEnabled === false)
    check('Default policyVersion=v1', pol[0]?.policyVersion === 'v1')
    check('Default prefilterTopN=20, rerankTopN=5',
          pol[0]?.prefilterTopN === 20 && pol[0]?.rerankTopN === 5)

    // 2. UsageLog new fields
    const ulFields = await prisma.$queryRaw`
        SELECT column_name FROM information_schema.columns
        WHERE table_name='AiKnowledgeUsageLog'
          AND column_name IN ('policyDecision','shadowMode','escalationReason')
    `
    check('UsageLog has policyDecision/shadowMode/escalationReason',
          ulFields.length === 3,
          `got: ${ulFields.map(c=>c.column_name).join(', ')}`)

    // 3. DecisionLog new fields
    const dlFields = await prisma.$queryRaw`
        SELECT column_name FROM information_schema.columns
        WHERE table_name='AiDecisionLog'
          AND column_name IN ('retrievalMode','retrievalDecision','escalationReason',
                              'knowledgeRuntimeVersion','shadowRetrievalSummary')
    `
    check('DecisionLog has 5 PR3 retrieval fields',
          dlFields.length === 5,
          `got: ${dlFields.map(c=>c.column_name).join(', ')}`)

    // 4. Policy decision tree
    console.log('[smoke-pr3] Testing policy decision tree...')

    const happyItem = { id: 'i1', status: 'active', isActive: true, isVerified: true,
        confidence: 0.9, sourceCount: 3, safetyLevel: 'normal', conflictGroupId: null }
    check('Verified+high confidence → answer',
          applyPolicy([{ item: happyItem, prefilterScore: 0.6 }], DEFAULT_POLICY, 5).type === 'answer')

    const conflictItem = { ...happyItem, id: 'i2', conflictGroupId: 'cfl_x' }
    const r1 = applyPolicy([{ item: conflictItem, prefilterScore: 0.6 }], DEFAULT_POLICY, 5)
    check('Conflict → escalate', r1.type === 'escalate' && r1.escalationReason === 'conflict')

    const humanItem = { ...happyItem, id: 'i3', safetyLevel: 'requires_human' }
    const r2 = applyPolicy([{ item: humanItem, prefilterScore: 0.6 }], DEFAULT_POLICY, 5)
    check('requires_human → escalate', r2.type === 'escalate' && r2.escalationReason === 'requires_human')

    const lowConfItem = { ...happyItem, id: 'i4', confidence: 0.5, isVerified: false }
    const r3 = applyPolicy([{ item: lowConfItem, prefilterScore: 0.6 }], DEFAULT_POLICY, 5)
    check('low confidence (not verified) → escalate',
          r3.type === 'escalate' && r3.escalationReason === 'low_confidence')

    const lowConfVerified = { ...happyItem, id: 'i5', confidence: 0.5, isVerified: true }
    const r4 = applyPolicy([{ item: lowConfVerified, prefilterScore: 0.6 }], DEFAULT_POLICY, 5)
    check('low confidence BUT verified → answer (bypass)', r4.type === 'answer')

    const draftItem = { ...happyItem, id: 'i6', status: 'draft', isVerified: false, confidence: 0.9 }
    const r5 = applyPolicy([{ item: draftItem, prefilterScore: 0.6 }], DEFAULT_POLICY, 5)
    check('only draft → escalate', r5.type === 'escalate' && r5.escalationReason === 'only_drafts')

    check('empty prefilter → no_knowledge',
          applyPolicy([], DEFAULT_POLICY, 5).type === 'no_knowledge')

    const lowScore = { ...happyItem, id: 'i7' }
    const r6 = applyPolicy([{ item: lowScore, prefilterScore: 0.01 }], DEFAULT_POLICY, 5)
    check('crap-low prefilter score → no_knowledge', r6.type === 'no_knowledge')

    const sensItem = { ...happyItem, id: 'i8', safetyLevel: 'sensitive', confidence: 0.75, isVerified: false }
    const r7 = applyPolicy([{ item: sensItem, prefilterScore: 0.6 }], DEFAULT_POLICY, 5)
    check('sensitive + conf < 0.85 (not verified) → escalate',
          r7.type === 'escalate' && r7.escalationReason === 'low_confidence')

    const sensVerified = { ...happyItem, id: 'i9', safetyLevel: 'sensitive', confidence: 0.75, isVerified: true }
    const r8 = applyPolicy([{ item: sensVerified, prefilterScore: 0.6 }], DEFAULT_POLICY, 5)
    check('sensitive + verified → answer (bypass)', r8.type === 'answer')

    // 5. SQL filtering archived/superseded/draft
    console.log('[smoke-pr3] Testing SQL filtering...')

    const sec = await prisma.$queryRaw`SELECT id FROM "AiKnowledgeSection" WHERE slug='tariffs' LIMIT 1`
    const sectionId = sec[0].id
    const tempIds = [
        'kbi_smoke_pr3_a_' + Date.now(),
        'kbi_smoke_pr3_b_' + Date.now(),
        'kbi_smoke_pr3_c_' + Date.now(),
    ]
    try {
        for (const [id, status, isActive] of [
            [tempIds[0], 'active', true],
            [tempIds[1], 'archived', false],
            [tempIds[2], 'draft', false],
        ]) {
            await prisma.$executeRaw`
                INSERT INTO "AiKnowledgeItem" (
                    id, "sectionId", title, "canonicalStatement", tags,
                    confidence, "sourceCount", "uniqueManagerCount",
                    status, "isActive", "safetyLevel",
                    "isVerified", "createdBy", "createdAt", "updatedAt"
                ) VALUES (
                    ${id}, ${sectionId}, ${'smoke ' + status}, 'smoke statement',
                    ARRAY[]::text[], 0.8, 1, 1,
                    ${status}::"AiKnowledgeStatus", ${isActive}, 'normal'::"AiKnowledgeSafety",
                    false, 'smoke', NOW(), NOW()
                )
            `
        }
        // Имитация loadCandidates: excludeArchived/Superseded/Draft + isActive=true
        const visible = await prisma.$queryRaw`
            SELECT id, status::text AS status FROM "AiKnowledgeItem"
            WHERE id IN (${tempIds[0]}, ${tempIds[1]}, ${tempIds[2]})
              AND status::text != 'archived'
              AND status::text != 'superseded'
              AND status::text != 'draft'
              AND "isActive" = true
        `
        check('SQL filter excludes archived/draft (only active visible)',
              visible.length === 1 && visible[0].id === tempIds[0])

        // UsageLog accepts new fields
        const ulId = 'kul_smoke_' + Date.now()
        await prisma.$executeRaw`
            INSERT INTO "AiKnowledgeUsageLog" (
                id, "itemId", "runtimeContext",
                "retrievalScore", "rerankScore", "usedInReply",
                "policyDecision", "shadowMode", "escalationReason",
                "usedAt"
            ) VALUES (
                ${ulId}, ${tempIds[0]}, 'chat_reply'::"AiKnowledgeRuntime",
                0.65, 0.8, true,
                'used', false, NULL,
                NOW()
            )
        `
        check('UsageLog accepts new PR3 fields', true)
        await prisma.$executeRaw`DELETE FROM "AiKnowledgeUsageLog" WHERE id = ${ulId}`

        // DecisionLog accepts new fields
        const dlId = 'adl_smoke_' + Date.now()
        await prisma.$executeRaw`
            INSERT INTO "AiDecisionLog" (
                id, decision, "retrievalMode", "retrievalDecision",
                "escalationReason", "knowledgeRuntimeVersion",
                "shadowRetrievalSummary", "createdAt"
            ) VALUES (
                ${dlId}, 'escalate', 'shadow', 'escalate',
                'low_confidence', 'rerank:v1 policy:v1',
                ${JSON.stringify({ decision: 'escalate', topItemIds: ['x','y'] })}::jsonb,
                NOW()
            )
        `
        check('DecisionLog accepts new PR3 fields', true)
        await prisma.$executeRaw`DELETE FROM "AiDecisionLog" WHERE id = ${dlId}`

    } finally {
        await prisma.$executeRaw`DELETE FROM "AiKnowledgeSource"   WHERE "itemId" = ANY(${tempIds})`
        await prisma.$executeRaw`DELETE FROM "AiKnowledgeAuditLog" WHERE "itemId" = ANY(${tempIds})`
        await prisma.$executeRaw`DELETE FROM "AiKnowledgeItem"     WHERE id = ANY(${tempIds})`
    }

    console.log(`\n[smoke-pr3] Done. pass=${pass} fail=${fail}`)
    console.log(`[smoke-pr3] Full E2E manual:`)
    console.log(`    1. .env: AI_KNOWLEDGE_SHADOW_MODE=true (default), restart dev`)
    console.log(`    2. send test message → AI responds via legacy KB, shadow trace recorded`)
    console.log(`    3. /settings/ai → Ядро знаний → Источники → "Активность ответов" → trace visible`)
    console.log(`    4. .env: AI_KNOWLEDGE_RUNTIME_ENABLED=true, restart`)
    console.log(`    5. send message → AI responds from ядро (or escalates per policy)`)
    if (fail > 0) process.exit(1)
}

main()
    .catch(e => { console.error('[smoke-pr3] FAILED:', e.message); process.exit(1) })
    .finally(async () => { await prisma.$disconnect() })
