"use client"

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AI_CONVERSATIONS_FOR_CONTACT_QUERY_V1,
  START_AI_CONVERSATION_COMMAND_V1,
  isTerminalAiConversationStateV1,
  type AiConversationFailureCodeV1,
  type AiConversationRuntimeModeV1,
  type AiConversationSimulationVariantV1,
  type AiConversationStateV1,
  type AiConversationViewV1,
  type StartAiConversationRefusalV1,
} from '@/contracts/calling/v1/ai-conversation'
import { listAiConversationsForContactActionV1, startAiConversationActionV1 } from '../ai-conversation-actions'

// «AI-звонки» on the person card. Presentation only: every decision (who may call, whether
// this person may be called, which number) is Calling's and Contacts' on the server; this
// component sends a Contact id and an opaque request id and shows what comes back.

export const AI_CONVERSATION_POLL_MS = 1_200

const STATE_LABELS: Record<AiConversationStateV1, string> = {
  queued: 'В очереди',
  dialing: 'Набор номера',
  ringing: 'Вызов',
  in_conversation: 'Идёт разговор',
  completed: 'Завершён',
  interrupted: 'Прерван',
  failed: 'Ошибка',
  outcome_unknown: 'Исход неизвестен',
  refused: 'Отклонён',
}

const FAILURE_LABELS: Record<AiConversationFailureCodeV1, string> = {
  voice_restricted: 'Звонки этому человеку запрещены — звонок не совершался.',
  voice_permission_unavailable: 'Не удалось проверить разрешение на звонки — звонок не совершался.',
  provider_rejected: 'Оператор связи отклонил вызов.',
  provider_failed: 'Сбой во время разговора.',
  interrupted: 'Собеседник прервал разговор.',
  outcome_unknown: 'Ответ оператора не получен. Автоматического повторного звонка не будет.',
  expired: 'Звонок не начался вовремя и отменён.',
}

const REFUSAL_LABELS: Record<StartAiConversationRefusalV1, string> = {
  unauthenticated: 'Сессия истекла. Войдите снова, чтобы звонить.',
  disabled: 'AI-звонки выключены.',
  contact_not_found: 'Контакт не найден.',
  identity_unconfirmed: 'Личность не подтверждена — AI-звонок недоступен.',
  identity_conflict: 'Есть конфликт личности — AI-звонок недоступен.',
  voice_restricted: 'Звонки этому человеку запрещены.',
  voice_permission_unavailable: 'Сервис разрешений недоступен. Попробуйте позже.',
  no_callable_phone: 'Нет текущего бесспорного номера для звонка.',
  busy: 'С этим человеком уже идёт AI-разговор.',
}

const ACTION_ERROR_LABELS: Record<string, string> = {
  invalid_request: 'Запрос не принят. Обновите страницу.',
  request_conflict: 'Запрос уже использован для другого звонка. Нажмите ещё раз.',
  unavailable: 'Сервис звонков недоступен. Попробуйте позже.',
}

const VARIANT_LABELS: Record<AiConversationSimulationVariantV1, string> = {
  success: 'Успешный разговор',
  interrupted: 'Обрыв разговора',
  provider_failure: 'Ошибка оператора',
  unknown_outcome: 'Исход неизвестен',
}

const QUALIFICATION_LABELS: Record<string, string> = {
  qualified: 'Квалифицирован',
  not_qualified: 'Не подходит',
  unclear: 'Неясно',
}

type Tone = 'ok' | 'warn' | 'bad' | 'muted' | 'live'
const TONE_CLASSES: Record<Tone, string> = {
  ok: 'bg-[#059669]/10 text-[#047857]',
  warn: 'bg-amber-100 text-amber-800',
  bad: 'bg-red-100 text-[#DC2626]',
  muted: 'bg-[#F1F5FD] text-[#64748B]',
  live: 'bg-[#2AABEE]/10 text-[#1E96D4]',
}

function stateTone(state: AiConversationStateV1): Tone {
  if (state === 'completed') return 'ok'
  if (state === 'interrupted' || state === 'outcome_unknown') return 'warn'
  if (state === 'failed' || state === 'refused') return 'bad'
  return 'live'
}

function newRequestId(): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`
  return `pc_${random.replace(/[^A-Za-z0-9]/gu, '')}`.slice(0, 64)
}

function formatTime(value: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function Badge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[12px] font-medium ${TONE_CLASSES[tone]}`}>{children}</span>
}

