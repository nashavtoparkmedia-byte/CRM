/**
 * AI Knowledge Core — Retriever (PR3).
 *
 * Подключает Knowledge Core к runtime AI pipeline. Главный принцип:
 * deterministic-first, explainable, policy-governed. Никакого pure
 * LLM-router — LLM участвует только в re-rank над прошедшим
 * deterministic prefilter.
 *
 * Pipeline:
 *   1. loadCandidates() — items секций с policy filter
 *   2. prefilter() — trigram-Jaccard + verified boost
 *   3. rerank() — LLM (Haiku/4o-mini), tolerant, optional
 *   4. applyPolicy() — explicit decision tree
 *   5. return { items, trace }
 *
 * Red lines: НЕТ embeddings, НЕТ archived/superseded в результатах,
 * conflict/requires_human/low_confidence/only_drafts → escalate.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { prisma } from '@/lib/prisma'
import { normalize, similarity } from './textUtils'
import {
    RETRIEVAL_PROMPT_VERSION,
} from './retrievalPrompt'

// ─── Types ────────────────────────────────────────────────────────

export type EscalationReason =
    | 'conflict'
    | 'requires_human'
    | 'low_confidence'
    | 'no_relevant'
    | 'only_drafts'
    | 'ambiguous'
    | 'safety_block'

export type PolicyDecisionType = 'answer' | 'escalate' | 'no_knowledge'

export interface RetrievableItem {
    id:                 string
    sectionId:          string
    title:              string
    canonicalStatement: string
    tags:               string[]
    confidence:         number
    sourceCount:        number
    uniqueManagerCount: number
    safetyLevel:        'normal' | 'sensitive' | 'requires_human'
    status:             string
    isActive:           boolean
    isVerified:         boolean
    conflictGroupId:    string | null
    supersededByItemId: string | null
}

export interface PrefilterCandidate {
    item:           RetrievableItem
    prefilterScore: number
    components: {
        titleScore:     number
        statementScore: number
        tagScore:       number
        verifiedBoost:  number
        safetyPenalty:  number
    }
}

export interface RerankedCandidate extends PrefilterCandidate {
    rerankScore: number | null
    rerankRank:  number | null
}

export interface PolicyDecision {
    type:              PolicyDecisionType
    escalationReason:  EscalationReason | null
    usableItems:       RetrievableItem[]
    skippedItems:      Array<{ itemId: string; reason: string }>
}

export interface RetrievalTrace {
    queryNormalized:     string
    candidates:          RerankedCandidate[]
    policy:              PolicyDecision
    durationMs:          number
    prefilterDurationMs: number
    rerankDurationMs:    number | null
    rerankUsedModel:     string | null
    rerankPromptVersion: string
    policyVersion:       string
    shadowMode:          boolean
    timestamp:           string
}

export interface RetrieveInput {
    query:           string
    recentMessages?: Array<{ role: 'user' | 'assistant'; content: string }>
    topK?:           number
    includeDrafts?:  boolean
    shadowMode?:     boolean
    /** Отключает LLM rerank — для smoke и диагностики. */
    skipRerank?:     boolean
}

export interface RetrieveOutput {
    items: RetrievableItem[]
    trace: RetrievalTrace
}

// ─── Policy loader ────────────────────────────────────────────────

interface PolicyConfig {
    minConfidenceForReply:      number
    sensitiveConfidenceMargin:  number
    minSourceCountForReply:     number
    verifiedScoreBoost:         number
    excludeArchived:            boolean
    excludeSuperseded:          boolean
    excludeDraft:               boolean
    conflictEscalates:          boolean
    rerankEnabled:              boolean
    rerankTopN:                 number
    prefilterTopN:              number
    policyVersion:              string
}

const DEFAULT_POLICY: PolicyConfig = {
    minConfidenceForReply:     0.7,
    sensitiveConfidenceMargin: 0.85,
    minSourceCountForReply:    1,
    verifiedScoreBoost:        0.2,
    excludeArchived:           true,
    excludeSuperseded:         true,
    excludeDraft:              true,
    conflictEscalates:         true,
    rerankEnabled:             true,
    rerankTopN:                5,
    prefilterTopN:             20,
    policyVersion:             'v1',
}

async function loadPolicy(): Promise<PolicyConfig> {
    try {
        const rows = await prisma.$queryRaw<any[]>`
            SELECT
                "minConfidenceForReply", "sensitiveConfidenceMargin",
                "minSourceCountForReply", "verifiedScoreBoost",
                "excludeArchived", "excludeSuperseded", "excludeDraft",
                "conflictEscalates", "rerankEnabled", "rerankTopN",
                "prefilterTopN", "policyVersion"
            FROM "AiRetrievalPolicy" WHERE id = 'singleton' LIMIT 1
        `
        if (!rows[0]) return DEFAULT_POLICY
        return { ...DEFAULT_POLICY, ...rows[0] }
    } catch {
        return DEFAULT_POLICY
    }
}

