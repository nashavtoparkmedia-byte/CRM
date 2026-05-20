/**
 * AI Knowledge Core — explainability aggregator (PR4).
 *
 * Собирает в один bundle всё, что нужно UI-модалке
 * "Почему AI так ответил?". Все данные уже есть в БД (PR3 заложил
 * traces) — этот модуль join'ит их по decisionLogId.
 *
 * Pure read-only aggregator. Никаких write-ops, никаких retrieve
 * вызовов. Только SELECT + JOIN. Permission filtering (excerpts
 * admin-only) делается в server-action wrapper'е, не здесь.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { prisma } from '@/lib/prisma'

export interface ExplainabilityBundle {
    decision:           ExplainDecisionRow | null
    userMessage:        ExplainMessageRow | null
    knowledgeUsages:    ExplainUsageRow[]
    sources:            ExplainSourceRow[]
    /** Audit-entries по использованным items ПОСЛЕ createdAt этого
     *  decision'а — даёт "что изменилось после ответа". */
    auditAfter:         ExplainAuditRow[]
}

export interface ExplainDecisionRow {
    id:                       string
    messageId:                string | null
    chatId:                   string | null
    channel:                  string | null
    detectedIntent:           string | null
    confidence:               number | null
    decision:                 string | null
    selectedModel:            string | null
    generatedReply:           string | null
    replySent:                boolean
    escalated:                boolean
    error:                    string | null
    retrievalMode:            string | null
    retrievalDecision:        string | null
    escalationReason:         string | null
    knowledgeRuntimeVersion:  string | null
    shadowRetrievalSummary:   Record<string, unknown> | null
    operatorVerdict:          string | null
    reviewedByOperator:       boolean
    createdAt:                string
}

export interface ExplainMessageRow {
    id:        string
    chatId:    string
    direction: string
    content:   string | null
    sentAt:    string
    channel:   string | null
}

export interface ExplainUsageRow {
    id:               string
    itemId:           string
    retrievalScore:   number | null
    rerankScore:      number | null
    usedInReply:      boolean
    policyDecision:   string | null
    shadowMode:       boolean
    escalationReason: string | null
    usedAt:           string
    /** Joined item snapshot. Может быть null если item был удалён. */
    item: {
        id:                 string
        title:              string
        canonicalStatement: string
        sectionId:          string
        sectionTitle:       string | null
        sectionSlug:        string | null
        tags:               string[]
        confidence:         number
        sourceCount:        number
        uniqueManagerCount: number
        status:             string
        isActive:           boolean
        isVerified:         boolean
        safetyLevel:        string
        conflictGroupId:    string | null
        supersededByItemId: string | null
        updatedAt:          string
    } | null
}

export interface ExplainSourceRow {
    id:            string
    itemId:        string
    originType:    string
    messageId:     string | null
    chatId:        string | null
    channel:       string | null
    managerUserId: string | null
    excerpt:       string
    confidence:    number
    occurredAt:    string | null
    createdAt:     string
}

export interface ExplainAuditRow {
    id:         string
    itemId:     string | null
    actor:      string | null
    action:     string
    metadata:   Record<string, unknown> | null
    createdAt:  string
}

/**
 * Главный entry. Возвращает полный bundle для UI-модалки.
 * Tolerant: при ошибке в подзагрузке возвращает то что удалось
 * собрать, остальные поля — пустые. Не throw.
 */
