/**
 * AI Knowledge Core — Extractor worker (PR2.4).
 *
 * Offline knowledge distillation: читает пары "клиент → менеджер" из
 * истории, выжимает структурированные факты компании, пишет в
 * AiKnowledgeItem + AiKnowledgeSource.
 *
 * НЕ подключён к runtime answer pipeline. Retrieval — PR3.
 *
 * Architecture:
 *   - БЕЗ embeddings — dedup через trigram Jaccard
 *   - БЕЗ fine-tune — только prompt + LLM
 *   - PII-маскинг обязателен перед сохранением excerpt
 *   - Verbatim evidence check — anti-hallucination guard
 *   - Idempotent через excerptHash unique constraint
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- raw SQL returns. */

import { prisma } from '@/lib/prisma'
import { getAiAgentProviderConfigV1 } from '@/modules/calling/public/v1/ai-agent-provider-capability'
import {
    EXTRACTION_SYSTEM_PROMPT,
    PROMPT_VERSION,
    buildUserPrompt,
    parseExtractionResponse,
    type ExtractionCandidate,
    type PromptPair as LlmPromptPair,
} from './extractionPrompt'
import {
    buildPairs,
    type ExtractionScope,
    type PromptPair,
} from './pairBuilder'
// PR9.39: интеграция voice transcripts в knowledge extraction.
// callTranscriptBuilder читает Call.transcript и собирает в
// PromptPair[]-совместимые объекты с originType='voice_transcript'.
import { buildCallChunks } from './callTranscriptBuilder'
import {
    similarity,
    maskPII,
    extractNumericValues,
    isVerbatimEvidence,
    makeExcerptHash,
} from './textUtils'
import {
    checkAgainstTrusted,
    makeConflictsTag,
    makeMatchesTag,
} from './trustedGuard'

// ─── Tunable constants ────────────────────────────────────────────

const BATCH_SIZE = 8
// PR9: параллельные batch'и для скорости. OpenAI rate limit для
// gpt-4o-mini = 10 000 RPM — 4 одновременных запроса (≈ 2400 RPM
// при 5 сек/запрос) запас огромный. Время сбора: было 38 batch
// × 5с = 190с → стало 10 «волн» × 5с = 50с (3.8×). Если batch
// падает — это просто один failure, остальные продолжают.
const BATCH_CONCURRENCY = 4
const MIN_CONFIDENCE = 0.5
const MERGE_SIMILARITY = 0.60
const CONFLICT_TITLE_SIM = 0.50
const ACTIVATION_SOURCE_COUNT = 2
const ACTIVATION_CONFIDENCE   = 0.85

// ─── Types ────────────────────────────────────────────────────────

export interface ExtractionJobProgress {
    messagesScanned:          number
    chatsScanned:             number
    pairsBuilt:               number
    pairsProcessed:           number
    llmCalls:                 number
    llmErrors:                number
    candidatesReturned:       number
    candidatesAccepted:       number
    itemsCreated:             number
    itemsMerged:              number
    itemsAsDraft:             number
    sourcesCreated:           number
    sourcesSkippedDuplicate:  number
    skippedLowConfidence:     number
    skippedNoVerbatim:        number
    skippedUnknownSection:    number
    conflictsDetected:        number
    /** PR6: candidates blocked because they contradict a verified or
     *  legacy-migrated rule. Создаются как draft+requires_human для
     *  ручного review админом, в runtime не используются. */
    trustedConflictsBlocked:  number
    /** PR6: candidates which echo a verified/legacy rule — merged
     *  with confidence boost. Track для visibility сколько менеджеров
     *  подтверждают официальную линию. */
    trustedMatchesBoosted:    number
}

function emptyProgress(): ExtractionJobProgress {
    return {
        messagesScanned: 0, chatsScanned: 0, pairsBuilt: 0, pairsProcessed: 0,
        llmCalls: 0, llmErrors: 0, candidatesReturned: 0, candidatesAccepted: 0,
        itemsCreated: 0, itemsMerged: 0, itemsAsDraft: 0,
        sourcesCreated: 0, sourcesSkippedDuplicate: 0,
        skippedLowConfidence: 0, skippedNoVerbatim: 0, skippedUnknownSection: 0,
        conflictsDetected: 0,
        trustedConflictsBlocked: 0, trustedMatchesBoosted: 0,
    }
}

