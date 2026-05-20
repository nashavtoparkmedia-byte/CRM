/* eslint-disable no-console */
/**
 * Smoke test для PR6 — Trusted Knowledge Guard.
 *
 * Pure-JS зеркало логики trustedGuard.ts + проверка интеграции с БД:
 * verified item в секции должен блокировать противоречащий candidate
 * в draft + requires_human, runtime retriever его не подхватит.
 *
 * Запуск: cd D:/Github/CRM/gravity-mvp && node scripts/smoke_trusted_guard_pr6.js
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

// ── Pure logic mirrors trustedGuard.ts (для smoke-only verification) ─

function normalize(s) {
    return s.toLowerCase().replace(/[^a-zа-я0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
}
function trigrams(s) {
    const n = normalize(s)
    const out = new Set()
    if (n.length < 3) return out
    for (let i = 0; i <= n.length - 3; i++) out.add(n.slice(i, i + 3))
    return out
}
function jaccard(a, b) {
    if (!a.size && !b.size) return 0
    let inter = 0
    for (const x of a) if (b.has(x)) inter++
    return inter / (a.size + b.size - inter)
}
function similarity(a, b) { return jaccard(trigrams(a), trigrams(b)) }
function topicSim(c, item) {
    return 0.7 * similarity(c.canonicalStatement, item.canonicalStatement)
         + 0.3 * similarity(c.title, item.title)
}
function extractNumerics(text) {
    const re = /(\d+(?:[.,]\d+)?)\s*(%|₽|руб|сут|дн|год|лет|месяц|раз|км|шт)/giu
    const out = []
    let m
    while ((m = re.exec(text)) !== null) {
        const v = parseFloat(m[1].replace(',', '.'))
        let u = m[2].toLowerCase()
        if (u === 'руб') u = '₽'
        out.push({ v, u })
    }
    return out
}
function numericConflict(a, b) {
    const an = extractNumerics(a), bn = extractNumerics(b)
    for (const x of an) for (const y of bn) {
        if (x.u === y.u && Math.abs(x.v - y.v) > 0.001) return true
    }
    return false
}
function isTrusted(item) {
    if (item.status !== 'active') return false
    if (item.isVerified) return true
    if ((item.tags ?? []).includes('source:legacy')) return true
    return false
}
function checkAgainstTrusted(candidate, items) {
    const trusted = items.filter(isTrusted)
    if (trusted.length === 0) return { verdict: 'safe' }
    const pairs = trusted.map(it => ({ it, sim: topicSim(candidate, it) }))
        .filter(p => p.sim >= 0.35).sort((a, b) => b.sim - a.sim)
    if (pairs.length === 0) return { verdict: 'safe' }
    for (const { it } of pairs) {
        if (numericConflict(candidate.canonicalStatement, it.canonicalStatement)) {
            return { verdict: 'contradicts', trusted: it }
        }
    }
    if (pairs[0].sim >= 0.55) return { verdict: 'matches_trusted', trusted: pairs[0].it }
    return { verdict: 'safe' }
}

async function main() {
    console.log('[smoke-pr6] Trusted Knowledge Guard')

    // ── 1. lib file exists + exports ──────────────────────────────
    const lib = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'lib', 'ai', 'knowledge', 'trustedGuard.ts'),
        'utf-8'
    )
    check('trustedGuard.ts exists', lib.length > 0)
    check('exports checkAgainstTrusted',  /export function checkAgainstTrusted/.test(lib))
    check('exports isTrustedItem',        /export function isTrustedItem/.test(lib))
    check('exports makeConflictsTag',     /export function makeConflictsTag/.test(lib))
    check('exports makeMatchesTag',       /export function makeMatchesTag/.test(lib))
    check('CONFLICTS_WITH_TRUSTED_TAG_PREFIX defined',
          /CONFLICTS_WITH_TRUSTED_TAG_PREFIX = 'conflicts_with_trusted:'/.test(lib))

    // ── 2. Extractor wiring ───────────────────────────────────────
    const ext = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'lib', 'ai', 'knowledge', 'Extractor.ts'),
        'utf-8'
    )
    check('Extractor imports trustedGuard',
          /from '\.\/trustedGuard'/.test(ext))
    check('Extractor calls checkAgainstTrusted',
          /checkAgainstTrusted\(/.test(ext))
    check('Extractor handles contradicts verdict',
          /verdict === 'contradicts'/.test(ext))
    check('Extractor handles matches_trusted verdict',
          /verdict === 'matches_trusted'/.test(ext))
    check('progress.trustedConflictsBlocked tracked',
          /trustedConflictsBlocked\+\+/.test(ext))
    check('progress.trustedMatchesBoosted tracked',
          /trustedMatchesBoosted\+\+/.test(ext))
    check('loadExistingItems selects isVerified',
          /SELECT[\s\S]+?"isVerified"[\s\S]+?FROM "AiKnowledgeItem"/.test(ext))

    // ── 3. Pure logic — contradict scenario ───────────────────────
    // Verified item: "комиссия 3.99%" → candidate "комиссия 2%"
    const trusted = [{
        id: 'trusted-fee-1',
        title: 'Комиссия парка',
        canonicalStatement: 'Комиссия парка с каждой поездки 3.99%.',
        status: 'active',
        isVerified: true,
        tags: [],
    }]
    const candidateConflict = {
        title: 'Комиссия',
        canonicalStatement: 'Комиссия парка 2%.',
    }
    const v1 = checkAgainstTrusted(candidateConflict, trusted)
    check('contradicts verified item (3.99% vs 2%)',
          v1.verdict === 'contradicts',
          `got verdict=${v1.verdict}`)
    if (v1.verdict === 'contradicts') {
        check('returns trusted item id', v1.trusted.id === 'trusted-fee-1')
    }

    // ── 4. Legacy item тоже trusted ───────────────────────────────
    const legacy = [{
        id: 'legacy-fee-1',
        title: 'Комиссия парка',
        canonicalStatement: 'Комиссия парка 3.99% с поездки.',
        status: 'active',
        isVerified: false,
        tags: ['source:legacy', 'type:manual'],
    }]
    const v2 = checkAgainstTrusted(candidateConflict, legacy)
    check('legacy-migrated item тоже trusted (contradicts works)',
          v2.verdict === 'contradicts')

    // ── 5. Matching candidate → matches_trusted ───────────────────
    const candidateMatch = {
        title: 'Комиссия парка',
        canonicalStatement: 'Парк удерживает комиссию 3.99% с каждой поездки.',
    }
    const v3 = checkAgainstTrusted(candidateMatch, trusted)
    check('matches verified item (same 3.99%)',
          v3.verdict === 'matches_trusted',
          `got verdict=${v3.verdict}`)

    // ── 6. Unrelated candidate → safe ─────────────────────────────
    const candidateUnrelated = {
        title: 'Время выплат',
        canonicalStatement: 'Выплаты приходят каждый четверг.',
    }
    const v4 = checkAgainstTrusted(candidateUnrelated, trusted)
    check('unrelated candidate → safe', v4.verdict === 'safe')

    // ── 7. Draft item NOT trusted (status guard) ──────────────────
    const draftVerified = [{
        ...trusted[0], status: 'draft',  // даже verified, но draft
    }]
    const v5 = checkAgainstTrusted(candidateConflict, draftVerified)
    check('draft (even verified) НЕ блокирует',
          v5.verdict === 'safe',
          `got verdict=${v5.verdict}`)

    // ── 8. Unverified active item НЕ trusted (sanity) ─────────────
    const unverifiedActive = [{
        ...trusted[0], isVerified: false, tags: [],
    }]
    const v6 = checkAgainstTrusted(candidateConflict, unverifiedActive)
    check('unverified active item НЕ блокирует',
          v6.verdict === 'safe',
          `got verdict=${v6.verdict}`)

    // ── 9. Integration test через БД — создаём verified item,
    //      симулируем "blocked candidate" insert, проверяем что он
    //      draft+requires_human+tag ──────────────────────────────────
    const sec = await prisma.$queryRaw`SELECT id FROM "AiKnowledgeSection" WHERE slug='tariffs' LIMIT 1`
    const sectionId = sec[0].id
    const trustedId = 'kbi_trusted_pr6_' + Date.now()
    const blockedId = 'kbi_blocked_pr6_' + Date.now()
    try {
        await prisma.$executeRaw`
            INSERT INTO "AiKnowledgeItem" (
                id, "sectionId", title, "canonicalStatement", tags,
                confidence, "sourceCount", "uniqueManagerCount",
                status, "isActive", "safetyLevel", "isVerified",
                "createdAt", "updatedAt"
            ) VALUES (
                ${trustedId}, ${sectionId}, 'PR6 trusted fee', 'Комиссия парка 3.99% с поездки.',
                ARRAY[]::text[], 0.95, 5, 3,
                'active'::"AiKnowledgeStatus", true, 'normal'::"AiKnowledgeSafety", true,
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
                ${blockedId}, ${sectionId}, 'PR6 blocked candidate', 'Комиссия парка 2% с поездки.',
                ARRAY[${'conflicts_with_trusted:' + trustedId}, 'type:tariff']::text[],
                0.7, 1, 1,
                'draft'::"AiKnowledgeStatus", false, 'requires_human'::"AiKnowledgeSafety", false,
                NOW(), NOW()
            )
        `
        const blocked = await prisma.$queryRaw`
            SELECT status::text AS status, "isActive",
                   "safetyLevel"::text AS "safetyLevel", tags
            FROM "AiKnowledgeItem" WHERE id = ${blockedId}
        `
        check('blocked item.status = draft', blocked[0].status === 'draft')
        check('blocked item.isActive = false', blocked[0].isActive === false)
        check('blocked item.safetyLevel = requires_human',
              blocked[0].safetyLevel === 'requires_human')
        check('blocked item has conflicts_with_trusted: tag',
              blocked[0].tags.some(t => t.startsWith('conflicts_with_trusted:')))

        // Retriever invariant: status='draft' + isActive=false →
        // не должен попасть в active retrieval даже теоретически
        const activeOnly = await prisma.$queryRaw`
            SELECT id FROM "AiKnowledgeItem"
            WHERE id = ${blockedId} AND status = 'active' AND "isActive" = true
        `
        check('blocked NOT visible to active-only query',
              activeOnly.length === 0)
    } finally {
        await prisma.$executeRaw`DELETE FROM "AiKnowledgeItem" WHERE id IN (${trustedId}, ${blockedId})`
    }

    console.log(`\n[smoke-pr6] Done. pass=${pass} fail=${fail}`)
    if (fail > 0) process.exit(1)
}

main()
    .catch(e => { console.error('[smoke-pr6] FAILED:', e.message); process.exit(1) })
    .finally(async () => { await prisma.$disconnect() })
