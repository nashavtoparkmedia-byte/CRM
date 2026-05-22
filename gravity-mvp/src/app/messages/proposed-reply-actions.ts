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
import { generateShadowReplyForChat } from '@/lib/pipeline/shadowReply'

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
export async function getOrGenerateProposedReply(chatId: string): Promise<ProposedReplyDTO | null> {
    // 1. Last inbound — определяет «к чему» относится proposal
    const lastInbound = await prisma.message.findFirst({
        where: { chatId, direction: 'inbound' },
        orderBy: { sentAt: 'desc' },
        select: { id: true },
    })
    if (!lastInbound) return null

    // 2. Cache lookup — UNIQUE на messageId, поэтому findUnique.
    // (prisma as any) — Prisma client регенерируется при следующем
    // рестарте dev-сервера (Windows EPERM на запущенном dev). После
    // регена cast не нужен.
    const cached = await (prisma as any).aiProposedReply.findUnique({
        where: { messageId: lastInbound.id },
    })
    if (cached && cached.expiresAt > new Date() && !cached.dismissedAt) {
        // Свежий и не скрытый — отдаём как есть, новой LLM-call не нужен.
        return serialize(cached)
    }

    // 3. Check feature flag (default true, но админ может выключить)
    const configRows = await prisma.$queryRaw<Array<{ internEnabled: boolean; enabled: boolean }>>`
        SELECT "internEnabled", enabled
        FROM "AiAgentConfig"
        WHERE id = 'singleton' LIMIT 1
    `
    const config = configRows[0]
    if (!config?.enabled || !config.internEnabled) {
        return null
    }

    // 4. Generate fresh
    let result
    try {
        result = await generateShadowReplyForChat(chatId)
    } catch (e: any) {
        console.error('[proposed-reply] generation error:', e?.message)
        return null
    }
    if (!result) return null

    // 5. Upsert (race-safe — UNIQUE constraint на messageId)
    const expiresAt = new Date(Date.now() + CACHE_TTL_MIN * 60 * 1000)
    const saved = await (prisma as any).aiProposedReply.upsert({
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
    await (prisma as any).aiProposedReply.update({
        where: { id },
        data:  { takenAt: new Date() },
    })
}

/** После реальной отправки сообщения менеджером — link на Message.id. */
export async function markProposedReplySent(id: string, sentMessageId: string): Promise<void> {
    await (prisma as any).aiProposedReply.update({
        where: { id },
        data:  { sentMessageId },
    })
}

/** Менеджер нажал «Скрыть» — не показываем proposal пока не пришёт новое inbound. */
export async function dismissProposedReply(id: string): Promise<void> {
    await (prisma as any).aiProposedReply.update({
        where: { id },
        data:  { dismissedAt: new Date() },
    })
}