export async function getDecisionExplainability(decisionLogId: string): Promise<ExplainabilityBundle> {
    const empty: ExplainabilityBundle = {
        decision: null, userMessage: null,
        knowledgeUsages: [], sources: [], auditAfter: [],
    }
    try {
        // 1. Decision log row
        const decisionRows = await prisma.$queryRaw<ExplainDecisionRow[]>`
            SELECT
                id, "messageId", "chatId", channel,
                "detectedIntent", confidence,
                decision, "selectedModel",
                "generatedReply", "replySent", escalated, error,
                "retrievalMode", "retrievalDecision", "escalationReason",
                "knowledgeRuntimeVersion", "shadowRetrievalSummary",
                "operatorVerdict", "reviewedByOperator",
                "createdAt"
            FROM "AiDecisionLog"
            WHERE id = ${decisionLogId}
            LIMIT 1
        `
        const decision = decisionRows[0] ?? null
        if (!decision) return empty

        // 2. Original user message
        let userMessage: ExplainMessageRow | null = null
        if (decision.messageId) {
            const msgRows = await prisma.$queryRaw<ExplainMessageRow[]>`
                SELECT
                    id, "chatId",
                    direction::text AS direction,
                    content, "sentAt",
                    channel::text AS channel
                FROM "Message"
                WHERE id = ${decision.messageId}
                LIMIT 1
            `
            userMessage = msgRows[0] ?? null
        }

        // 3. Usage logs + joined item + section
        const usageRows = await prisma.$queryRaw<any[]>`
            SELECT
                ul.id, ul."itemId",
                ul."retrievalScore", ul."rerankScore",
                ul."usedInReply", ul."policyDecision",
                ul."shadowMode", ul."escalationReason",
                ul."usedAt",
                ki.id                          AS "item_id",
                ki.title                       AS "item_title",
                ki."canonicalStatement"        AS "item_canonicalStatement",
                ki."sectionId"                 AS "item_sectionId",
                ks.title                       AS "item_sectionTitle",
                ks.slug                        AS "item_sectionSlug",
                ki.tags                        AS "item_tags",
                ki.confidence                  AS "item_confidence",
                ki."sourceCount"               AS "item_sourceCount",
                ki."uniqueManagerCount"        AS "item_uniqueManagerCount",
                ki.status::text                AS "item_status",
                ki."isActive"                  AS "item_isActive",
                ki."isVerified"                AS "item_isVerified",
                ki."safetyLevel"::text         AS "item_safetyLevel",
                ki."conflictGroupId"           AS "item_conflictGroupId",
                ki."supersededByItemId"        AS "item_supersededByItemId",
                ki."updatedAt"                 AS "item_updatedAt"
            FROM "AiKnowledgeUsageLog" ul
            LEFT JOIN "AiKnowledgeItem"    ki ON ki.id = ul."itemId"
            LEFT JOIN "AiKnowledgeSection" ks ON ks.id = ki."sectionId"
            WHERE ul."decisionLogId" = ${decisionLogId}
            ORDER BY ul."retrievalScore" DESC NULLS LAST, ul."usedAt" ASC
        `
        const knowledgeUsages: ExplainUsageRow[] = usageRows.map(r => ({
            id:               r.id,
            itemId:           r.itemId,
            retrievalScore:   r.retrievalScore,
            rerankScore:      r.rerankScore,
            usedInReply:      r.usedInReply,
            policyDecision:   r.policyDecision,
            shadowMode:       r.shadowMode,
            escalationReason: r.escalationReason,
            usedAt:           r.usedAt,
            item: r.item_id ? {
                id:                 r.item_id,
                title:              r.item_title,
                canonicalStatement: r.item_canonicalStatement,
                sectionId:          r.item_sectionId,
                sectionTitle:       r.item_sectionTitle,
                sectionSlug:        r.item_sectionSlug,
                tags:               r.item_tags || [],
                confidence:         r.item_confidence,
                sourceCount:        r.item_sourceCount,
                uniqueManagerCount: r.item_uniqueManagerCount,
                status:             r.item_status,
                isActive:           r.item_isActive,
                isVerified:         r.item_isVerified,
                safetyLevel:        r.item_safetyLevel,
                conflictGroupId:    r.item_conflictGroupId,
                supersededByItemId: r.item_supersededByItemId,
                updatedAt:          r.item_updatedAt,
            } : null,
        }))

        // 4. Sources (для всех usable items; permission filter в wrapper'е)
        const usableItemIds = knowledgeUsages
            .map(u => u.item?.id)
            .filter((x): x is string => !!x)
        let sources: ExplainSourceRow[] = []
        if (usableItemIds.length > 0) {
            sources = await prisma.$queryRaw<ExplainSourceRow[]>`
                SELECT
                    id, "itemId",
                    "originType"::text AS "originType",
                    "messageId", "chatId",
                    channel::text AS channel,
                    "managerUserId", excerpt, confidence,
                    "occurredAt", "createdAt"
                FROM "AiKnowledgeSource"
                WHERE "itemId" = ANY(${usableItemIds})
                ORDER BY confidence DESC, "createdAt" DESC
                LIMIT 30
            `
        }

        // 5. Audit entries ПОСЛЕ времени decision'а — "что изменилось"
        let auditAfter: ExplainAuditRow[] = []
        if (usableItemIds.length > 0) {
            auditAfter = await prisma.$queryRaw<ExplainAuditRow[]>`
                SELECT
                    id, "itemId", actor,
                    action::text AS action,
                    metadata, "createdAt"
                FROM "AiKnowledgeAuditLog"
                WHERE "itemId" = ANY(${usableItemIds})
                  AND "createdAt" > ${new Date(decision.createdAt)}
                ORDER BY "createdAt" ASC
                LIMIT 50
            `
        }

        return { decision, userMessage, knowledgeUsages, sources, auditAfter }
    } catch (e: any) {
        if (process.env.NODE_ENV !== 'production') {
            console.error('[explainability] getDecisionExplainability failed:', e?.message)
        }
        return empty
    }
}