function Transcript({ conversation }: { conversation: AiConversationViewV1 }) {
  if (conversation.transcript.length === 0) {
    return <div className="px-4 py-3 text-[13px] text-[#64748B]">Реплик пока нет.</div>
  }
  return (
    <div className="flex flex-col gap-2 px-4 py-3" data-testid="ai-conversation-transcript">
      {conversation.transcript.map(line => (
        <div key={line.ordinal} className={`flex ${line.speaker === 'person' ? 'justify-end' : 'justify-start'}`}>
          <div className={`max-w-[80%] px-3 py-2 text-[15px] leading-[1.4] ${line.speaker === 'person'
            ? 'rounded-[16px] rounded-br-[4px] bg-[#2AABEE] text-white'
            : 'rounded-[16px] rounded-bl-[4px] bg-[#F1F5FD] text-[#0F172A]'}`}>
            <div className={`text-[11px] ${line.speaker === 'person' ? 'text-white/70' : 'text-[#64748B]'}`}>
              {line.speaker === 'person' ? 'Собеседник' : 'AI-ассистент'}
            </div>
            {line.text}
          </div>
        </div>
      ))}
    </div>
  )
}

function Details({ conversation }: { conversation: AiConversationViewV1 }) {
  return (
    <div className="border-t border-[#E4ECFC] bg-white">
      {conversation.failure && (
        <div className="px-4 pt-3 text-[13px] text-[#0F172A]" data-testid="ai-conversation-failure">{FAILURE_LABELS[conversation.failure]}</div>
      )}
      {conversation.occupiedUntil && (
        <div className="px-4 pt-1 text-[13px] text-[#64748B]">Новый звонок этому человеку — после {formatTime(conversation.occupiedUntil)}.</div>
      )}
      {conversation.outcome && (
        <div className="px-4 pt-3" data-testid="ai-conversation-outcome">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-medium text-[#0F172A]">Итог:</span>
            <Badge tone={conversation.outcome.qualification === 'qualified' ? 'ok' : 'muted'}>
              {QUALIFICATION_LABELS[conversation.outcome.qualification] ?? conversation.outcome.qualification}
            </Badge>
            {conversation.outcome.score !== null && <span className="text-[13px] text-[#64748B]">оценка {conversation.outcome.score}/100</span>}
          </div>
          {conversation.outcome.summary && <div className="mt-1 text-[13px] text-[#0F172A]">{conversation.outcome.summary}</div>}
        </div>
      )}
      <Transcript conversation={conversation} />
    </div>
  )
}

export default function AiConversationPanel({ contactId }: { contactId: string }) {
  const [mode, setMode] = useState<AiConversationRuntimeModeV1 | null>(null)
  const [conversations, setConversations] = useState<AiConversationViewV1[]>([])
  const [unauthenticated, setUnauthenticated] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [variant, setVariant] = useState<AiConversationSimulationVariantV1>('success')
  const [expanded, setExpanded] = useState<string | null>(null)
  const requestIdRef = useRef<string | null>(null)

  const load = useCallback(async () => {
    const answer = await listAiConversationsForContactActionV1({ contract: AI_CONVERSATIONS_FOR_CONTACT_QUERY_V1, contactId })
    if (!answer.ok) { setLoadError(ACTION_ERROR_LABELS[answer.error] ?? answer.error); return }
    setLoadError(null)
    if (answer.result.status === 'unauthenticated') { setUnauthenticated(true); return }
    setUnauthenticated(false)
    setMode(answer.result.mode)
    setConversations(answer.result.conversations)
  }, [contactId])

  useEffect(() => { void load() }, [load])

  const active = conversations.some(conversation => !isTerminalAiConversationStateV1(conversation.state))
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => { void load() }, AI_CONVERSATION_POLL_MS)
    return () => clearInterval(timer)
  }, [active, load])

  async function start() {
    if (pending) return
    setPending(true)
    setNotice(null)
    // One intent, one request id: a double click or a retry of the same intent replays it.
    if (requestIdRef.current === null) requestIdRef.current = newRequestId()
    try {
      const answer = await startAiConversationActionV1({
        contract: START_AI_CONVERSATION_COMMAND_V1,
        requestId: requestIdRef.current,
        contactId,
        ...(mode === 'simulated' ? { simulationVariant: variant } : {}),
      })
      if (!answer.ok) {
        setNotice(ACTION_ERROR_LABELS[answer.error] ?? answer.error)
        if (answer.error !== 'unavailable') requestIdRef.current = null
        return
      }
      requestIdRef.current = null
      const result = answer.result
      if (result.status === 'refused') {
        if (result.reason === 'unauthenticated') setUnauthenticated(true)
        setNotice(REFUSAL_LABELS[result.reason])
        if (result.activeConversationId) setExpanded(result.activeConversationId)
      } else {
        setExpanded(result.conversation.conversationId)
        if (result.duplicate) setNotice('Этот звонок уже запущен.')
      }
      await load()
    } finally {
      setPending(false)
    }
  }

  const disabled = pending || mode !== 'simulated' || unauthenticated || active
  return (
    <section className="rounded-xl border border-[#E4ECFC] bg-white" data-testid="ai-conversation-panel">
      <header className="flex items-center justify-between px-4 h-[44px] border-b border-[#E4ECFC]">
        <h2 className="text-[15px] font-semibold text-[#0F172A]">AI-звонки</h2>
        <span className="text-[12px] text-[#64748B]">{conversations.length}</span>
      </header>

      <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-[#E4ECFC]">
        <button
          type="button"
          onClick={start}
          disabled={disabled}
          data-testid="ai-conversation-start"
          className="h-[44px] rounded-lg bg-[#2AABEE] px-4 text-[15px] font-semibold text-white transition-colors duration-150 hover:bg-[#1E96D4] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? 'Запуск…' : 'AI-звонок'}
        </button>
        {mode === 'simulated' && (
          <label className="flex items-center gap-2 text-[13px] text-[#64748B]">
            Сценарий
            <select
              value={variant}
              onChange={event => setVariant(event.target.value as AiConversationSimulationVariantV1)}
              data-testid="ai-conversation-variant"
              className="h-[44px] rounded-lg border border-[#E4ECFC] bg-white px-2 text-[15px] text-[#0F172A] focus:border-[#2AABEE] focus:outline-none"
            >
              {(Object.keys(VARIANT_LABELS) as AiConversationSimulationVariantV1[]).map(key => (
                <option key={key} value={key}>{VARIANT_LABELS[key]}</option>
              ))}
            </select>
          </label>
        )}
        {mode === 'simulated' && <Badge tone="muted">Симуляция — реальный звонок не совершается</Badge>}
        {mode === 'disabled' && !unauthenticated && (
          <span className="text-[13px] text-[#64748B]">AI-звонки выключены. Для проверки включите Mock-режим: Настройки → AI-обзвон → API ключи.</span>
        )}
        {active && <span className="text-[13px] text-[#64748B]">Дождитесь завершения текущего разговора.</span>}
      </div>

      {unauthenticated && (
        <div className="px-4 py-3 text-[13px] text-[#0F172A] border-b border-[#E4ECFC]" data-testid="ai-conversation-unauthenticated">
          Сессия истекла.{' '}
          <a href={`/settings/integrations/access?next=${encodeURIComponent(`/contacts/${contactId}`)}`} className="font-medium text-[#2AABEE]">Войти</a>
        </div>
      )}
      {notice && <div className="px-4 py-3 text-[13px] text-[#0F172A] border-b border-[#E4ECFC]" role="status" data-testid="ai-conversation-notice">{notice}</div>}
      {loadError && <div className="px-4 py-3 text-[13px] text-[#DC2626] border-b border-[#E4ECFC]">{loadError}</div>}

      {mode === null && !unauthenticated && !loadError && <div className="m-4 h-[40px] rounded-lg bg-[#F1F5FD] animate-pulse" />}
      {mode !== null && conversations.length === 0 && <div className="px-4 py-4 text-[13px] text-[#64748B]">AI-звонков этому человеку ещё не было.</div>}

      {conversations.map(conversation => {
        const open = expanded === conversation.conversationId || !isTerminalAiConversationStateV1(conversation.state)
        return (
          <div key={conversation.conversationId} className="border-b border-[#E4ECFC] last:border-b-0" data-testid="ai-conversation-row">
            <button
              type="button"
              onClick={() => setExpanded(open && expanded === conversation.conversationId ? null : conversation.conversationId)}
              className="flex w-full items-center gap-3 px-4 min-h-[56px] py-2 text-left hover:bg-[#F1F5FD]"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={stateTone(conversation.state)}>{STATE_LABELS[conversation.state]}</Badge>
                  <span className="text-[15px] font-medium text-[#0F172A]">{conversation.destinationMasked}</span>
                  {conversation.mode === 'simulated' && <Badge tone="muted">симуляция</Badge>}
                </div>
                <div className="mt-0.5 text-[13px] text-[#64748B] truncate">
                  {conversation.outcome?.summary ?? (conversation.failure ? FAILURE_LABELS[conversation.failure] : `${conversation.transcript.length} реплик`)}
                </div>
              </div>
              <span className="text-[12px] text-[#64748B] whitespace-nowrap">{formatTime(conversation.startedAt)}</span>
            </button>
            {open && <Details conversation={conversation} />}
          </div>
        )
      })}
    </section>
  )
}
