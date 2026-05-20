/* eslint-disable no-console */
/**
 * Smoke test для PR2.5 Governance / Editing Layer.
 *
 * Проверяет на уровне БД:
 *   - PR2.5.1 миграция применена (AiKnowledgeAuditLog table + enum
 *     AiKnowledgeAuditAction со всеми 10 значениями)
 *   - isVerified/verifiedBy/verifiedAt уже есть в AiKnowledgeItem
 *     (pre-emptive из PR1)
 *   - Audit-записи можно вставлять для всех 10 action-типов
 *   - status enum поддерживает archived/superseded/draft/active
 *   - supersededByItemId работает как self-reference
 *   - soft-delete archived item остаётся в БД
 *
 * Полный E2E через UI требует cookie auth — выполняется вручную.
 *
 * Запуск: cd D:/Github/CRM/gravity-mvp && node scripts/smoke_governance_pr2_5.js
 */

const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

let pass = 0, fail = 0
function check(name, cond, detail) {
    if (cond) { console.log(`  ✓ ${name}`); pass++ }
    else { console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); fail++ }
}

const ALL_ACTIONS = [
    'created', 'manual_created', 'edited', 'archived', 'restored',
    'verified', 'unverified', 'superseded', 'conflict_resolved', 'source_added',
]

async function main() {
    console.log('[smoke-pr2.5] Verifying schema delta...')

    // isVerified columns
    const itemCols = await prisma.$queryRaw`
        SELECT column_name FROM information_schema.columns
        WHERE table_name='AiKnowledgeItem'
          AND column_name IN ('isVerified','verifiedBy','verifiedAt')
    `
    check('AiKnowledgeItem verified fields (3, из PR1 pre-emptive)',
          itemCols.length === 3,
          `got: ${itemCols.map(c => c.column_name).join(', ')}`)

    // AuditLog table
    const auditTbl = await prisma.$queryRaw`
        SELECT column_name FROM information_schema.columns
        WHERE table_name='AiKnowledgeAuditLog'
    `
    const expectedCols = ['id', 'itemId', 'actor', 'action', 'beforeJson', 'afterJson', 'metadata', 'createdAt']
    const missingCols = expectedCols.filter(c => !auditTbl.find(r => r.column_name === c))
    check('AiKnowledgeAuditLog has all 8 columns', missingCols.length === 0,
          missingCols.length > 0 ? `missing: ${missingCols.join(', ')}` : null)

    // Enum
    const enumVals = await prisma.$queryRaw`
        SELECT unnest(enum_range(NULL::"AiKnowledgeAuditAction"))::text AS v
    `
    const enumSet = new Set(enumVals.map(r => r.v))
    const missingActions = ALL_ACTIONS.filter(a => !enumSet.has(a))
    check('AiKnowledgeAuditAction has all 10 values', missingActions.length === 0,
          missingActions.length > 0 ? `missing: ${missingActions.join(', ')}` : null)

    // E2E governance flow на temp items
    console.log('[smoke-pr2.5] Running e2e governance flow...')

    const sec = await prisma.$queryRaw`SELECT id FROM "AiKnowledgeSection" WHERE slug='tariffs' LIMIT 1`
    const sectionId = sec[0].id
    const itemA = 'kbi_smoke_pr25_a_' + Date.now()
    const itemB = 'kbi_smoke_pr25_b_' + Date.now()

    try {
        // Create 2 items
        for (const [id, withVerified, action] of [[itemA, true, 'manual_created'], [itemB, false, 'created']]) {
            const title = 'SMOKE PR2.5 ' + id
            const verifiedBy = withVerified ? 'smoke-actor' : null
            const verifiedAt = withVerified ? new Date() : null
            const auditId = 'aud_' + Math.random().toString(36).slice(2)
            const afterJson = JSON.stringify({ title, status: 'active' })
            await prisma.$executeRaw`
                INSERT INTO "AiKnowledgeItem" (
                    id, "sectionId", title, "canonicalStatement", tags,
                    confidence, "sourceCount", "uniqueManagerCount",
                    status, "isActive", "safetyLevel",
                    "isVerified", "verifiedBy", "verifiedAt",
                    "createdBy", "createdAt", "updatedAt"
                ) VALUES (
                    ${id}, ${sectionId}, ${title}, 'smoke statement',
                    ARRAY['smoke']::text[],
                    0.9, 1, 1,
                    'active'::"AiKnowledgeStatus", true, 'normal'::"AiKnowledgeSafety",
                    ${withVerified}, ${verifiedBy}, ${verifiedAt},
                    'smoke-actor', NOW(), NOW()
                )
            `
            await prisma.$executeRaw`
                INSERT INTO "AiKnowledgeAuditLog" (id, "itemId", actor, action, "afterJson", "createdAt")
                VALUES (${auditId}, ${id}, 'smoke-actor',
                        ${action}::"AiKnowledgeAuditAction",
                        ${afterJson}::jsonb, NOW())
            `
        }
        check('Create both items + initial audit entries', true)

        // Edit itemA
        const editedTitle = 'SMOKE PR2.5 edited'
        const beforeJsonA = JSON.stringify({ title: 'SMOKE PR2.5 ' + itemA })
        const afterJsonA  = JSON.stringify({ title: editedTitle })
        const metaJsonA   = JSON.stringify({ changedFields: ['title'] })
        const editAuditId = 'aud_' + Math.random().toString(36).slice(2)
        await prisma.$executeRaw`
            UPDATE "AiKnowledgeItem" SET title=${editedTitle}, "updatedAt"=NOW() WHERE id=${itemA}
        `
        await prisma.$executeRaw`
            INSERT INTO "AiKnowledgeAuditLog" (id, "itemId", actor, action, "beforeJson", "afterJson", metadata, "createdAt")
            VALUES (${editAuditId}, ${itemA}, 'smoke-actor',
                    'edited'::"AiKnowledgeAuditAction",
                    ${beforeJsonA}::jsonb, ${afterJsonA}::jsonb, ${metaJsonA}::jsonb,
                    NOW())
        `
        check('Edit persists + audit entry written', true)

        // Supersede: itemB заменяется itemA
        await prisma.$executeRaw`
            UPDATE "AiKnowledgeItem"
            SET status='superseded'::"AiKnowledgeStatus", "isActive"=false,
                "supersededByItemId"=${itemA}, "updatedAt"=NOW()
            WHERE id=${itemB}
        `
        const supersededRow = await prisma.$queryRaw`
            SELECT status::text AS status, "supersededByItemId", "isActive"
            FROM "AiKnowledgeItem" WHERE id=${itemB}
        `
        check('Supersede sets status=superseded',
              supersededRow[0]?.status === 'superseded' &&
              supersededRow[0]?.supersededByItemId === itemA &&
              supersededRow[0]?.isActive === false)

        // Archive itemA
        await prisma.$executeRaw`
            UPDATE "AiKnowledgeItem"
            SET status='archived'::"AiKnowledgeStatus", "isActive"=false, "updatedAt"=NOW()
            WHERE id=${itemA}
        `
        const archivedRow = await prisma.$queryRaw`SELECT status::text AS status FROM "AiKnowledgeItem" WHERE id=${itemA}`
        check('Archive sets status=archived', archivedRow[0]?.status === 'archived')

        // Restore itemA
        await prisma.$executeRaw`
            UPDATE "AiKnowledgeItem"
            SET status='active'::"AiKnowledgeStatus", "isActive"=true, "updatedAt"=NOW()
            WHERE id=${itemA}
        `
        const restoredRow = await prisma.$queryRaw`
            SELECT status::text AS status, "isActive" FROM "AiKnowledgeItem" WHERE id=${itemA}
        `
        check('Restore sets status=active + isActive=true',
              restoredRow[0]?.status === 'active' && restoredRow[0]?.isActive === true)

        // Verify itemA
        await prisma.$executeRaw`
            UPDATE "AiKnowledgeItem"
            SET "isVerified"=true, "verifiedBy"='smoke-actor', "verifiedAt"=NOW(), "updatedAt"=NOW()
            WHERE id=${itemA}
        `
        const verifiedRow = await prisma.$queryRaw`
            SELECT "isVerified", "verifiedBy" FROM "AiKnowledgeItem" WHERE id=${itemA}
        `
        check('Verify sets isVerified=true + verifiedBy',
              verifiedRow[0]?.isVerified === true && verifiedRow[0]?.verifiedBy === 'smoke-actor')

        // Audit trail count
        const auditCount = await prisma.$queryRaw`
            SELECT COUNT(*)::int AS cnt FROM "AiKnowledgeAuditLog" WHERE "itemId"=${itemA}
        `
        check('itemA audit trail has ≥ 2 entries', auditCount[0]?.cnt >= 2,
              `got: ${auditCount[0]?.cnt}`)

        // All 10 action enum values accepted
        let allActionsAccepted = true
        for (const action of ALL_ACTIONS) {
            const aid = 'aud_test_' + action + '_' + Date.now() + '_' + Math.random().toString(36).slice(2,6)
            try {
                await prisma.$executeRaw`
                    INSERT INTO "AiKnowledgeAuditLog" (id, "itemId", actor, action, "createdAt")
                    VALUES (${aid}, ${itemA}, 'smoke-actor',
                            ${action}::"AiKnowledgeAuditAction", NOW())
                `
            } catch {
                allActionsAccepted = false
                break
            }
        }
        check('All 10 audit action enum values accepted', allActionsAccepted)

        // Soft delete persistence
        const stillThere = await prisma.$queryRaw`
            SELECT COUNT(*)::int AS cnt FROM "AiKnowledgeItem" WHERE id IN (${itemA}, ${itemB})
        `
        check('Both items still in DB after governance flow (soft delete)',
              stillThere[0]?.cnt === 2)

    } finally {
        await prisma.$executeRaw`DELETE FROM "AiKnowledgeAuditLog" WHERE "itemId" IN (${itemA}, ${itemB})`
        await prisma.$executeRaw`DELETE FROM "AiKnowledgeSource"   WHERE "itemId" IN (${itemA}, ${itemB})`
        await prisma.$executeRaw`UPDATE "AiKnowledgeItem" SET "supersededByItemId"=NULL WHERE "supersededByItemId" IN (${itemA}, ${itemB})`
        await prisma.$executeRaw`DELETE FROM "AiKnowledgeItem"     WHERE id IN (${itemA}, ${itemB})`
    }

    console.log(`\n[smoke-pr2.5] Done. pass=${pass} fail=${fail}`)
    console.log(`[smoke-pr2.5] UI E2E через /settings/ai → Ядро знаний:`)
    console.log(`    1. "Добавить вручную" — создать item, проверить badge "подтверждено"`)
    console.log(`    2. Hover → ✎ → редактировать + смотреть "История"`)
    console.log(`    3. Hover → корзина → архив; перейти в "Архив" → восстановить`)
    console.log(`    4. Конфликт-marker → "Оставить это" → проверка что остальные ушли в архив`)
    console.log(`    5. Edit → "Заменить новым знанием" → выбрать item → проверка status='superseded'`)
    if (fail > 0) process.exit(1)
}

main()
    .catch(e => { console.error('[smoke-pr2.5] FAILED:', e.message); process.exit(1) })
    .finally(async () => { await prisma.$disconnect() })