interface AgentConfig {
    provider:               string
    apiKey:                 string | null
    classificationModel:    string
    responseModel:          string
    extractionQualityTier:  string | null
    extractionPromptVersion: string | null
}

interface SectionRow {
    id: string
    slug: string
    title: string
    isActive: boolean
}

interface ItemRow {
    id:                 string
    sectionId:          string
    title:              string
    canonicalStatement: string
    confidence:         number
    sourceCount:        number
    uniqueManagerCount: number
    safetyLevel:        string
    status:             string
    isActive:           boolean
    conflictGroupId:    string | null
    tags:               string[]
    /** PR6: trustedGuard смотрит этот флаг плюс tags 'source:legacy'
     *  чтобы определить trusted источник. */
    isVerified:         boolean
}

// ─── Model resolution ─────────────────────────────────────────────

function resolveModel(tier: string, config: AgentConfig): { provider: string; model: string } {
    const provider = config.provider
    if (tier === 'economy') {
        if (provider === 'openai') return { provider, model: 'gpt-4o-mini' }
        return { provider, model: 'claude-haiku-4-5' }
    }
    if (tier === 'quality') {
        return { provider, model: config.responseModel }
    }
    // default = balanced
    return { provider, model: config.classificationModel }
}

// ─── LLM call (Anthropic / OpenAI) ────────────────────────────────

async function callExtractorLLM(
    provider: string,
    model: string,
    apiKey: string,
    systemPrompt: string,
    userPrompt: string,
): Promise<string | null> {
    try {
        if (provider === 'openai') {
            const res = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type':  'application/json',
                },
                body: JSON.stringify({
                    model,
                    response_format: { type: 'json_object' },
                    temperature: 0,
                    max_tokens:  2000,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user',   content: userPrompt },
                    ],
                }),
            })
            if (!res.ok) return null
            const data: any = await res.json()
            return data?.choices?.[0]?.message?.content ?? null
        }
        // Anthropic JSON-mode trick: prefilled '{' заставляет Claude'а
        // продолжать с JSON.
        const res = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'x-api-key':         apiKey,
                'anthropic-version': '2023-06-01',
                'content-type':      'application/json',
            },
            body: JSON.stringify({
                model,
                max_tokens: 2000,
                temperature: 0,
                system: systemPrompt,
                messages: [
                    { role: 'user',      content: userPrompt },
                    { role: 'assistant', content: '{' },
                ],
            }),
        })
        if (!res.ok) return null
        const data: any = await res.json()
        const tail: string = data?.content?.[0]?.text ?? ''
        return '{' + tail
    } catch {
        return null
    }
}

// ─── DB lookups ───────────────────────────────────────────────────

async function loadAgentConfig(): Promise<AgentConfig | null> {
    const config = await getAiAgentProviderConfigV1()
    return config ? {
        provider: config.provider,
        apiKey: config.apiKeyEncrypted,
        classificationModel: config.classificationModel ?? 'claude-haiku-4-5',
        responseModel: config.responseModel ?? 'claude-sonnet-4-5',
        extractionQualityTier: config.extractionQualityTier,
        extractionPromptVersion: config.extractionPromptVersion,
    } : null
}

async function loadSections(): Promise<SectionRow[]> {
    return await prisma.$queryRaw<SectionRow[]>`
        SELECT id, slug, title, "isActive"
        FROM "AiKnowledgeSection"
        WHERE "isActive" = true
        ORDER BY "sortOrder" ASC
    `
}

async function loadExistingItems(sectionId: string): Promise<ItemRow[]> {
    return await prisma.$queryRaw<ItemRow[]>`
        SELECT
            id, "sectionId", title, "canonicalStatement",
            confidence, "sourceCount", "uniqueManagerCount",
            "safetyLevel"::text   AS "safetyLevel",
            status::text          AS status,
            "isActive", "conflictGroupId", tags,
            "isVerified"
        FROM "AiKnowledgeItem"
        WHERE "sectionId" = ${sectionId}
          AND status IN ('active', 'draft')
    `
}

// ─── Dedup + conflict ─────────────────────────────────────────────

function findBestMatch(
    candidate: ExtractionCandidate,
    existing:  ItemRow[],
): { item: ItemRow; score: number } | null {
    let best: { item: ItemRow; score: number } | null = null
    for (const item of existing) {
        const sStmt  = similarity(candidate.canonical_statement, item.canonicalStatement)
        const sTitle = similarity(candidate.title, item.title)
        const score = 0.7 * sStmt + 0.3 * sTitle
        if (!best || score > best.score) best = { item, score }
    }
    return best
}

