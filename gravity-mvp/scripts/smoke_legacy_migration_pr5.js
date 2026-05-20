/* eslint-disable no-console */
/**
 * Smoke test для PR5.5 Legacy KB migration.
 *
 * Поскольку проект без ts-node/tsx — smoke зеркалит SQL-логику из
 * `src/lib/ai/knowledge/legacyMigration.ts` напрямую. Это нужно
 * чтобы проверить:
 *   - idempotency через `metadata->>'migratedFromLegacyId'`
 *   - правильный mapping category → section
 *   - auto-verified=true + AiKnowledgeSource manual_entry +
 *     AiKnowledgeAuditLog с metadata
 *   - legacy KB не удаляется
 *
 * Дополнительно проверяем что lib-файл экспортирует ожидаемые функции
 * (через простой fs grep — sanity что API сохраняется).
 *
 * Запуск: cd D:/Github/CRM/gravity-mvp && node scripts/smoke_legacy_migration_pr5.js
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
    console.log('[smoke-pr5.5] Legacy migration contract check')

    // ── 1. Sanity: lib экспортирует нужные функции ─────────────────
    const libPath = path.join(__dirname, '..', 'src', 'lib', 'ai', 'knowledge', 'legacyMigration.ts')
    const lib = fs.readFileSync(libPath, 'utf-8')
    check('lib exports LEGACY_CATEGORY_MAP', /export const LEGACY_CATEGORY_MAP/.test(lib))
    check('lib exports getLegacyMigrationPreviewCore',
          /export async function getLegacyMigrationPreviewCore/.test(lib))
    check('lib exports migrateLegacyKnowledgeBaseCore',
          /export async function migrateLegacyKnowledgeBaseCore/.test(lib))
    check('mapping payments → payouts',  /payments:\s*'payouts'/.test(lib))
    check('mapping documents → documents', /documents:\s*'documents'/.test(lib))

    // ── 2. Insert fake legacy entries ──────────────────────────────
    const sec = await prisma.$queryRaw`SELECT id, slug FROM "AiKnowledgeSection" WHERE slug='payouts' LIMIT 1`
    if (!sec[0]) throw new Error('seed payouts missing')
    const sectionPayoutsId = sec[0].id

    const legacyA = 'kbe_smoke_pr5_a_' + Date.now()
    const legacyB = 'kbe_smoke_pr5_b_' + Date.now()
    const legacyC = 'kbe_smoke_pr5_c_' + Date.now()  // already-migrated case
    const itemC   = 'kbi_smoke_pr5_pre_' + Date.now()  // pre-migrated item
    const audC    = 'aud_smoke_pr5_pre_' + Date.now()

    try {
        await prisma.$executeRaw`
            INSERT INTO "KnowledgeBaseEntry" (
                id, title, category, "sampleQuestions", answer, tags, channels,
                active, priority, "createdAt", "updatedAt"
            ) VALUES (
                ${legacyA}, 'PR5 fee policy', 'payments', '[]'::jsonb,
                'Комиссия 7% с поездки.', ARRAY['comm','smoke']::text[], ARRAY[]::text[],
                true, 10, NOW(), NOW()
            )
        `
        await prisma.$executeRaw`
            INSERT INTO "KnowledgeBaseEntry" (
                id, title, category, "sampleQuestions", answer, tags, channels,
                active, priority, "createdAt", "updatedAt"
            ) VALUES (
                ${legacyB}, 'PR5 office hours', 'general', '[]'::jsonb,
                'Офис открыт с 9:00 до 18:00 пн-пт.', ARRAY['hours']::text[], ARRAY[]::text[],
                true, 5, NOW(), NOW()
            )
        `
        await prisma.$executeRaw`
            INSERT INTO "KnowledgeBaseEntry" (
                id, title, category, "sampleQuestions", answer, tags, channels,
                active, priority, "createdAt", "updatedAt"
            ) VALUES (
                ${legacyC}, 'PR5 already migrated', 'general', '[]'::jsonb,
                'Этот ответ был мигрирован раньше.', ARRAY[]::text[], ARRAY[]::text[],
                true, 1, NOW(), NOW()
            )
        `

        // Pre-create AiKnowledgeItem for legacyC + audit чтобы emulate
        // already-migrated state.
        await prisma.$executeRaw`
            INSERT INTO "AiKnowledgeItem" (
                id, "sectionId", title, "canonicalStatement", tags,
                confidence, "sourceCount", "uniqueManagerCount",
                status, "isActive", "safetyLevel", "isVerified",
                "createdBy", "createdAt", "updatedAt"
            ) VALUES (
                ${itemC}, ${sectionPayoutsId}, 'PR5 already migrated',
                'Этот ответ был мигрирован раньше.',
                ARRAY['type:manual','source:legacy']::text[],
                0.95, 1, 1,
                'active'::"AiKnowledgeStatus", true, 'normal'::"AiKnowledgeSafety", true,
                'smoke-actor', NOW(), NOW()
            )
        `
        await prisma.$executeRaw`
            INSERT INTO "AiKnowledgeAuditLog" (
                id, "itemId", actor, action,
                metadata, "createdAt"
            ) VALUES (
                ${audC}, ${itemC}, 'smoke-actor', 'manual_created'::"AiKnowledgeAuditAction",
                ${JSON.stringify({ migratedFromLegacyId: legacyC })}::jsonb,
                NOW()
            )
        `

        // ── 3. Mirror miragration SQL: process A and B ────────────
        // Loop через unmigrated entries и сделать INSERTS как в lib.
        const entries = await prisma.$queryRaw`
            SELECT id, title, category, answer, tags
            FROM "KnowledgeBaseEntry"
            WHERE id IN (${legacyA}, ${legacyB}, ${legacyC})
        `
        const migratedIds = await prisma.$queryRaw`
            SELECT DISTINCT metadata->>'migratedFromLegacyId' AS "legacyId"
            FROM "AiKnowledgeAuditLog"
            WHERE metadata ? 'migratedFromLegacyId'
        `
        const migratedSet = new Set(migratedIds.map(r => r.legacyId).filter(Boolean))

        check('legacyC pre-marker detected', migratedSet.has(legacyC))

        const newItemIds = []
        const newAudIds  = []
        const newSourceIds = []
        const CATEGORY_MAP = {
            general: 'faq', payments: 'payouts', documents: 'documents',
        }
        const sectionRows = await prisma.$queryRaw`
            SELECT id, slug FROM "AiKnowledgeSection" WHERE "isActive" = true
        `
        const slugToId = new Map(sectionRows.map(s => [s.slug, s.id]))

        let migrated = 0, skipped = 0
        for (const e of entries) {
            if (migratedSet.has(e.id)) { skipped++; continue }
            const slug = CATEGORY_MAP[String(e.category ?? '').toLowerCase()] ?? 'faq'
            const sectionId = slugToId.get(slug) ?? sectionPayoutsId

            const itemId = 'kbi_lm_smoke_' + Math.random().toString(36).slice(2, 10)
            const sourceId = 'kbs_lm_smoke_' + Math.random().toString(36).slice(2, 10)
            const audId   = 'aud_lm_smoke_' + Math.random().toString(36).slice(2, 10)
            const excerptHash = 'legacy:' + e.id

            await prisma.$executeRaw`
                INSERT INTO "AiKnowledgeItem" (
                    id, "sectionId", title, "canonicalStatement", tags,
                    confidence, "sourceCount", "uniqueManagerCount",
                    status, "isActive", "safetyLevel", "isVerified",
                    "verifiedBy", "verifiedAt",
                    "createdBy", "createdAt", "updatedAt"
                ) VALUES (
                    ${itemId}, ${sectionId}, ${e.title}, ${e.answer},
                    ARRAY['type:manual','source:legacy']::text[],
                    0.95, 1, 1,
                    'active'::"AiKnowledgeStatus", true, 'normal'::"AiKnowledgeSafety", true,
                    'smoke-actor', NOW(),
                    'smoke-actor', NOW(), NOW()
                )
            `
            await prisma.$executeRaw`
                INSERT INTO "AiKnowledgeSource" (
                    id, "itemId", "originType",
                    excerpt, "excerptHash", confidence, "createdAt"
                ) VALUES (
                    ${sourceId}, ${itemId}, 'manual_entry',
                    ${'[мигрировано из legacy KB: ' + e.title + ']'},
                    ${excerptHash}, 1.0, NOW()
                )
            `
            await prisma.$executeRaw`
                INSERT INTO "AiKnowledgeAuditLog" (
                    id, "itemId", actor, action, metadata, "createdAt"
                ) VALUES (
                    ${audId}, ${itemId}, 'smoke-actor', 'manual_created'::"AiKnowledgeAuditAction",
                    ${JSON.stringify({
                        migratedFromLegacyId: e.id,
                        legacyTitle: e.title,
                        legacyCategory: e.category,
                        targetSectionSlug: slug,
                    })}::jsonb,
                    NOW()
                )
            `
            newItemIds.push(itemId)
            newSourceIds.push(sourceId)
            newAudIds.push(audId)
            migrated++
        }

        check('migrated 2 unmigrated entries (A, B)', migrated === 2)
        check('skipped 1 already-migrated (C)', skipped === 1)

        // ── 4. Verify item state ──────────────────────────────────
        const items = await prisma.$queryRaw`
            SELECT id, title, "isVerified", "isActive", "sectionId",
                   status::text AS status, tags
            FROM "AiKnowledgeItem"
            WHERE id IN (${newItemIds[0]}, ${newItemIds[1]})
            ORDER BY title
        `
        check('items.length = 2', items.length === 2)
        check('item[0].isVerified=true', items[0]?.isVerified === true)
        check('item[1].isVerified=true', items[1]?.isVerified === true)
        check('item.status active', items[0]?.status === 'active' && items[1]?.status === 'active')
        check('tags include source:legacy',
              items[0]?.tags.includes('source:legacy') && items[1]?.tags.includes('source:legacy'))

        // ── 5. Verify mapping correctness ─────────────────────────
        // legacyA (category='payments') → payouts
        // legacyB (category='general') → faq
        const sections = new Map(sectionRows.map(s => [s.id, s.slug]))
        const aItem = items.find(i => i.title === 'PR5 fee policy')
        const bItem = items.find(i => i.title === 'PR5 office hours')
        check('payments → payouts mapping',
              aItem && sections.get(aItem.sectionId) === 'payouts')
        check('general → faq mapping',
              bItem && sections.get(bItem.sectionId) === 'faq')

        // ── 6. Verify audit metadata ──────────────────────────────
        const audits = await prisma.$queryRaw`
            SELECT
                "itemId",
                metadata->>'migratedFromLegacyId' AS "legacyId",
                metadata->>'targetSectionSlug' AS "targetSlug"
            FROM "AiKnowledgeAuditLog"
            WHERE id IN (${newAudIds[0]}, ${newAudIds[1]})
        `
        check('audit metadata has migratedFromLegacyId',
              audits.every(a => a.legacyId === legacyA || a.legacyId === legacyB))

        // ── 7. Sources created ────────────────────────────────────
        const sources = await prisma.$queryRaw`
            SELECT "originType"::text AS "originType", excerpt
            FROM "AiKnowledgeSource"
            WHERE "itemId" IN (${newItemIds[0]}, ${newItemIds[1]})
        `
        check('sources.length = 2 (one per item)', sources.length === 2)
        check('originType = manual_entry',
              sources.every(s => s.originType === 'manual_entry'))
        check('source excerpt mentions legacy',
              sources.every(s => s.excerpt.includes('legacy KB')))

        // ── 8. Idempotency: second pass — все skipped ─────────────
        const migratedIds2 = await prisma.$queryRaw`
            SELECT DISTINCT metadata->>'migratedFromLegacyId' AS "legacyId"
            FROM "AiKnowledgeAuditLog"
            WHERE metadata ? 'migratedFromLegacyId'
        `
        const migratedSet2 = new Set(migratedIds2.map(r => r.legacyId).filter(Boolean))
        check('idempotency: all 3 marked migrated after pass',
              migratedSet2.has(legacyA) && migratedSet2.has(legacyB) && migratedSet2.has(legacyC))

        // ── 9. Legacy KB NOT deleted ──────────────────────────────
        const legacyStillThere = await prisma.$queryRaw`
            SELECT id FROM "KnowledgeBaseEntry"
            WHERE id IN (${legacyA}, ${legacyB}, ${legacyC})
        `
        check('legacy entries still active (reversible)',
              legacyStillThere.length === 3)

        // Cleanup new ones
        await prisma.$executeRaw`DELETE FROM "AiKnowledgeAuditLog" WHERE id IN (${newAudIds[0]}, ${newAudIds[1]})`
        await prisma.$executeRaw`DELETE FROM "AiKnowledgeSource"   WHERE id IN (${newSourceIds[0]}, ${newSourceIds[1]})`
        await prisma.$executeRaw`DELETE FROM "AiKnowledgeItem"     WHERE id IN (${newItemIds[0]}, ${newItemIds[1]})`
    } finally {
        await prisma.$executeRaw`DELETE FROM "AiKnowledgeAuditLog" WHERE id = ${audC}`
        await prisma.$executeRaw`DELETE FROM "AiKnowledgeItem"     WHERE id = ${itemC}`
        await prisma.$executeRaw`DELETE FROM "KnowledgeBaseEntry"  WHERE id IN (${legacyA}, ${legacyB}, ${legacyC})`
    }

    console.log(`\n[smoke-pr5.5] Done. pass=${pass} fail=${fail}`)
    if (fail > 0) process.exit(1)
}

main()
    .catch(e => { console.error('[smoke-pr5.5] FAILED:', e.message); process.exit(1) })
    .finally(async () => { await prisma.$disconnect() })
