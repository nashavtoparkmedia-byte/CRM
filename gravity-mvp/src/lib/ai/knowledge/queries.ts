/* eslint-disable @typescript-eslint/no-explicit-any -- $queryRaw returns any[]. */
/**
 * AI Knowledge Core — read-only queries.
 *
 * PR1 (foundation): только чтение. write/edit/extraction появятся в PR2+.
 * Pipeline ответа (ContextBuilder → ResponseGenerator) этот модуль не
 * вызывает — он будет подцеплен только в PR3 retriever'ом за feature flag.
 *
 * Все функции graceful: при отсутствии таблицы (если миграция не
 * применена) возвращают пустой результат, а не падают.
 */

import { prisma } from '@/lib/prisma'

// ─── Типы (camelCase, как в Prisma client) ────────────────────────

export interface KnowledgeSection {
    id:          string
    slug:        string
    title:       string
    description: string | null
    iconKey:     string | null
    sortOrder:   number
    isActive:    boolean
    createdAt:   string
    updatedAt:   string
    /** Кол-во активных items в секции. */
    itemCount:   number
}

export interface KnowledgeItem {
    id:                  string
    sectionId:           string
    title:               string
    canonicalStatement:  string
    tags:                string[]
    confidence:          number
    sourceCount:         number
    uniqueManagerCount:  number
    status:              'active' | 'archived' | 'superseded' | 'draft' | 'needs_review'
    isActive:            boolean
    safetyLevel:         'normal' | 'sensitive' | 'requires_human'
    supersededByItemId:  string | null
    conflictGroupId:     string | null
    isVerified:          boolean
    verifiedBy:          string | null
    verifiedAt:          string | null
    createdBy:           string | null
    lastUsedAt:          string | null
    createdAt:           string
    updatedAt:           string
}

export interface KnowledgeSource {
    id:            string
    itemId:        string
    originType:    'chat_message' | 'voice_transcript' | 'manual_entry' | 'doc_section'
    messageId:     string | null
    chatId:        string | null
    channel:       string | null
    managerUserId: string | null
    excerpt:       string
    confidence:    number
    occurredAt:    string | null
    createdAt:     string
}

export interface KnowledgeStats {
    /** Активные items (status='active' AND isActive=true). */
    activeItems:      number
    /** Архивные items (status IN ('archived','superseded')). */
    archivedItems:    number
    /** Draft items: не прошли activation rule. */
    draftItems:       number
    /** Total sources — мера "доказательной базы" ядра. */
    totalSources:     number
    /** Сколько extraction-jobs запускалось всего. */
    extractionJobs:   number
    /** Активные секции (isActive=true). */
    activeSections:   number
    /** Items с conflictGroupId — требуют внимания админа. */
    conflictingItems: number
}

// ─── Чтения ───────────────────────────────────────────────────────

export async function listKnowledgeSections(): Promise<KnowledgeSection[]> {
    try {
        return await prisma.$queryRaw<KnowledgeSection[]>`
            SELECT
                s.id, s.slug, s.title, s.description,
                s."iconKey", s."sortOrder", s."isActive",
                s."createdAt", s."updatedAt",
                COALESCE(c.cnt, 0)::int AS "itemCount"
            FROM "AiKnowledgeSection" s
            LEFT JOIN (
                SELECT "sectionId", COUNT(*) AS cnt
                FROM "AiKnowledgeItem"
                WHERE status = 'active' AND "isActive" = true
                GROUP BY "sectionId"
            ) c ON c."sectionId" = s.id
            ORDER BY s."isActive" DESC, s."sortOrder" ASC, s.title ASC
        `
    } catch {
        return []
    }
}

export async function listItemsBySection(
    sectionId: string,
    opts: { includeArchived?: boolean } = {}
): Promise<KnowledgeItem[]> {
    const includeArchived = opts.includeArchived === true
    try {
        if (includeArchived) {
            return await prisma.$queryRaw<KnowledgeItem[]>`
                SELECT *
                FROM "AiKnowledgeItem"
                WHERE "sectionId" = ${sectionId}
                  AND (status IN ('archived', 'superseded') OR "isActive" = false)
                ORDER BY "updatedAt" DESC
            `
        }
        return await prisma.$queryRaw<KnowledgeItem[]>`
            SELECT *
            FROM "AiKnowledgeItem"
            WHERE "sectionId" = ${sectionId}
              AND status = 'active'
              AND "isActive" = true
            ORDER BY "confidence" DESC, "updatedAt" DESC
        `
    } catch {
        return []
    }
}

export async function getItemWithSources(
    itemId: string
): Promise<{ item: KnowledgeItem | null; sources: KnowledgeSource[] }> {
    try {
        const itemRows = await prisma.$queryRaw<KnowledgeItem[]>`
            SELECT * FROM "AiKnowledgeItem" WHERE id = ${itemId} LIMIT 1
        `
        const item = itemRows[0] ?? null
        if (!item) return { item: null, sources: [] }
        const sources = await prisma.$queryRaw<KnowledgeSource[]>`
            SELECT * FROM "AiKnowledgeSource"
            WHERE "itemId" = ${itemId}
            ORDER BY "confidence" DESC, "createdAt" DESC
            LIMIT 50
        `
        return { item, sources }
    } catch {
        return { item: null, sources: [] }
    }
}