function detectConflict(candidate: ExtractionCandidate, item: ItemRow): boolean {
    const titleSim = similarity(candidate.title, item.title)
    if (titleSim < CONFLICT_TITLE_SIM) return false
    const candN = extractNumericValues(candidate.canonical_statement)
    const itemN = extractNumericValues(item.canonicalStatement)
    if (candN.length === 0 || itemN.length === 0) return false
    for (const a of candN) {
        for (const b of itemN) {
            if (a.unit === b.unit && Math.abs(a.value - b.value) > 0.001) return true
        }
    }
    return false
}

// ─── Activation rule ──────────────────────────────────────────────

function decideActivation(
    sourceCount: number, confidence: number, safetyLevel: string,
): { status: string; isActive: boolean } {
    const active =
        sourceCount >= ACTIVATION_SOURCE_COUNT ||
        confidence >= ACTIVATION_CONFIDENCE ||
        safetyLevel === 'requires_human'
    return { status: active ? 'active' : 'draft', isActive: active }
}

// ─── Write paths ──────────────────────────────────────────────────

/**
 * PR6: создаёт item который противоречит trusted (verified/legacy)
 * правилу. Принудительно status='draft', isActive=false,
 * safetyLevel='requires_human' + tag conflicts_with_trusted:<id>.
 *
 * НЕ попадает в runtime retrieval (excludeDraft=true в политике),
 * но виден в UI с красной плашкой "противоречит подтверждённому
 * правилу". Это review signal для админа — менеджер в чате сказал
 * что-то не по официальной линии.
 */
async function createBlockedByTrustedItem(
    sectionId:        string,
    candidate:        ExtractionCandidate,
    pair:             PromptPair,
    maskedExcerpt:    string,
    excerptHash:      string,
    trustedItemId:    string,
): Promise<{ itemId: string }> {
    const itemId   = 'kbi_' + Math.random().toString(36).slice(2, 14)
    const sourceId = 'kbs_' + Math.random().toString(36).slice(2, 14)
    const tags = mergeTags(candidate.tags, [
        `type:${candidate.type}`,
        makeConflictsTag(trustedItemId),
    ])

    await prisma.$executeRawUnsafe(
        `INSERT INTO "AiKnowledgeItem" (
            id, "sectionId", title, "canonicalStatement",
            tags, confidence,
            "sourceCount", "uniqueManagerCount",
            status, "isActive", "safetyLevel",
            "createdBy", "createdAt", "updatedAt"
         ) VALUES (
            $1, $2, $3, $4, $5::text[], $6, 1, $7,
            'draft'::"AiKnowledgeStatus", false, 'requires_human'::"AiKnowledgeSafety",
            'extractor', NOW(), NOW()
         )`,
        itemId,
        sectionId,
        candidate.title,
        candidate.canonical_statement,
        tags,
        candidate.confidence,
        pair.managerUserId ? 1 : 0,
    )
    await prisma.$executeRawUnsafe(
        `INSERT INTO "AiKnowledgeSource" (
            id, "itemId", "originType",
            "messageId", "chatId", channel, "managerUserId",
            "connectionId", excerpt, "excerptHash", confidence, "occurredAt", "createdAt"
         ) VALUES (
            $1, $2, $3::"AiKnowledgeSourceOrigin", $4, $5,
            $6::"ChatChannel", $7, $8, $9, $10, $11, $12, NOW()
         )`,
        sourceId,
        itemId,
        pair.originType,
        pair.managerMessageId,
        pair.chatId,
        pair.channel,
        pair.managerUserId,
        pair.connectionId,
        maskedExcerpt,
        excerptHash,
        candidate.confidence,
        pair.managerAt,
    )
    return { itemId }
}

