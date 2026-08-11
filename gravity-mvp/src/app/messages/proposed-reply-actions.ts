'use server'

/**
 * PR9.44 «AI стажёр» — server actions для proposed reply в чатах.
 *
 * Flow:
 *   1. Менеджер открыл чат → UI hook вызывает getOrGenerateProposedReply
 *   2. Если cached row для последнего inbound — возвращаем
 *   3. Иначе — генерируем через shadowReply pipeline, сохраняем в БД
 *   4. UI рендерит призрачное сообщение
 *   5. Менеджер «Взять в работу» → markProposedReplyTaken → текст
 *      копируется в input bar
 *   6. После реальной отправки → markProposedReplySent (track approved
 *      vs edited)
 *   7. «Скрыть» → dismissProposedReply
 *
 * Все actions safe для multiple callers — UNIQUE на messageId + upsert.
 */

import { prisma } from '@/lib/prisma'
import { getAiAgentProviderConfigV1 } from '@/modules/calling/public/v1/ai-agent-provider-capability'
import { cookies } from 'next/headers'
import { generateShadowReplyForChat } from '@/lib/pipeline/shadowReply'
import { appendKnowledgeGovernanceAuditV1 as writeAuditEntry } from '@/modules/ai-knowledge/public/v1/knowledge-governance-audit'
import { runCoach, type CoachResult, type CoachSuggestion } from '@/lib/ai/knowledge/coach'
import { APPLY_KNOWLEDGE_ITEM_COACH_EDIT_COMMAND_V1, PATCH_PROPOSED_REPLY_COMMAND_V1, UPSERT_PROPOSED_REPLY_COMMAND_V1, VERIFY_KNOWLEDGE_ITEM_COMMAND_V1 } from '@/contracts/ai-knowledge/v1'
import { applyKnowledgeItemCoachEditV1, patchProposedReplyV1, upsertProposedReplyV1, verifyKnowledgeItemV1 } from '@/modules/ai-knowledge/public/v1'

const CACHE_TTL_MIN = 15

export interface ProposedReplyDTO {
    id:            string
    messageId:     string
    chatId:        string
    text:          string
    confidence:    number
    decisionMode:  'auto_reply' | 'escalate' | 'no_match'
    reasoning:     string | null
    sources:       Array<{ id: string; title: string; excerpt?: string }> | null
    generatedAt:   string
    expiresAt:     string
    takenAt:       string | null
    sentMessageId: string | null
    dismissedAt:   string | null
}

/**
 * PR9.53: explicit-skip result — AI промолчал по конкретной причине.
 * Возвращается вместо null чтобы UI мог показать человеку «почему».
 */
export interface ProposedReplySkip {
    skipped: true
    reason:  'no_inbound' | 'ai_disabled' | 'intern_disabled' | 'no_api_key' | 'pipeline_returned_null' | 'error'
    /** Человеко-читаемая фраза для UI. */
    message: string
}

function serialize(row: any): ProposedReplyDTO {
    return {
        id:            row.id,
        messageId:     row.messageId,
        chatId:        row.chatId,
        text:          row.text,
        confidence:    Number(row.confidence ?? 0),
        decisionMode:  row.decisionMode,
        reasoning:     row.reasoning,
        sources:       row.sources ? (row.sources as ProposedReplyDTO['sources']) : null,
        generatedAt:   new Date(row.generatedAt).toISOString(),
        expiresAt:     new Date(row.expiresAt).toISOString(),
        takenAt:       row.takenAt       ? new Date(row.takenAt).toISOString()       : null,
        sentMessageId: row.sentMessageId,
        dismissedAt:   row.dismissedAt   ? new Date(row.dismissedAt).toISOString()   : null,
    }
}

/**
 * Главный action — UI вызывает при фокусе в input bar открытого чата.
 * Возвращает существующий proposal или генерирует новый.
 *
 * Возвращает null если:
 *   - В чате нет inbound сообщений
 *   - AI выключен глобально (config.enabled=false)
 *   - internEnabled=false в AiAgentConfig
 *   - Pipeline вернул error / no_match без текста (UI отобразит пустоту)
 */