// ─── Candidate loading + prefilter ────────────────────────────────

async function loadCandidates(policy: PolicyConfig, includeDrafts: boolean): Promise<RetrievableItem[]> {
    const conditions: string[] = ['1=1']
    if (policy.excludeArchived)   conditions.push(`status::text != 'archived'`)
    if (policy.excludeSuperseded) conditions.push(`status::text != 'superseded'`)
    if (policy.excludeDraft && !includeDrafts) {
        conditions.push(`status::text != 'draft'`)
    }
    conditions.push(`"isActive" = true`)
    const where = conditions.join(' AND ')
    const sql = `
        SELECT
            id, "sectionId", title, "canonicalStatement", tags,
            confidence, "sourceCount", "uniqueManagerCount",
            "safetyLevel"::text AS "safetyLevel",
            status::text AS status,
            "isActive", "isVerified",
            "conflictGroupId", "supersededByItemId"
        FROM "AiKnowledgeItem"
        WHERE ${where}
    `
    try {
        return await prisma.$queryRawUnsafe<RetrievableItem[]>(sql)
    } catch {
        return []
    }
}

/**
 * Deterministic prefilter scoring. Trigram-Jaccard по title +
 * statement + tags + verified-boost − requires_human penalty.
 * Веса: 0.4 title + 0.5 statement + 0.1 tags — title стабильный
 * signal темы, statement основной content, tags bonus при явном
 * lexical match.
 */
function scoreCandidate(
    queryNorm: string,
    queryTokens: Set<string>,
    item: RetrievableItem,
    policy: PolicyConfig,
): PrefilterCandidate {
    const titleScore     = similarity(queryNorm, item.title)
    const statementScore = similarity(queryNorm, item.canonicalStatement)
    let tagScore = 0
    if (item.tags.length > 0) {
        const userTagOverlap = item.tags.filter(t => {
            if (t.startsWith('type:')) return false
            const tn = normalize(t)
            for (const qt of queryTokens) {
                if (tn.includes(qt) || qt.includes(tn)) return true
            }
            return false
        }).length
        tagScore = Math.min(1, userTagOverlap / Math.max(1, item.tags.length - countTypeTags(item.tags)))
    }
    const verifiedBoost = item.isVerified ? policy.verifiedScoreBoost : 0
    const safetyPenalty = item.safetyLevel === 'requires_human' ? -0.1 : 0
    const prefilterScore =
        0.4 * titleScore +
        0.5 * statementScore +
        0.1 * tagScore +
        verifiedBoost +
        safetyPenalty
    return {
        item,
        prefilterScore,
        components: { titleScore, statementScore, tagScore, verifiedBoost, safetyPenalty },
    }
}

function countTypeTags(tags: string[]): number {
    return tags.filter(t => t.startsWith('type:')).length
}

function tokenize(text: string): Set<string> {
    const norm = normalize(text)
    if (!norm) return new Set()
    return new Set(norm.split(' ').filter(t => t.length >= 3))
}

// ─── Policy decision tree ─────────────────────────────────────────

function applyPolicy(
    ranked: RerankedCandidate[],
    policy: PolicyConfig,
    topK: number,
): PolicyDecision {
    const skipped: Array<{ itemId: string; reason: string }> = []

    if (ranked.length === 0) {
        return { type: 'no_knowledge', escalationReason: 'no_relevant', usableItems: [], skippedItems: skipped }
    }

    const best = ranked[0]

    // Conflict guard.
    if (best.item.conflictGroupId && policy.conflictEscalates) {
        skipped.push({ itemId: best.item.id, reason: 'conflict' })
        return { type: 'escalate', escalationReason: 'conflict', usableItems: [], skippedItems: skipped }
    }

    // Safety guard.
    if (best.item.safetyLevel === 'requires_human') {
        skipped.push({ itemId: best.item.id, reason: 'requires_human' })
        return { type: 'escalate', escalationReason: 'requires_human', usableItems: [], skippedItems: skipped }
    }

    // Confidence threshold (sensitive — выше планка).
    const requiredConfidence = best.item.safetyLevel === 'sensitive'
        ? policy.sensitiveConfidenceMargin
        : policy.minConfidenceForReply
    if (best.item.confidence < requiredConfidence && !best.item.isVerified) {
        skipped.push({ itemId: best.item.id, reason: 'low_confidence' })
        return { type: 'escalate', escalationReason: 'low_confidence', usableItems: [], skippedItems: skipped }
    }

    // Source count (verified bypass).
    if (best.item.sourceCount < policy.minSourceCountForReply && !best.item.isVerified) {
        skipped.push({ itemId: best.item.id, reason: 'low_evidence' })
        return { type: 'escalate', escalationReason: 'low_confidence', usableItems: [], skippedItems: skipped }
    }

    // Only drafts.
    if (best.item.status === 'draft') {
        skipped.push({ itemId: best.item.id, reason: 'draft' })
        return { type: 'escalate', escalationReason: 'only_drafts', usableItems: [], skippedItems: skipped }
    }

    // Score floor — даже top item имеет crap-low score.
    if (best.prefilterScore < 0.05) {
        return { type: 'no_knowledge', escalationReason: 'no_relevant', usableItems: [], skippedItems: skipped }
    }

    // Прошли все guards — собираем top items для generator.
    const usableItems: RetrievableItem[] = []
    for (const c of ranked.slice(0, topK)) {
        if (c.item.safetyLevel === 'requires_human') {
            skipped.push({ itemId: c.item.id, reason: 'requires_human' })
            continue
        }
        if (c.item.conflictGroupId && policy.conflictEscalates) {
            skipped.push({ itemId: c.item.id, reason: 'conflict' })
            continue
        }
        usableItems.push(c.item)
    }

    if (usableItems.length === 0) {
        return { type: 'escalate', escalationReason: 'safety_block', usableItems: [], skippedItems: skipped }
    }

    return { type: 'answer', escalationReason: null, usableItems, skippedItems: skipped }
}