async function createItemWithSource(
    sectionId:     string,
    candidate:     ExtractionCandidate,
    pair:          PromptPair,
    maskedExcerpt: string,
    excerptHash:   string,
): Promise<{ itemId: string; activated: boolean }> {
    const itemId = 'kbi_' + Math.random().toString(36).slice(2, 14)
    const sourceId = 'kbs_' + Math.random().toString(36).slice(2, 14)
    const safetyLevel = candidate.safety_level
    const { status, isActive } = decideActivation(1, candidate.confidence, safetyLevel)

    const tags = mergeTags(candidate.tags, [`type:${candidate.type}`])

    await prisma.$executeRawUnsafe(
        `INSERT INTO "AiKnowledgeItem" (
            id, "sectionId", title, "canonicalStatement",
            tags, confidence,
            "sourceCount", "uniqueManagerCount",
            status, "isActive", "safetyLevel",
            "createdBy", "createdAt", "updatedAt"
         ) VALUES (
            $1, $2, $3, $4, $5::text[], $6, 1, $7,
            $8::"AiKnowledgeStatus", $9, $10::"AiKnowledgeSafety",
            'extractor', NOW(), NOW()
         )`,
        itemId,
        sectionId,
        candidate.title,
        candidate.canonical_statement,
        tags,
        candidate.confidence,
        pair.managerUserId ? 1 : 0,
        status,
        isActive,
        safetyLevel,
    )
    await prisma.$executeRawUnsafe(
        `INSERT INTO "AiKnowledgeSource" (
            id, "itemId", "originType",
            "messageId", "chatId", channel, "managerUserId",
            "connectionId", excerpt, "excerptHash", confidence, "occurredAt", "createdAt"
         ) VALUES (
            $1, $2, $3::"AiKnowledgeSourceOrigin", $4, $5,
            $6::"ChatChannel", $7, $8, $9, $10, $11, $12, NOW()
         )`,
        sourceId,
        itemId,
        pair.originType,
        pair.managerMessageId,
        pair.chatId,
        pair.channel,
        pair.managerUserId,
        pair.connectionId,
        maskedExcerpt,
        excerptHash,
        candidate.confidence,
        pair.managerAt,
    )
    return { itemId, activated: isActive }
}

async function mergeIntoItem(
    item:          ItemRow,
    candidate:     ExtractionCandidate,
    pair:          PromptPair,
    maskedExcerpt: string,
    excerptHash:   string,
): Promise<{ added: boolean; promoted: boolean }> {
    let sourceAdded = false
    try {
        const sourceId = 'kbs_' + Math.random().toString(36).slice(2, 14)
        await prisma.$executeRawUnsafe(
            `INSERT INTO "AiKnowledgeSource" (
                id, "itemId", "originType",
                "messageId", "chatId", channel, "managerUserId",
                "connectionId", excerpt, "excerptHash", confidence, "occurredAt", "createdAt"
             ) VALUES (
                $1, $2, $3::"AiKnowledgeSourceOrigin", $4, $5,
                $6::"ChatChannel", $7, $8, $9, $10, $11, $12, NOW()
             )`,
            sourceId,
            item.id,
            pair.originType,
            pair.managerMessageId,
            pair.chatId,
            pair.channel,
            pair.managerUserId,
            pair.connectionId,
            maskedExcerpt,
            excerptHash,
            candidate.confidence,
            pair.managerAt,
        )
        sourceAdded = true
    } catch {
        return { added: false, promoted: false }
    }

    const newCount = item.sourceCount + 1
    const newConf = (item.confidence * item.sourceCount + candidate.confidence) / newCount
    const newMgrCount = pair.managerUserId && pair.managerUserId.length > 0
        ? Math.max(item.uniqueManagerCount, 1) + 1
        : item.uniqueManagerCount

    const wasActive = item.isActive
    const { status, isActive } = decideActivation(newCount, newConf, item.safetyLevel)
    const promoted = !wasActive && isActive

    const newTags = mergeTags(item.tags, candidate.tags, [`type:${candidate.type}`])

    await prisma.$executeRawUnsafe(
        `UPDATE "AiKnowledgeItem"
         SET "sourceCount" = $1,
             "uniqueManagerCount" = $2,
             confidence = $3,
             tags = $4::text[],
             status = $5::"AiKnowledgeStatus",
             "isActive" = $6,
             "updatedAt" = NOW()
         WHERE id = $7`,
        newCount,
        newMgrCount,
        newConf,
        newTags,
        status,
        isActive,
        item.id,
    )
    item.sourceCount        = newCount
    item.uniqueManagerCount = newMgrCount
    item.confidence         = newConf
    item.tags               = newTags
    item.status             = status
    item.isActive           = isActive

    return { added: sourceAdded, promoted }
}