export async function getKnowledgeStats(): Promise<KnowledgeStats> {
    const empty: KnowledgeStats = {
        activeItems: 0, archivedItems: 0, draftItems: 0,
        totalSources: 0, extractionJobs: 0, activeSections: 0,
        conflictingItems: 0,
    }
    try {
        const rows = await prisma.$queryRaw<any[]>`
            SELECT
                (SELECT COUNT(*) FROM "AiKnowledgeItem"
                    WHERE status = 'active' AND "isActive" = true)         AS "activeItems",
                (SELECT COUNT(*) FROM "AiKnowledgeItem"
                    WHERE status IN ('archived','superseded'))             AS "archivedItems",
                (SELECT COUNT(*) FROM "AiKnowledgeItem"
                    WHERE status = 'draft')                                AS "draftItems",
                (SELECT COUNT(*) FROM "AiKnowledgeSource")                 AS "totalSources",
                (SELECT COUNT(*) FROM "AiExtractionJob")                   AS "extractionJobs",
                (SELECT COUNT(*) FROM "AiKnowledgeSection"
                    WHERE "isActive" = true)                               AS "activeSections",
                (SELECT COUNT(*) FROM "AiKnowledgeItem"
                    WHERE "conflictGroupId" IS NOT NULL
                      AND status = 'active')                               AS "conflictingItems"
        `
        const r = rows[0] ?? {}
        return {
            activeItems:      Number(r.activeItems ?? 0),
            archivedItems:    Number(r.archivedItems ?? 0),
            draftItems:       Number(r.draftItems ?? 0),
            totalSources:     Number(r.totalSources ?? 0),
            extractionJobs:   Number(r.extractionJobs ?? 0),
            activeSections:   Number(r.activeSections ?? 0),
            conflictingItems: Number(r.conflictingItems ?? 0),
        }
    } catch {
        return empty
    }
}

export async function listExtractionJobs(limit = 10): Promise<any[]> {
    try {
        return await prisma.$queryRaw<any[]>`
            SELECT * FROM "AiExtractionJob"
            ORDER BY "createdAt" DESC
            LIMIT ${limit}
        `
    } catch {
        return []
    }
}

// ─── PR7.12 — compact source badges per item ──────────────────────
//
// Возвращает для batch item-ids разбивку источников по connectionId.
// Используется в UI карточки знания: «WA +7922•••5750 · TG Support · ещё 3».
// Без новых таблиц — простой GROUP BY по уже существующему
// AiKnowledgeSource. Не вызывается из retrieval/extraction pipeline,
// только из настроек.

export interface ItemSourceBadgeRow {
    /** id known connection или null для legacy/manual sources. */
    connectionId: string | null
    /** Сколько sources у этого item с таким connectionId. */
    count:        number
    /** Хотя бы один из этих sources активен (для UI «отключены»). */
    anyActive:    boolean
}

export interface ItemSourceBadges {
    /** Группировка по connectionId, отсортирована по count DESC.
     *  Первая запись с connectionId=null означает legacy/manual sources
     *  без точной привязки. UI обрабатывает её отдельно. */
    rows:        ItemSourceBadgeRow[]
    /** Distinct count non-null connectionId — сколько разных аккаунтов
     *  «доказывают» этот item. */
    distinctConnections: number
    /** Хотя бы один source с connectionId IS NULL. */
    hasUnknownSource: boolean
    /** Все sources isActive=false. UI badge «источники отключены». */
    allDisabled: boolean
    /** Сколько всего sources у item (исключая superseded chain). */
    totalSources: number
}

/** Batch query badges для N items. Возвращает Map itemId → badges.
 *  Если item не найден, в Map его не будет — UI fallback на пустой. */
export async function getItemSourceBadges(
    itemIds: string[]
): Promise<Map<string, ItemSourceBadges>> {
    const out = new Map<string, ItemSourceBadges>()
    if (itemIds.length === 0) return out
    try {
        const rows = await prisma.$queryRaw<Array<{
            itemId: string
            connectionId: string | null
            cnt: number
            anyActive: boolean
        }>>`
            SELECT
                "itemId",
                "connectionId",
                COUNT(*)::int       AS cnt,
                BOOL_OR("isActive") AS "anyActive"
            FROM "AiKnowledgeSource"
            WHERE "itemId" = ANY(${itemIds})
            GROUP BY "itemId", "connectionId"
        `
        // Группируем по itemId, сортируем по count DESC внутри группы.
        const byItem = new Map<string, Array<{
            connectionId: string | null
            count: number
            anyActive: boolean
        }>>()
        for (const r of rows) {
            const arr = byItem.get(r.itemId) ?? []
            arr.push({
                connectionId: r.connectionId,
                count:        Number(r.cnt),
                anyActive:    Boolean(r.anyActive),
            })
            byItem.set(r.itemId, arr)
        }
        for (const [itemId, arr] of byItem.entries()) {
            arr.sort((a, b) => b.count - a.count)
            const total           = arr.reduce((s, x) => s + x.count, 0)
            const distinct        = arr.filter(x => x.connectionId !== null).length
            const hasUnknown      = arr.some(x => x.connectionId === null)
            const allDisabled     = arr.every(x => !x.anyActive)
            out.set(itemId, {
                rows:                arr,
                distinctConnections: distinct,
                hasUnknownSource:    hasUnknown,
                allDisabled,
                totalSources:        total,
            })
        }
        return out
    } catch {
        return out
    }
}