export async function getOrGenerateProposedReply(chatId: string): Promise<ProposedReplyDTO | ProposedReplySkip | null> {
    // 1. Last inbound — определяет «к чему» относится proposal
    const lastInbound = await prisma.message.findFirst({
        where: { chatId, direction: 'inbound' },
        orderBy: { sentAt: 'desc' },
        select: { id: true },
    })
    if (!lastInbound) {
        console.log(`[ai-intern] chatId=${chatId} skip: no inbound messages in chat`)
        return {
            skipped: true,
            reason: 'no_inbound',
            message: 'Собеседник пока ничего не написал — AI отвечать не на что.',
        }
    }

    // 2. Cache lookup — UNIQUE на messageId, поэтому findUnique.
    const cached = await prisma.aiProposedReply.findUnique({
        where: { messageId: lastInbound.id },
    })
    if (cached && cached.expiresAt > new Date() && !cached.dismissedAt) {
        // Свежий и не скрытый — отдаём как есть, новой LLM-call не нужен.
        console.log(`[ai-intern] chatId=${chatId} cached: msgId=${lastInbound.id} mode=${cached.decisionMode}`)
        return serialize(cached)
    }

    // 3. Check feature flag (default true, но админ может выключить)
    const config = await getAiAgentProviderConfigV1()
    if (!config) {
        console.log(`[ai-intern] chatId=${chatId} skip: AiAgentConfig singleton missing`)
        return { skipped: true, reason: 'ai_disabled', message: 'AI не настроен.' }
    }
    if (!config.enabled) {
        console.log(`[ai-intern] chatId=${chatId} skip: AI globally disabled (enabled=false)`)
        return { skipped: true, reason: 'ai_disabled', message: 'AI глобально выключен в настройках.' }
    }
    if (!config.internEnabled) {
        console.log(`[ai-intern] chatId=${chatId} skip: intern feature flag off`)
        return { skipped: true, reason: 'intern_disabled', message: 'AI стажёр выключен.' }
    }
    // PR9.48: AI mode='off' раньше блокировал стажёра. Теперь стажёр
    // работает независимо — он не отправляет реально, это shadow-черновик
    // для менеджера. Логика моде влияет только на runtime auto-reply.
    if (!config.apiKeyEncrypted) {
        console.log(`[ai-intern] chatId=${chatId} skip: no API key configured`)
        return { skipped: true, reason: 'no_api_key', message: 'Не указан API-ключ AI Провайдера.' }
    }

    // 4. Generate fresh
    console.log(`[ai-intern] chatId=${chatId} generating for msgId=${lastInbound.id}…`)
    let result
    try {
        result = await generateShadowReplyForChat(chatId)
    } catch (e: any) {
        console.error(`[ai-intern] chatId=${chatId} generation error:`, e?.message)
        return { skipped: true, reason: 'error', message: `Ошибка генерации: ${e?.message ?? 'unknown'}` }
    }
    if (!result) {
        console.log(`[ai-intern] chatId=${chatId} pipeline returned null (контекст пуст или AI off)`)
        return { skipped: true, reason: 'pipeline_returned_null', message: 'Pipeline не смог построить контекст для этого чата.' }
    }
    console.log(`[ai-intern] chatId=${chatId} generated: mode=${result.decisionMode} conf=${result.confidence.toFixed(2)} textLen=${result.text.length}`)

    // 5. Upsert (race-safe — UNIQUE constraint на messageId)
    const expiresAt = new Date(Date.now() + CACHE_TTL_MIN * 60 * 1000)
    const saved = await upsertProposedReplyV1({
        contract: UPSERT_PROPOSED_REPLY_COMMAND_V1,
        messageId: lastInbound.id,
        chatId,
        text: result.text,
        confidence: result.confidence,
        decisionMode: result.decisionMode,
        reasoning: result.reasoning,
        sources: result.sources,
        expiresAt,
    })
    return serialize(saved.proposal)
}

/** Менеджер нажал «Взять в работу» — записываем timestamp. */
export async function markProposedReplyTaken(id: string): Promise<void> {
    await patchProposedReplyV1({ contract: PATCH_PROPOSED_REPLY_COMMAND_V1, proposalId: id, patch: { takenAt: new Date() } })
}

/** После реальной отправки сообщения менеджером — link на Message.id. */
export async function markProposedReplySent(id: string, sentMessageId: string): Promise<void> {
    await patchProposedReplyV1({ contract: PATCH_PROPOSED_REPLY_COMMAND_V1, proposalId: id, patch: { sentMessageId } })
}

/** Менеджер нажал «Скрыть» — не показываем proposal пока не пришёт новое inbound. */
export async function dismissProposedReply(id: string): Promise<void> {
    await patchProposedReplyV1({ contract: PATCH_PROPOSED_REPLY_COMMAND_V1, proposalId: id, patch: { dismissedAt: new Date() } })
}