async function markConflict(itemA: ItemRow, itemB: ItemRow): Promise<string> {
    const groupId = itemA.conflictGroupId ?? itemB.conflictGroupId
        ?? ('cfl_' + Math.random().toString(36).slice(2, 14))
    await prisma.$executeRawUnsafe(
        `UPDATE "AiKnowledgeItem"
         SET "conflictGroupId" = $1, "updatedAt" = NOW()
         WHERE id IN ($2, $3)
           AND ("conflictGroupId" IS NULL OR "conflictGroupId" = $4)`,
        groupId,
        itemA.id,
        itemB.id,
        groupId,
    )
    itemA.conflictGroupId = groupId
    itemB.conflictGroupId = groupId
    return groupId
}

function mergeTags(...lists: Array<string[] | undefined | null>): string[] {
    const set = new Set<string>()
    for (const list of lists) {
        if (!list) continue
        for (const t of list) {
            const v = (t || '').trim()
            if (v) set.add(v)
        }
    }
    return [...set]
}

// ─── Batch processing ─────────────────────────────────────────────

interface ProcessCtx {
    sectionsBySlug:  Map<string, SectionRow>
    sectionsList:    Array<{ slug: string; title: string }>
    itemsBySection:  Map<string, ItemRow[]>
    progress:        ExtractionJobProgress
}

async function processBatch(
    batch:    PromptPair[],
    ctx:      ProcessCtx,
    provider: string,
    model:    string,
    apiKey:   string,
): Promise<void> {
    const llmPairs: LlmPromptPair[] = batch.map(p => ({
        channel: p.channel,
        client:  p.clientText,
        manager: p.managerText,
    }))
    const userPrompt = buildUserPrompt(llmPairs, ctx.sectionsList)
    ctx.progress.llmCalls++
    const raw = await callExtractorLLM(provider, model, apiKey, EXTRACTION_SYSTEM_PROMPT, userPrompt)
    if (!raw) {
        ctx.progress.llmErrors++
        ctx.progress.pairsProcessed += batch.length
        return
    }
    const { candidates } = parseExtractionResponse(raw)
    ctx.progress.candidatesReturned += candidates.length

    for (const cand of candidates) {
        if (cand.confidence < MIN_CONFIDENCE) {
            ctx.progress.skippedLowConfidence++
            continue
        }
        const pair = batch.find(p =>
            isVerbatimEvidence(cand.evidence_excerpt, [p.managerText])
        )
        if (!pair) {
            ctx.progress.skippedNoVerbatim++
            continue
        }
        const section = ctx.sectionsBySlug.get(cand.section_slug)
        if (!section) {
            ctx.progress.skippedUnknownSection++
            continue
        }
        const maskedExcerpt = maskPII(cand.evidence_excerpt)
        const excerptHash   = makeExcerptHash(pair.managerMessageId, maskedExcerpt)

        let existing = ctx.itemsBySection.get(section.id)
        if (!existing) {
            existing = await loadExistingItems(section.id)
            ctx.itemsBySection.set(section.id, existing)
        }

        // PR6: Trusted Knowledge Guard. Проверяем candidate против
        // verified/legacy-migrated items в той же секции ДО основной
        // dedup-логики. Если candidate противоречит подтверждённому
        // правилу — он не должен стать активным; создаём как
        // draft+requires_human для admin-review.
        const guard = checkAgainstTrusted(
            { title: cand.title, canonicalStatement: cand.canonical_statement },
            existing.map(e => ({
                id: e.id, title: e.title,
                canonicalStatement: e.canonicalStatement,
                status: e.status, isVerified: e.isVerified, tags: e.tags,
            })),
        )
        if (guard.verdict === 'contradicts') {
            const { itemId } = await createBlockedByTrustedItem(
                section.id, cand, pair, maskedExcerpt, excerptHash, guard.trusted.id,
            )
            ctx.progress.itemsCreated++
            ctx.progress.sourcesCreated++
            ctx.progress.itemsAsDraft++
            ctx.progress.trustedConflictsBlocked++
            ctx.progress.candidatesAccepted++
            existing.push({
                id: itemId, sectionId: section.id,
                title: cand.title, canonicalStatement: cand.canonical_statement,
                confidence: cand.confidence, sourceCount: 1, uniqueManagerCount: 0,
                safetyLevel: 'requires_human', status: 'draft',
                isActive: false, conflictGroupId: null,
                tags: mergeTags(cand.tags, [`type:${cand.type}`, makeConflictsTag(guard.trusted.id)]),
                isVerified: false,
            })
            continue
        }
        // PR6: matches_trusted — candidate подтверждает уже существующий
        // verified/legacy факт. Продолжаем standard merge-or-create flow,
        // но помечаем tag matches_trusted:<id> чтобы UI мог показать
        // "ещё одно подтверждение".
        if (guard.verdict === 'matches_trusted') {
            cand.tags = [...(cand.tags ?? []), makeMatchesTag(guard.trusted.id)]
            ctx.progress.trustedMatchesBoosted++
        }

        const match = findBestMatch(cand, existing)
        if (match && match.score >= MERGE_SIMILARITY) {
            if (detectConflict(cand, match.item)) {
                ctx.progress.conflictsDetected++
                const { itemId, activated } = await createItemWithSource(
                    section.id, cand, pair, maskedExcerpt, excerptHash,
                )
                ctx.progress.itemsCreated++
                ctx.progress.sourcesCreated++
                if (!activated) ctx.progress.itemsAsDraft++
                ctx.progress.candidatesAccepted++

                const newItem: ItemRow = {
                    id: itemId, sectionId: section.id,
                    title: cand.title, canonicalStatement: cand.canonical_statement,
                    confidence: cand.confidence, sourceCount: 1, uniqueManagerCount: 0,
                    safetyLevel: cand.safety_level, status: activated ? 'active' : 'draft',
                    isActive: activated, conflictGroupId: null,
                    tags: mergeTags(cand.tags, [`type:${cand.type}`]),
                    isVerified: false,
                }
                existing.push(newItem)
                await markConflict(newItem, match.item)
                continue
            }
            const { added } = await mergeIntoItem(match.item, cand, pair, maskedExcerpt, excerptHash)
            if (added) {
                ctx.progress.itemsMerged++
                ctx.progress.sourcesCreated++
                ctx.progress.candidatesAccepted++
            } else {
                ctx.progress.sourcesSkippedDuplicate++
            }
            continue
        }
        const { itemId, activated } = await createItemWithSource(
            section.id, cand, pair, maskedExcerpt, excerptHash,
        )
        ctx.progress.itemsCreated++
        ctx.progress.sourcesCreated++
        if (!activated) ctx.progress.itemsAsDraft++
        ctx.progress.candidatesAccepted++
        existing.push({
            id: itemId, sectionId: section.id,
            title: cand.title, canonicalStatement: cand.canonical_statement,
            confidence: cand.confidence, sourceCount: 1, uniqueManagerCount: 0,
            safetyLevel: cand.safety_level, status: activated ? 'active' : 'draft',
            isActive: activated, conflictGroupId: null,
            tags: mergeTags(cand.tags, [`type:${cand.type}`]),
            isVerified: false,
        })
    }
    ctx.progress.pairsProcessed += batch.length
}