// ─── Main entry ──────────────────────────────────────────────────

/**
 * Чистая функция без побочных эффектов в БД — НЕ пишет UsageLog
 * (это делает PipelineWorker после того, как становится известен
 * decisionLogId).
 *
 * Tolerant: при любых ошибках возвращает no_knowledge с пустым items,
 * PipelineWorker уже решает что делать.
 */
export async function retrieve(input: RetrieveInput): Promise<RetrieveOutput> {
    const startedAt = Date.now()
    const policy = await loadPolicy()
    const includeDrafts = input.includeDrafts === true

    const queryNorm = normalize(input.query)
    const queryTokens = tokenize(input.query)
    const all = await loadCandidates(policy, includeDrafts)

    const prefilterStart = Date.now()
    const scored: PrefilterCandidate[] = all.map(item =>
        scoreCandidate(queryNorm, queryTokens, item, policy),
    )
    scored.sort((a, b) => b.prefilterScore - a.prefilterScore)
    const topPrefilter = scored.slice(0, policy.prefilterTopN)
    const prefilterDurationMs = Date.now() - prefilterStart

    let rerankResult: RerankedCandidate[] = topPrefilter.map((c, i) => ({
        ...c,
        rerankScore: null,
        rerankRank: i,
    }))
    let rerankUsedModel: string | null = null
    let rerankDurationMs: number | null = null

    if (policy.rerankEnabled && !input.skipRerank && topPrefilter.length > 1) {
        const rerankStart = Date.now()
        const { rerankRun } = await import('./Retriever.rerank')
        const reranked = await rerankRun(input.query, topPrefilter)
        rerankDurationMs = Date.now() - rerankStart
        if (reranked) {
            rerankUsedModel = reranked.usedModel
            const order = new Map<string, number>()
            reranked.selectedIds.forEach((id, idx) => order.set(id, idx))
            rerankResult = topPrefilter.map(c => ({
                ...c,
                rerankScore: order.has(c.item.id)
                    ? 1 - (order.get(c.item.id)! / Math.max(1, reranked.selectedIds.length))
                    : 0,
                rerankRank: order.has(c.item.id) ? order.get(c.item.id)! : null,
            }))
            rerankResult.sort((a, b) => {
                if (a.rerankRank !== null && b.rerankRank !== null) return a.rerankRank - b.rerankRank
                if (a.rerankRank !== null) return -1
                if (b.rerankRank !== null) return 1
                return b.prefilterScore - a.prefilterScore
            })
        }
        // Если rerank упал — graceful fallback на deterministic ordering.
    }

    const topK = input.topK ?? policy.rerankTopN
    const policyDecision = applyPolicy(rerankResult, policy, topK)

    const trace: RetrievalTrace = {
        queryNormalized:     queryNorm,
        candidates:          rerankResult,
        policy:              policyDecision,
        durationMs:          Date.now() - startedAt,
        prefilterDurationMs,
        rerankDurationMs,
        rerankUsedModel,
        rerankPromptVersion: RETRIEVAL_PROMPT_VERSION,
        policyVersion:       policy.policyVersion,
        shadowMode:          input.shadowMode === true,
        timestamp:           new Date().toISOString(),
    }

    return { items: policyDecision.usableItems, trace }
}

/**
 * Helper для PipelineWorker: формирует ТОЛЬКО canonical facts для
 * generator-prompt'а. НЕ возвращает excerpts, НЕ возвращает raw sources.
 */
export function formatRetrievedFactsForPrompt(items: RetrievableItem[]): string {
    if (items.length === 0) return '(нет подтверждённых фактов)'
    return items.map((it, i) => {
        const verifiedMark = it.isVerified ? ' [подтверждено]' : ''
        return `${i + 1}. ${it.title}${verifiedMark}\n   ${it.canonicalStatement}`
    }).join('\n')
}
