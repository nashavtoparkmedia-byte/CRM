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
import { cookies } from 'next/headers'
import { generateShadowReplyForChat } from '@/lib/pipeline/shadowReply'
import { writeAuditEntry } from '@/lib/ai/knowledge/auditLog'

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
    const config = await prisma.aiAgentConfig.findUnique({
        where: { id: 'singleton' },
        select: { enabled: true, internEnabled: true, mode: true, apiKeyEncrypted: true },
    })
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
    const saved = await prisma.aiProposedReply.upsert({
        where: { messageId: lastInbound.id },
        create: {
            messageId:    lastInbound.id,
            chatId,
            text:         result.text,
            confidence:   result.confidence,
            decisionMode: result.decisionMode,
            reasoning:    result.reasoning,
            sources:      result.sources as any,
            expiresAt,
        },
        update: {
            text:         result.text,
            confidence:   result.confidence,
            decisionMode: result.decisionMode,
            reasoning:    result.reasoning,
            sources:      result.sources as any,
            expiresAt,
            generatedAt:  new Date(),
            dismissedAt:  null,  // re-generated означает снова видимый
            takenAt:      null,  // и не «взят в работу»
            sentMessageId: null,
        },
    })
    return serialize(saved)
}

/** Менеджер нажал «Взять в работу» — записываем timestamp. */
export async function markProposedReplyTaken(id: string): Promise<void> {
    await prisma.aiProposedReply.update({
        where: { id },
        data:  { takenAt: new Date() },
    })
}

/** После реальной отправки сообщения менеджером — link на Message.id. */
export async function markProposedReplySent(id: string, sentMessageId: string): Promise<void> {
    await prisma.aiProposedReply.update({
        where: { id },
        data:  { sentMessageId },
    })
}

/** Менеджер нажал «Скрыть» — не показываем proposal пока не пришёт новое inbound. */
export async function dismissProposedReply(id: string): Promise<void> {
    await prisma.aiProposedReply.update({
        where: { id },
        data:  { dismissedAt: new Date() },
    })
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
        await prisma.aiProposedReply.update({
            where: { id: proposalId },
            data: { confirmedCorrectAt: new Date() },
        })
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
            await prisma.$executeRaw`
                UPDATE "AiKnowledgeItem"
                SET "isVerified" = true,
                    "verifiedBy" = ${actor},
                    "verifiedAt" = NOW(),
                    status = 'active'::"AiKnowledgeStatus",
                    "isActive" = true,
                    "updatedAt" = NOW()
                WHERE id = ${src.id}
            `

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
    await prisma.aiProposedReply.update({
        where: { id: proposalId },
        data: { confirmedCorrectAt: new Date() },
    })

    console.log(`[ai-intern] confirmed proposal ${proposalId}: verified ${verified.length} items`)

    return {
        verifiedCount: verified.length,
        items: verified,
    }
}