// ─── Job lifecycle ────────────────────────────────────────────────

async function updateJobProgress(jobId: string, progress: ExtractionJobProgress): Promise<void> {
    await prisma.$executeRawUnsafe(
        'UPDATE "AiExtractionJob" SET progress = $1::jsonb WHERE id = $2',
        JSON.stringify(progress),
        jobId,
    )
}

async function finalizeJob(
    jobId:    string,
    status:   'completed' | 'partial' | 'failed',
    error:    string | null,
    progress: ExtractionJobProgress,
): Promise<void> {
    await prisma.$executeRawUnsafe(
        `UPDATE "AiExtractionJob"
         SET status = $1::"AiExtractionStatus",
             progress = $2::jsonb,
             "errorMessage" = $3,
             "finishedAt" = NOW()
         WHERE id = $4`,
        status,
        JSON.stringify(progress),
        error,
        jobId,
    )
}

// ─── Main entry ──────────────────────────────────────────────────

/**
 * Запуск экстрактора. Должно вызываться fire-and-forget из server
 * action startKnowledgeExtraction (PR2.5). Не кидает наружу — все
 * ошибки записываются в job.errorMessage и status='failed'.
 *
 * На пустой истории (нет пар) — корректно завершается status='completed'
 * с нулевыми счётчиками.
 */