/**
 * PR9.54 «AI Trainer Loop»: менеджер нажал 👍 «Правильно» — все
 * knowledge items, которые AI использовал для генерации этого черновика,
 * автоматически:
 *   - isVerified = true
 *   - status = 'active' (если был 'draft')
 *   - audit log entry с metadata.source='chat_usage', proposalId, chatId
 *
 * Идея пользователя: вместо отдельной рутины «зайти в Ядро и тыкать
 * Подтвердить на каждом факте» — verification происходит попутно,
 * через 👍 на реальных ответах AI. Только items, которые AI РЕАЛЬНО
 * использует и менеджер ОДОБРИЛ, становятся verified — это правильный
 * quality signal.
 *
 * Threshold = 1 (одного 👍 достаточно) — выбран user'ом для скорости.
 * Если в будущем будут ложные verify — переключим на 2-3.
 *
 * Возвращает: количество items которые были verified этим действием
 * (если уже verified — не считаются).
 */
export interface ConfirmCorrectResult {
    verifiedCount: number
    items: Array<{ id: string; title: string }>
}
export async function confirmProposedReplyCorrect(proposalId: string): Promise<ConfirmCorrectResult> {
    // 1. Загружаем proposal с sources
    const proposal = await prisma.aiProposedReply.findUnique({
        where: { id: proposalId },
    })
    if (!proposal) {
        throw new Error('Proposal не найден')
    }
    if (proposal.confirmedCorrectAt) {
        // Уже был 👍 — идемпотентно, возвращаем 0
        return { verifiedCount: 0, items: [] }
    }

    const sources = proposal.sources as Array<{ id: string; title: string }> | null
    if (!sources || sources.length === 0) {
        // Нет используемых items — нечего verified. Mark anyway чтобы не пере-fetch.
        await patchProposedReplyV1({ contract: PATCH_PROPOSED_REPLY_COMMAND_V1, proposalId, patch: { confirmedCorrectAt: new Date() } })
        return { verifiedCount: 0, items: [] }
    }

    // 2. Определяем actor — current user из cookie
    const cookieStore = await cookies()
    const actor = cookieStore.get('crm_user_id')?.value ?? null

    // 3. Для каждого item — verify + audit
    const verified: Array<{ id: string; title: string }> = []
    for (const src of sources) {
        try {
            // Загружаем before snapshot
            const beforeRows = await prisma.$queryRaw<Array<{
                id: string
                title: string
                isVerified: boolean
                status: string
            }>>`
                SELECT id, title, "isVerified", status::text AS status
                FROM "AiKnowledgeItem"
                WHERE id = ${src.id}
                LIMIT 1
            `
            const before = beforeRows[0]
            if (!before) continue
            if (before.isVerified && before.status === 'active') {
                // Уже verified+active — нет смысла дёргать
                continue
            }

            // Update: isVerified=true, status='active' (промоция draft→active)
            await verifyKnowledgeItemV1({ contract: VERIFY_KNOWLEDGE_ITEM_COMMAND_V1, itemId: src.id, verifiedBy: actor })

            // Audit log с metadata о источнике этого verify
            await writeAuditEntry({
                itemId: src.id,
                actor,
                action: 'verified',
                before: {
                    isVerified: before.isVerified,
                    status:     before.status,
                },
                after: {
                    isVerified: true,
                    status:     'active',
                },
                metadata: {
                    source:     'chat_usage',
                    proposalId,
                    chatId:     proposal.chatId,
                    messageId:  proposal.messageId,
                },
            })

            verified.push({ id: src.id, title: src.title })
        } catch (e: any) {
            console.error(`[ai-intern] confirm: failed to verify item ${src.id}:`, e?.message)
        }
    }

    // 4. Mark proposal as confirmed
    await patchProposedReplyV1({ contract: PATCH_PROPOSED_REPLY_COMMAND_V1, proposalId, patch: { confirmedCorrectAt: new Date() } })

    console.log(`[ai-intern] confirmed proposal ${proposalId}: verified ${verified.length} items`)

    return {
        verifiedCount: verified.length,
        items: verified,
    }
}

/**
 * PR9.55 «AI Coach» — менеджер нажал «Поправить», исправил draft,
 * теперь нужно понять что в Ядре устарело. LLM-вызов с original/corrected/
 * used items, возвращает structured suggestions для approval modal.
 *
 * Этот action НЕ применяет изменения — только генерирует предложения.
 * Apply — отдельный action applyCoachSuggestions с подтверждением.
 */
