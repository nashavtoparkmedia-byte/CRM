'use client'

/**
 * PR9.45 «AI стажёр» — призрачное сообщение в timeline чата.
 *
 * Появляется как полупрозрачная серая bubble после последнего inbound
 * сообщения от водителя. НЕ настоящее сообщение — водитель его не видит.
 * Это черновик, который AI предлагает менеджеру:
 *
 *   🤖 AI бы написал
 *   ┌─────────────────────────────────────┐
 *   │ 3.99% от заказа на полном дне. 8₽…  │
 *   │ 87% уверенности · Тарифы #4         │
 *   │ [✏ Взять в работу]  [✗ Скрыть]      │
 *   └─────────────────────────────────────┘
 *
 * Три варианта state:
 *   - loading       → skeleton «AI думает…»
 *   - auto_reply    → текст + кнопки
 *   - escalate      → «AI хочет передать менеджеру: <причина>»
 *   - no_match      → не рендерим вообще (молча)
 *
 * Кнопки:
 *   - «Взять в работу» → onTake(text) — родитель копирует в input bar
 *   - «Скрыть»         → onDismiss() — больше не показывается пока
 *                        не пришёт новое inbound
 */

import { Bot, ThumbsUp, Pencil, X, Loader2 } from 'lucide-react'
import type { ProposedReplyDTO } from '../proposed-reply-actions'
import { humanizeAiReason } from '../utils/humanize-ai-reason'

interface AiProposedReplyBubbleProps {
    proposal: ProposedReplyDTO | null
    loading:  boolean
    /** PR9.47: AI вернул null (промолчал) — показываем мини-pill вместо
     *  моментального исчезновения skeleton'а. */
    silent:        boolean
    /** PR9.53: конкретная причина молчания («Собеседник пока ничего
     *  не написал», «AI выключен», и т.д.). */
    silentMessage: string | null
    /** «Взять в работу» — копирует текст в input bar родителя. */
    onTake:    () => void
    /** PR9.54: «Правильно» — auto-verify used items + копирует текст. */
    onConfirmCorrect: () => void
    /** «Скрыть» — больше не показывается пока не пришёт новое inbound. */
    onDismiss: () => void
}

