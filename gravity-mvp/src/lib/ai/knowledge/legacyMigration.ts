/* eslint-disable @typescript-eslint/no-explicit-any -- $queryRaw returns any[]. */
/**
 * AI Knowledge Core — legacy KB migration (PR5).
 *
 * Перенос ручной KnowledgeBaseEntry → AiKnowledgeItem. Legacy KB НЕ
 * удаляется — reversible path. Idempotent: повторный запуск
 * пропускает уже мигрированные (поиск по
 * AiKnowledgeAuditLog.metadata.migratedFromLegacyId).
 *
 * Cookie-context не требуется — `actor` принимается аргументом, чтобы
 * smoke мог дёрнуть core напрямую без server-action wrapper'а.
 */

import { prisma } from '@/lib/prisma'
import { writeAuditEntry, snapshotItem } from '@/lib/ai/knowledge/auditLog'

// ─── Mapping legacy → section ─────────────────────────────────────

/** Default mapping legacy `category` → AiKnowledgeSection slug.
 *  Эвристика — после миграции админ может переместить вручную через
 *  edit. Unknown категории идут в 'faq'. */
export const LEGACY_CATEGORY_MAP: Readonly<Record<string, string>> = Object.freeze({
    general:             'faq',
    payments:            'payouts',
    payouts:             'payouts',
    documents:           'documents',
    docs:                'documents',
    tariffs:             'tariffs',
    tariff:              'tariffs',
    requirements:        'requirements',
    driver_requirements: 'requirements',
    deposit:             'deposit',
    schedule:            'schedule',
    objections:          'objections',
    promises:            'promises',
    restrictions:        'restrictions',
    faq:                 'faq',
})

// ─── Types ────────────────────────────────────────────────────────

export interface LegacyMigrationPreview {
    legacyTotalActive:   number
    alreadyMigrated:     number
    toMigrate:           number
    bySection:           Array<{ sectionSlug: string; sectionTitle: string; count: number }>
}

export interface LegacyMigrationResult {
    migrated:   number
    skipped:    number
    failed:     number
    errors:     Array<{ legacyId: string; message: string }>
}

// ─── Preview ──────────────────────────────────────────────────────

export async function getLegacyMigrationPreviewCore(): Promise<LegacyMigrationPreview> {
    try {
        const entries = await prisma.$queryRaw<any[]>`
            SELECT id, category FROM "KnowledgeBaseEntry" WHERE active = true
        `
        const migratedIds = await prisma.$queryRaw<any[]>`
            SELECT DISTINCT metadata->>'migratedFromLegacyId' AS "legacyId"
            FROM "AiKnowledgeAuditLog"
            WHERE metadata ? 'migratedFromLegacyId'
        `
        const migratedSet = new Set<string>(migratedIds.map(r => r.legacyId).filter(Boolean))

        const sections = await prisma.$queryRaw<any[]>`
            SELECT id, slug, title FROM "AiKnowledgeSection" WHERE "isActive" = true
        `
        const slugToTitle = new Map<string, string>(sections.map(s => [s.slug, s.title]))

        const bySectionCount = new Map<string, number>()
        let toMigrate = 0
        for (const e of entries) {
            if (migratedSet.has(e.id)) continue
            toMigrate++
            const slug = LEGACY_CATEGORY_MAP[String(e.category ?? '').toLowerCase()] ?? 'faq'
            bySectionCount.set(slug, (bySectionCount.get(slug) ?? 0) + 1)
        }

        const bySection = [...bySectionCount.entries()].map(([slug, count]) => ({
            sectionSlug:  slug,
            sectionTitle: slugToTitle.get(slug) ?? slug,
            count,
        })).sort((a, b) => b.count - a.count)

        return {
            legacyTotalActive: entries.length,
            alreadyMigrated:   migratedSet.size,
            toMigrate,
            bySection,
        }
    } catch (e: any) {
        if (process.env.NODE_ENV !== 'production') {
            console.error('[legacy-migration] preview failed:', e?.message)
        }
        return { legacyTotalActive: 0, alreadyMigrated: 0, toMigrate: 0, bySection: [] }
    }
}

// ─── Migration ────────────────────────────────────────────────────