export async function runExtraction(jobId: string): Promise<void> {
    const progress = emptyProgress()

    const jobRows = await prisma.$queryRaw<any[]>`
        SELECT id, scope, "extractionQualityTier"
        FROM "AiExtractionJob" WHERE id = ${jobId} LIMIT 1
    `
    const job = jobRows[0]
    if (!job) return
    const scope: ExtractionScope = job.scope || { mode: 'last_90d' }
    const tier = job.extractionQualityTier ?? 'balanced'

    const config = await loadAgentConfig()
    if (!config || !config.apiKey) {
        await finalizeJob(jobId, 'failed', 'AI provider not configured (no API key)', progress)
        return
    }
    const { provider, model } = resolveModel(tier, config)

    await prisma.$executeRawUnsafe(
        `UPDATE "AiExtractionJob"
         SET status = 'running'::"AiExtractionStatus",
             "startedAt" = NOW(),
             "extractionProvider" = $1,
             "extractionModel" = $2,
             "extractionPromptVersion" = $3,
             "extractionQualityTier" = $4,
             progress = $5::jsonb
         WHERE id = $6`,
        provider,
        model,
        PROMPT_VERSION,
        tier,
        JSON.stringify(progress),
        jobId,
    )

    try {
        const sectionsAll = await loadSections()
        const sectionsBySlug = new Map<string, SectionRow>()
        for (const s of sectionsAll) sectionsBySlug.set(s.slug, s)
        const sectionsList = sectionsAll.map(s => ({ slug: s.slug, title: s.title }))
        if (sectionsList.length === 0) {
            await finalizeJob(jobId, 'failed', 'No active sections in DB. Run seed_knowledge_sections.js.', progress)
            return
        }

        const built = await buildPairs(scope)
        // PR9.39: дополнительно собираем voice transcripts если в scope
        // 'phone' канал. Без diarization — один Call = один PromptPair с
        // transcript в managerText. Сливаем с chat-парами в общий
        // массив, дальше Extractor не различает источники — pipeline
        // та же (batches, parallel waves, LLM, dedup).
        // buildCallChunks сам проверит scope.channels — если 'phone'
        // там нет, вернёт пустой массив.
        const builtCalls = await buildCallChunks(scope)
        const allPairs   = [...built.pairs, ...builtCalls.pairs]
        progress.messagesScanned = built.messagesScanned
        progress.chatsScanned    = built.chatsScanned
        progress.pairsBuilt      = allPairs.length
        await updateJobProgress(jobId, progress)

        if (allPairs.length === 0) {
            await finalizeJob(jobId, 'completed', null, progress)
            return
        }

        const ctx: ProcessCtx = {
            sectionsBySlug,
            sectionsList,
            itemsBySection: new Map(),
            progress,
        }
        // PR9: разбиваем pairs на batches, batches группируем в «волны»
        // по BATCH_CONCURRENCY штук. Внутри волны — Promise.all (паралл.),
        // волны идут последовательно (чтобы видеть progress + не выйти
        // за rate limit). Раньше был чистый for+await — медленно.
        let batchFailures = 0
        const allBatches: PromptPair[][] = []
        for (let i = 0; i < allPairs.length; i += BATCH_SIZE) {
            allBatches.push(allPairs.slice(i, i + BATCH_SIZE))
        }
        for (let waveIdx = 0; waveIdx < allBatches.length; waveIdx += BATCH_CONCURRENCY) {
            const wave = allBatches.slice(waveIdx, waveIdx + BATCH_CONCURRENCY)
            // Promise.allSettled — один сбойный batch не валит остальные.
            const results = await Promise.allSettled(wave.map(batch =>
                processBatch(batch, ctx, provider, model, config.apiKey!)
            ))
            for (const r of results) {
                if (r.status === 'rejected') {
                    batchFailures++
                    progress.llmErrors++
                    if (process.env.NODE_ENV !== 'production') {
                        const reason = r.reason instanceof Error ? r.reason.message : String(r.reason)
                        console.error('[extractor] batch error:', reason)
                    }
                }
            }
            // Прогресс обновляется после каждой «волны» — пользователь
            // видит движение в UI каждые ~5 секунд.
            await updateJobProgress(jobId, progress)
        }

        const finalStatus: 'completed' | 'partial' =
            batchFailures === 0
                ? 'completed'
                : 'partial'
        await finalizeJob(jobId, finalStatus, null, progress)
    } catch (e: any) {
        await finalizeJob(jobId, 'failed', e?.message ?? 'unknown error', progress)
    }
}

export { type ExtractionScope } from './pairBuilder'
