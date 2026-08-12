/**
 * PR9.44 «AI стажёр» — Messaging-owned shadow reply generator.
 *
 * On-demand генерация черновика ответа для UI в чатах. В отличие от
 * PipelineWorker, который вызывается асинхронно из очереди при каждом
 * входящем сообщении, эта функция вызывается СИНХРОННО из UI (когда
 * менеджер фокусится в input bar открытого чата).
 *
 * Переиспользует существующий pipeline (ContextBuilder → IntentClassifier
 * → DecisionEngine → ResponseGenerator), но форсит `config.mode='suggest_only'`
 * чтобы ResponseGenerator НЕ отправлял реально, даже если глобальный
 * mode = 'auto_reply'.
 *
 * Возвращает структурированный результат для записи в AiProposedReply
 * + отображения в UI.
 *
 * НЕ пишет в БД сама — этим занимается server action upstream.
 * НЕ пишет в AiDecisionLog (это runtime-pipeline ответственность; shadow
 * generation — другой контур, у нас своя AiProposedReply таблица).
 */

import { prisma } from '@/lib/prisma'
import { contextBuilder } from './ContextBuilder'
import { intentClassifier } from './IntentClassifier'
import { decisionEngine } from './DecisionEngine'
import { responseGenerator } from './ResponseGenerator'

export interface ShadowReplyResult {
    /** Текст черновика. Пустой если decisionMode != 'auto_reply'. */
    text: string
    /** Уверенность classifier'а (0..1). */
    confidence: number
    /**
     * 'auto_reply' — есть готовый ответ, можно использовать
     * 'escalate'   — AI считает что нужно передать менеджеру
     * 'no_match'   — AI не понял или нет данных в Ядре
     */
    decisionMode: 'auto_reply' | 'escalate' | 'no_match'
    /** Короткое объяснение «почему так решил» — для UI tooltip. */
    reasoning: string | null
    /** Знания из Ядра которые AI использовал ([{id, title, excerpt}]). */
    sources: Array<{ id: string; title: string; excerpt?: string }> | null
}

/**
 * Найти последний inbound в чате и сгенерировать черновик ответа.
 * Возвращает null если: нет inbound, AI off, config отсутствует.
 */
export async function generateShadowReplyForChat(chatId: string): Promise<ShadowReplyResult | null> {
    console.log(`[shadow-reply] chatId=${chatId} start`)
    const lastInbound = await prisma.message.findFirst({
        where: { chatId, direction: 'inbound' },
        orderBy: { sentAt: 'desc' },
    })
    if (!lastInbound) {
        console.log(`[shadow-reply] chatId=${chatId} fail: no lastInbound`)
        return null
    }
    console.log(`[shadow-reply] chatId=${chatId} lastInbound=${lastInbound.id} text=«${(lastInbound.content ?? '').slice(0, 40)}»`)

    // PR9.48: ignoreModeOff=true — стажёр работает независимо от mode.
    let ctx
    try {
        ctx = await contextBuilder.build(lastInbound, { ignoreModeOff: true })
    } catch (e: any) {
        console.error(`[shadow-reply] chatId=${chatId} ContextBuilder threw: ${e?.message}`)
        return null
    }
    if (!ctx) {
        console.log(`[shadow-reply] chatId=${chatId} fail: ContextBuilder returned null (config.enabled=false?)`)
        return null
    }
    console.log(`[shadow-reply] chatId=${chatId} ctx ok: provider=${ctx.config.provider} hasKey=${!!ctx.config.apiKey} recentMsgs=${ctx.recentMessages.length}`)

    // Override mode — чтобы ResponseGenerator точно не отправил.
    ctx.config.mode = 'suggest_only'

    const userMessage = lastInbound.content?.trim() || ''
    if (!userMessage) {
        console.log(`[shadow-reply] chatId=${chatId} fail: empty content`)
        return { text: '', confidence: 0, decisionMode: 'no_match', reasoning: 'empty inbound', sources: null }
    }

    let classification
    let decision
    try {
        classification = await intentClassifier.classify(userMessage, ctx)
        console.log(`[shadow-reply] chatId=${chatId} classified: intent=${classification.intent} conf=${classification.confidence.toFixed(2)}`)
        decision = await decisionEngine.decide(classification, ctx)
        console.log(`[shadow-reply] chatId=${chatId} decision=${decision.decision} reason=${decision.reason ?? '-'}`)
    } catch (e: any) {
        console.error(`[shadow-reply] chatId=${chatId} classifier/decision threw: ${e?.message}`)
        return { text: '', confidence: 0, decisionMode: 'no_match', reasoning: `pipeline error: ${e?.message}`, sources: null }
    }

    if (decision.decision === 'skip') {
        return {
            text: '',
            confidence: classification.confidence,
            decisionMode: 'no_match',
            reasoning: decision.reason ?? null,
            sources: null,
        }
    }
    if (decision.decision === 'escalate') {
        return {
            text: '',
            confidence: classification.confidence,
            decisionMode: 'escalate',
            reasoning: decision.reason ?? null,
            sources: null,
        }
    }

    // PR3 retrieval policy override: если runtime mode и policy решил
    // escalate (conflict/requires_human/low_confidence) — тоже escalate.
    const kr = ctx.knowledgeRetrieval
    if (kr && kr.mode === 'runtime' && kr.trace.policy.type !== 'answer') {
        return {
            text: '',
            confidence: classification.confidence,
            decisionMode: 'escalate',
            reasoning: `knowledge:${kr.trace.policy.escalationReason}`,
            sources: kr.items.map(i => ({
                id: i.id,
                title: i.title,
                excerpt: i.canonicalStatement?.slice(0, 150),
            })),
        }
    }

    // Genеrate text — без отправки благодаря config.mode override выше.
    let generated
    try {
        generated = await responseGenerator.generate(ctx, classification, decision)
    } catch (e: any) {
        return {
            text: '',
            confidence: classification.confidence,
            decisionMode: 'no_match',
            reasoning: `generator error: ${e?.message}`,
            sources: null,
        }
    }

    if (!generated.reply) {
        return {
            text: '',
            confidence: classification.confidence,
            decisionMode: 'no_match',
            reasoning: 'generator returned empty',
            sources: null,
        }
    }

    const sources = ctx.knowledgeRetrieval?.items?.map(i => ({
        id: i.id,
        title: i.title,
        excerpt: i.canonicalStatement?.slice(0, 150),
    })) ?? null

    return {
        text: generated.reply,
        confidence: classification.confidence,
        decisionMode: 'auto_reply',
        reasoning: null,
        sources,
    }
}