export async function migrateLegacyKnowledgeBaseCore(actor: string): Promise<LegacyMigrationResult> {
    const result: LegacyMigrationResult = { migrated: 0, skipped: 0, failed: 0, errors: [] }
    if (!actor) {
        result.errors.push({ legacyId: '*', message: 'actor (userId) обязателен' })
        return result
    }

    let entries: any[] = []
    try {
        entries = await prisma.$queryRaw<any[]>`
            SELECT id, title, category, answer, tags, priority
            FROM "KnowledgeBaseEntry" WHERE active = true
            ORDER BY priority DESC, "updatedAt" DESC
        `
    } catch (e: any) {
        result.errors.push({ legacyId: '*', message: 'Legacy KB не загружается: ' + (e?.message ?? 'unknown') })
        return result
    }
    if (entries.length === 0) return result

    const migratedIds = await prisma.$queryRaw<any[]>`
        SELECT DISTINCT metadata->>'migratedFromLegacyId' AS "legacyId"
        FROM "AiKnowledgeAuditLog"
        WHERE metadata ? 'migratedFromLegacyId'
    `
    const migratedSet = new Set<string>(migratedIds.map(r => r.legacyId).filter(Boolean))

    const sections = await prisma.$queryRaw<any[]>`
        SELECT id, slug FROM "AiKnowledgeSection" WHERE "isActive" = true
    `
    const slugToId = new Map<string, string>(sections.map(s => [s.slug, s.id]))
    const fallbackSectionId = slugToId.get('faq') ?? sections[0]?.id
    if (!fallbackSectionId) {
        result.errors.push({ legacyId: '*', message: 'Нет активных AiKnowledgeSection. Запустите seed.' })
        return result
    }

    for (const e of entries) {
        if (migratedSet.has(e.id)) { result.skipped++; continue }

        try {
            const slug = LEGACY_CATEGORY_MAP[String(e.category ?? '').toLowerCase()] ?? 'faq'
            const sectionId = slugToId.get(slug) ?? fallbackSectionId

            const itemId = 'kbi_lm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)
            const sourceId = 'kbs_lm_' + Math.random().toString(36).slice(2, 12)
            const excerptHash = 'legacy:' + e.id
            const tagSet = new Set<string>(['type:manual', 'source:legacy'])
            for (const t of (e.tags ?? [])) {
                if (typeof t === 'string' && t.trim() && !t.startsWith('type:')) tagSet.add(t)
            }
            const tags = [...tagSet]

            const statement = String(e.answer ?? '').trim()
            const title = String(e.title ?? '').trim() || statement.slice(0, 60) + '…'
            if (!statement) {
                result.failed++
                result.errors.push({ legacyId: e.id, message: 'Пустой answer' })
                continue
            }

            await prisma.$executeRawUnsafe(
                `INSERT INTO "AiKnowledgeItem" (
                    id, "sectionId", title, "canonicalStatement", tags,
                    confidence, "sourceCount", "uniqueManagerCount",
                    status, "isActive", "safetyLevel",
                    "isVerified", "verifiedBy", "verifiedAt",
                    "createdBy", "createdAt", "updatedAt"
                 ) VALUES (
                    $1, $2, $3, $4, $5::text[],
                    0.95, 1, 1,
                    'active'::"AiKnowledgeStatus", true, 'normal'::"AiKnowledgeSafety",
                    true, $6, NOW(), $7, NOW(), NOW()
                 )`,
                itemId,
                sectionId,
                title,
                statement,
                tags,
                actor,
                actor,
            )
            await prisma.$executeRawUnsafe(
                `INSERT INTO "AiKnowledgeSource" (
                    id, "itemId", "originType",
                    "messageId", "chatId", channel, "managerUserId",
                    excerpt, "excerptHash", confidence, "occurredAt", "createdAt"
                 ) VALUES (
                    $1, $2, 'manual_entry', NULL, NULL, NULL, $3,
                    $4, $5, 1.0, NOW(), NOW()
                 )`,
                sourceId,
                itemId,
                actor,
                '[мигрировано из legacy KB: ' + title + ']',
                excerptHash,
            )
            // Load freshly inserted snapshot для audit.after.
            const afterRows = await prisma.$queryRaw<any[]>`
                SELECT
                    id, "sectionId", title, "canonicalStatement", tags,
                    confidence, "sourceCount", "uniqueManagerCount",
                    status::text AS status, "isActive",
                    "safetyLevel"::text AS "safetyLevel",
                    "supersededByItemId", "conflictGroupId",
                    "isVerified", "verifiedBy", "verifiedAt"
                FROM "AiKnowledgeItem" WHERE id = ${itemId} LIMIT 1
            `
            await writeAuditEntry({
                itemId, actor, action: 'manual_created',
                before: null, after: snapshotItem(afterRows[0]),
                metadata: {
                    migratedFromLegacyId: e.id,
                    legacyTitle:          title,
                    legacyCategory:       e.category ?? null,
                    targetSectionSlug:    slug,
                },
            })
            result.migrated++
        } catch (err: any) {
            result.failed++
            result.errors.push({ legacyId: e.id, message: err?.message ?? 'unknown' })
        }
    }

    return result
}