export default function AiProposedReplyBubble({
    proposal,
    loading,
    silent,
    silentMessage,
    onTake,
    onConfirmCorrect,
    onDismiss,
}: AiProposedReplyBubbleProps) {
    // Loading state — пока AI думает
    if (loading) {
        return (
            <div className="flex justify-start px-[4px] py-[2px]">
                <div className="max-w-[80%] rounded-2xl bg-[#F0F4FA] border border-[#E4ECFC] px-[4px] py-3">
                    <div className="flex items-center gap-[2px] text-[12px] text-[#3390EC] font-medium mb-1">
                        <Bot size={14} className="text-[#3390EC]" />
                        AI думает…
                        <Loader2 size={12} className="animate-spin opacity-60" />
                    </div>
                    <div className="space-y-1.5">
                        <div className="h-3 bg-[#E4ECFC] rounded animate-pulse w-48" />
                        <div className="h-3 bg-[#E4ECFC] rounded animate-pulse w-64" />
                        <div className="h-3 bg-[#E4ECFC] rounded animate-pulse w-[32px]" />
                    </div>
                </div>
            </div>
        )
    }

    // PR9.47/PR9.53: silent — AI промолчал с конкретной причиной.
    // silentMessage explains «почему», например «Собеседник пока ничего
    // не написал». Если message не пришёл — generic fallback.
    if (silent && !proposal) {
        return (
            <div className="flex justify-start px-[4px] py-[2px]">
                <div className="inline-flex items-start gap-1.5 rounded-lg bg-gray-100 border border-gray-200 px-3 py-1.5 text-[11px] text-gray-600 max-w-[80%]">
                    <Bot size={11} className="opacity-60 mt-[2px] shrink-0" />
                    <span className="flex-1">
                        {/* PR-Р: переводим технические причины на понятный язык. */}
                        {humanizeAiReason(silentMessage)}
                    </span>
                    <button
                        type="button"
                        onClick={onDismiss}
                        className="ml-1 text-gray-400 hover:text-gray-600 shrink-0"
                        aria-label="Скрыть"
                    >
                        <X size={10} />
                    </button>
                </div>
            </div>
        )
    }

    // Нет proposal или no_match — не рендерим
    if (!proposal) return null
    if (proposal.decisionMode === 'no_match') return null

    // Escalate state — AI считает что нужен менеджер
    if (proposal.decisionMode === 'escalate') {
        return (
            <div className="flex justify-start px-[4px] py-[2px]">
                <div className="max-w-[80%] rounded-2xl bg-[#FFFBED] border border-[#FFE8B0] px-[4px] py-3">
                    <div className="flex items-center gap-[2px] text-[12px] text-[#8B6914] font-semibold mb-1.5">
                        <Bot size={14} />
                        AI предлагает передать менеджеру
                    </div>
                    <div className="text-[13px] text-[#5C4807] leading-snug">
                        {/* PR-Р: технические причины (confidence=X < threshold=Y) → человеческий язык. */}
                        {humanizeAiReason(proposal.reasoning) || 'Не хватает данных в Ядре знаний, чтобы ответить уверенно.'}
                    </div>
                    <div className="mt-2.5 flex items-center gap-[2px]">
                        <button
                            type="button"
                            onClick={onDismiss}
                            className="text-[11px] text-[#8B6914] hover:text-[#5C4807] underline-offset-2 hover:underline"
                        >
                            Скрыть
                        </button>
                    </div>
                </div>
            </div>
        )
    }

    // Auto-reply state — есть текст черновика
    const confPercent = Math.round(proposal.confidence * 100)
    const topSource = proposal.sources && proposal.sources.length > 0
        ? proposal.sources[0]
        : null

    return (
        <div className="flex justify-start px-[4px] py-[2px]">
            <div className="max-w-[80%] rounded-2xl bg-[#F0F4FA] border border-[#3390EC]/30 px-[4px] py-3">
                <div className="flex items-center gap-[2px] text-[12px] text-[#3390EC] font-semibold mb-1.5">
                    <Bot size={14} />
                    AI бы написал
                </div>
                <div className="text-[14px] text-[#111] leading-snug whitespace-pre-wrap">
                    {proposal.text}
                </div>
                <div className="mt-[2px] flex flex-wrap items-center gap-x-[2px] gap-y-0.5 text-[11px] text-gray-500">
                    <span>{confPercent}% уверенности</span>
                    {topSource && (
                        <>
                            <span className="text-gray-400">·</span>
                            <span title={topSource.excerpt ?? ''}>
                                {topSource.title}
                            </span>
                        </>
                    )}
                </div>
                {/* PR9.54: 3 кнопки.
                    👍 «Правильно» — auto-verify используемых items + копирует в input
                    ✏ «Поправить» — copy в input (Coach flow в PR9.55)
                    ✗ «Пропустить» — dismiss */}
                <div className="mt-3 flex items-center gap-[2px]">
                    <button
                        type="button"
                        onClick={onConfirmCorrect}
                        title="Ответ AI правильный — подтверждаю. Подсветится в Ядре как verified-via-chat. Текст копируется в поле ввода — можно сразу отправить."
                        className="inline-flex items-center gap-1.5 h-[28px] px-3 rounded-lg bg-emerald-600 text-white text-[12px] font-semibold hover:bg-emerald-700 transition-colors"
                    >
                        <ThumbsUp size={11} />
                        Правильно
                    </button>
                    <button
                        type="button"
                        onClick={onTake}
                        title="Скопировать в поле ввода — можно отредактировать перед отправкой."
                        className="inline-flex items-center gap-1.5 h-[28px] px-3 rounded-lg bg-[#3390EC] text-white text-[12px] font-semibold hover:bg-[#2B7FD4] transition-colors"
                    >
                        <Pencil size={11} />
                        Поправить
                    </button>
                    <button
                        type="button"
                        onClick={onDismiss}
                        className="inline-flex items-center gap-1.5 h-[28px] px-3 rounded-lg text-[12px] text-gray-600 hover:bg-[#E4ECFC] transition-colors"
                    >
                        <X size={11} />
                        Пропустить
                    </button>
                </div>
            </div>
        </div>
    )
}