export async function coachFromCorrection(
    proposalId: string,
    correctedText: string,
): Promise<CoachResult> {
    const proposal = await prisma.aiProposedReply.findUnique({
        where: { id: proposalId },
    })
    if (!proposal) {
        return { suggestions: [], onlyStyleChange: false, note: 'proposal not found' }
    }
    const sources = (proposal.sources as Array<{ id: string; title: string }> | null) ?? []
    if (sources.length === 0) {
        return { suggestions: [], onlyStyleChange: false, note: 'no sources used by AI' }
    }

    // Получаем config и full canonicalStatement у sources
    const providerConfig = await getAiAgentProviderConfigV1()
    const config = providerConfig && {
        provider: providerConfig.provider,
        apiKey: providerConfig.apiKeyEncrypted,
        model: providerConfig.responseModel,
    }
    if (!config?.apiKey) {
        return { suggestions: [], onlyStyleChange: false, note: 'AI provider not configured' }
    }

    const itemRows = await prisma.$queryRaw<Array<{
        id: string; title: string; canonicalStatement: string
    }>>`
        SELECT id, title, "canonicalStatement"
        FROM "AiKnowledgeItem"
        WHERE id = ANY(${sources.map(s => s.id)})
    `
    if (itemRows.length === 0) {
        return { suggestions: [], onlyStyleChange: false, note: 'no items found in DB' }
    }

    console.log(`[ai-coach] proposalId=${proposalId} running coach (${itemRows.length} items)…`)

    const result = await runCoach({
        provider:      config.provider,
        model:         config.model ?? 'claude-sonnet-4-5',
        apiKey:        config.apiKey!,
        originalDraft: proposal.text,
        correctedText,
        items:         itemRows,
    })

    console.log(`[ai-coach] proposalId=${proposalId} ${result.suggestions.length} suggestions, onlyStyle=${result.onlyStyleChange}`)
    return result
}

/**
 * PR9.55 «AI Coach» apply step: после approval menager'а — применяет
 * выбранные suggestions к knowledge items в Ядре + audit log с
 * metadata.source='ai_coach', proposalId, chatId.
 *
 * Идемпотентно: повторный вызов с теми же suggestions при уже
 * применённом изменении пройдёт без эффекта (currentValue не совпадает
 * с DB → skip).
 */
export interface ApplyCoachResult {
    applied:  Array<{ itemId: string; title: string; newValue: string }>
    skipped:  Array<{ itemId: string; reason: string }>
}
export async function applyCoachSuggestions(
    proposalId: string,
    suggestions: CoachSuggestion[],
): Promise<ApplyCoachResult> {
    const proposal = await prisma.aiProposedReply.findUnique({
        where: { id: proposalId },
    })
    if (!proposal) throw new Error('Proposal не найден')

    const cookieStore = await cookies()
    const actor = cookieStore.get('crm_user_id')?.value ?? null

    const applied: ApplyCoachResult['applied'] = []
    const skipped: ApplyCoachResult['skipped'] = []

    for (const s of suggestions) {
        try {
            // Загружаем актуальный item
            const beforeRows = await prisma.$queryRaw<Array<{
                id: string; title: string; canonicalStatement: string
                isVerified: boolean; status: string
            }>>`
                SELECT id, title, "canonicalStatement",
                       "isVerified", status::text AS status
                FROM "AiKnowledgeItem"
                WHERE id = ${s.itemId}
                LIMIT 1
            `
            const before = beforeRows[0]
            if (!before) {
                skipped.push({ itemId: s.itemId, reason: 'item not found' })
                continue
            }
            // Drift check — currentValue должен совпадать с DB
            if (before.canonicalStatement.trim() !== s.currentValue.trim()) {
                console.warn(`[ai-coach] drift on ${s.itemId}: DB=«${before.canonicalStatement.slice(0,60)}» but suggestion currentValue=«${s.currentValue.slice(0,60)}»`)
                // Применяем всё равно, но в audit metadata пишем drift=true
            }

            await applyKnowledgeItemCoachEditV1({ contract: APPLY_KNOWLEDGE_ITEM_COACH_EDIT_COMMAND_V1, itemId: s.itemId, canonicalStatement: s.newValue, verifiedBy: actor })

            await writeAuditEntry({
                itemId: s.itemId,
                actor,
                action: 'edited',
                before: {
                    canonicalStatement: before.canonicalStatement,
                    isVerified:         before.isVerified,
                    status:             before.status,
                },
                after: {
                    canonicalStatement: s.newValue,
                    isVerified:         true,
                    status:             'active',
                },
                metadata: {
                    source:     'ai_coach',
                    proposalId,
                    chatId:     proposal.chatId,
                    messageId:  proposal.messageId,
                    reasoning:  s.reasoning,
                    drift:      before.canonicalStatement.trim() !== s.currentValue.trim(),
                },
            })

            applied.push({
                itemId:   s.itemId,
                title:    before.title,
                newValue: s.newValue,
            })
        } catch (e: any) {
            console.error(`[ai-coach] apply failed for ${s.itemId}:`, e?.message)
            skipped.push({ itemId: s.itemId, reason: e?.message ?? 'unknown' })
        }
    }

    console.log(`[ai-coach] applied ${applied.length}, skipped ${skipped.length} for proposal ${proposalId}`)
    return { applied, skipped }
}
