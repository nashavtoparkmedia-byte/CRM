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
    type ProposedReplyDTO,
} from '../proposed-reply-actions'

export interface UseProposedReplyResult {
    proposal: ProposedReplyDTO | null
    loading:  boolean
    /**
     * PR9.47: была попытка fetch завершиться, но proposal=null —
     * AI решил промолчать (отключен, нет inbound, no_match и т.п.).
     * UI показывает мини-pill «AI промолчал» вместо моментального
     * исчезновения skeleton'а.
     */
    silent:   boolean
    /** Триггер — UI вызывает на focus в input bar. Идемпотентно. */
    trigger:  () => void
    /** Очистить proposal в UI (например при смене чата). */
    reset:    () => void
    /** «Взять в работу» — лог в БД, возвращает текст. */
    take:     () => Promise<string | null>
    /** «Скрыть» — лог в БД, очищает proposal. */
    dismiss:  () => Promise<void>
}

export function useProposedReply(chatId: string | null): UseProposedReplyResult {
    const [proposal, setProposal] = useState<ProposedReplyDTO | null>(null)
    const [loading,  setLoading]  = useState(false)
    const [silent,   setSilent]   = useState(false)
    // Защита от двойных вызовов: пока loading=true игнорируем повторные trigger.
    // Плюс — после успешного fetch не запрашиваем повторно для того же chatId
    // пока пользователь не сделает reset() или не сменит чат.
    const fetchedForChatRef = useRef<string | null>(null)

    const trigger = useCallback(() => {
        if (!chatId) return
        if (loading) return
        // Уже фетчили для этого чата — не повторяем (cached серверным action'ом тоже).
        if (fetchedForChatRef.current === chatId) return

        setLoading(true)
        setSilent(false)
        fetchedForChatRef.current = chatId
        getOrGenerateProposedReply(chatId)
            .then(p => {
                setProposal(p)
                setSilent(p === null)  // AI ничего не предложил — показываем мини-pill
            })
            .catch(e => {
                console.error('[useProposedReply] error', e)
                setProposal(null)
                setSilent(true)  // ошибка тоже = AI «промолчал», но в UI мы это покажем
            })
            .finally(() => setLoading(false))
    }, [chatId, loading])

    const reset = useCallback(() => {
        setProposal(null)
        setLoading(false)
        setSilent(false)
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
    }, [proposal])

    return { proposal, loading, silent, trigger, reset, take, dismiss }
}
