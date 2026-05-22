/**
 * PR9.45 «AI стажёр» — hook для получения proposed reply в чате.
 *
 * Использование:
 *   const { proposal, loading, take, dismiss, refresh } = useProposedReply(chatId)
 *
 * Жизненный цикл:
 *   1. Hook idle (proposal=null, loading=false)
 *   2. Вызвал `trigger()` — например при focus в input bar
 *   3. loading=true → fetch с сервера
 *   4. Готово: либо `proposal` с текстом, либо null
 *   5. take(proposalId) → log в БД, возвращает текст для prefill input
 *   6. dismiss(proposalId) → log в БД, proposal становится null в UI
 *
 * Триггер на focus (НЕ на mount) — экономнее по токенам. Если пользователь
 * просто открыл чат и сразу закрыл — AI не запускается. Запускается
 * только когда менеджер реально собирается отвечать.
 */

import { useState, useCallback, useRef } from 'react'
import {
    getOrGenerateProposedReply,
    markProposedReplyTaken,
    dismissProposedReply,
    confirmProposedReplyCorrect,
    type ProposedReplyDTO,
    type ProposedReplySkip,
    type ConfirmCorrectResult,
} from '../proposed-reply-actions'

export interface UseProposedReplyResult {
    proposal: ProposedReplyDTO | null
    loading:  boolean
    /**
     * PR9.47: была попытка fetch завершиться, но proposal=null —
     * AI решил промолчать (отключен, нет inbound, no_match и т.п.).
     * UI показывает мини-pill «AI промолчал» вместо моментального
     * исчезновения skeleton'а.
     * PR9.53: silent теперь несёт message — конкретную причину
     * молчания, чтобы UI показывал «AI промолчал: <причина>».
     */
    silent:        boolean
    silentMessage: string | null
    /** Триггер — UI вызывает на focus в input bar. Идемпотентно. */
    trigger:  () => void
    /** Очистить proposal в UI (например при смене чата). */
    reset:    () => void
    /** «Взять в работу» — лог в БД, возвращает текст. */
    take:     () => Promise<string | null>
    /** «Скрыть» — лог в БД, очищает proposal. */
    dismiss:  () => Promise<void>
    /**
     * PR9.54: 👍 «Правильно» — auto-verify всех used knowledge items.
     * Возвращает результат (сколько items было verified) для toast.
     * Также копирует текст в input bar (как take), чтобы менеджер
     * мог сразу отправить — verify+send одной операцией.
     */
    confirmCorrect: () => Promise<{ text: string; result: ConfirmCorrectResult } | null>
}

export function useProposedReply(chatId: string | null): UseProposedReplyResult {
    const [proposal, setProposal] = useState<ProposedReplyDTO | null>(null)
    const [loading,  setLoading]  = useState(false)
    const [silent,   setSilent]   = useState(false)
    const [silentMessage, setSilentMessage] = useState<string | null>(null)
    // Защита от двойных вызовов: пока loading=true игнорируем повторные trigger.
    const fetchedForChatRef = useRef<string | null>(null)

    const trigger = useCallback(() => {
        if (!chatId) return
        if (loading) return
        if (fetchedForChatRef.current === chatId) return

        setLoading(true)
        setSilent(false)
        setSilentMessage(null)
        fetchedForChatRef.current = chatId
        getOrGenerateProposedReply(chatId)
            .then(result => {
                // result может быть: ProposedReplyDTO | ProposedReplySkip | null
                if (result && 'skipped' in result && result.skipped) {
                    // Explicit skip с причиной
                    setProposal(null)
                    setSilent(true)
                    setSilentMessage((result as ProposedReplySkip).message)
                } else if (result === null) {
                    // Старый fallback — null без причины
                    setProposal(null)
                    setSilent(true)
                    setSilentMessage(null)
                } else {
                    // Нормальный proposal
                    setProposal(result as ProposedReplyDTO)
                    setSilent(false)
                    setSilentMessage(null)
                }
            })
            .catch(e => {
                console.error('[useProposedReply] error', e)
                setProposal(null)
                setSilent(true)
                setSilentMessage(`Ошибка: ${e?.message ?? 'unknown'}`)
            })
            .finally(() => setLoading(false))
    }, [chatId, loading])

    const reset = useCallback(() => {
        setProposal(null)
        setLoading(false)
        setSilent(false)
        setSilentMessage(null)
        fetchedForChatRef.current = null
    }, [])

    const take = useCallback(async (): Promise<string | null> => {
        if (!proposal) return null
        try {
            await markProposedReplyTaken(proposal.id)
        } catch (e) {
            console.error('[useProposedReply] take error', e)
        }
        const text = proposal.text
        // Убираем proposal из UI — текст уже скопирован в input, bubble не нужен.
        setProposal(null)
        return text
    }, [proposal])

    const dismiss = useCallback(async (): Promise<void> => {
        if (proposal) {
            try {
                await dismissProposedReply(proposal.id)
            } catch (e) {
                console.error('[useProposedReply] dismiss error', e)
            }
        }
        // silent тоже dismissable — пользователь может скрыть мини-pill
        setProposal(null)
        setSilent(false)
        setSilentMessage(null)
    }, [proposal])

    // PR9.54: 👍 «Правильно» — auto-verify used items + copy text в input.
    // Семантика: «AI ответил правильно, могу пользоваться» одновременно
    // подтверждает knowledge items в Ядре (verified-via-chat-usage).
    const confirmCorrect = useCallback(async (): Promise<{ text: string; result: ConfirmCorrectResult } | null> => {
        if (!proposal) return null
        let result: ConfirmCorrectResult
        try {
            result = await confirmProposedReplyCorrect(proposal.id)
        } catch (e) {
            console.error('[useProposedReply] confirm error', e)
            return null
        }
        const text = proposal.text
        setProposal(null)
        return { text, result }
    }, [proposal])

    return { proposal, loading, silent, silentMessage, trigger, reset, take, dismiss, confirmCorrect }
}
