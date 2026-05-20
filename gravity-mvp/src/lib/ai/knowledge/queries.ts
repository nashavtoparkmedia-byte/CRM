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
