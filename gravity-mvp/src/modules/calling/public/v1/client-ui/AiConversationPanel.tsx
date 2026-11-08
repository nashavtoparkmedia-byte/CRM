"use client"

import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
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
  contact_changed: 'Карточка изменилась, обновите страницу.',
  identity_unconfirmed: 'Личность не подтверждена — AI-звонок недоступен.',
  identity_conflict: 'Есть конфликт личности — AI-звонок недоступен.',
  voice_restricted: 'Звонки этому человеку запрещены.',
  voice_permission_unavailable: 'Не удалось проверить разрешение на звонки. Попробуйте позже.',
  no_primary_phone: 'Нет подтверждённого основного телефона.',
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

/** The card must never fail because of Calling: a render error here becomes one muted line. */
class PanelBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error: unknown) { console.error('[ai-conversation] panel failed:', error instanceof Error ? error.message : error) }
  render() {
    if (this.state.failed) return <div className="rounded-xl border border-[#E4ECFC] bg-white px-4 py-3 text-[13px] text-[#64748B]">AI-звонки сейчас недоступны.</div>
    return this.props.children
  }
}

function ConversationRow({ conversation, open, onToggle }: { conversation: AiConversationViewV1; open: boolean; onToggle: () => void }) {
  return (
    <div className="border-t border-[#E4ECFC]" data-testid="ai-conversation-row">
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-3 px-4 min-h-[56px] py-2 text-left hover:bg-[#F1F5FD]">
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
}

function AiConversationPanelBody({ contactId }: { contactId: string }) {
  const [mode, setMode] = useState<AiConversationRuntimeModeV1 | null>(null)
  const [conversations, setConversations] = useState<AiConversationViewV1[]>([])
  const [unauthenticated, setUnauthenticated] = useState(false)
  const [changed, setChanged] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [variant, setVariant] = useState<AiConversationSimulationVariantV1>('success')
  const [expanded, setExpanded] = useState<string | null>(null)
  const requestIdRef = useRef<string | null>(null)

  const load = useCallback(async () => {
    let answer
    try {
      answer = await listAiConversationsForContactActionV1({ contract: AI_CONVERSATIONS_FOR_CONTACT_QUERY_V1, contactId })
    } catch {
      setLoadError(ACTION_ERROR_LABELS.unavailable)
      return
    }
    if (!answer.ok) { setLoadError(ACTION_ERROR_LABELS[answer.error] ?? answer.error); return }
    setLoadError(null)
    if (answer.result.status === 'unauthenticated') { setUnauthenticated(true); return }
    if (answer.result.status === 'contact_changed') { setChanged(true); return }
    setUnauthenticated(false)
    setChanged(false)
    setMode(answer.result.mode)
    setConversations(answer.result.conversations)
  }, [contactId])

  useEffect(() => { void load() }, [load])

  const active = conversations.some(conversation => !isTerminalAiConversationStateV1(conversation.state))
  useEffect(() => {
    if (!active || changed || unauthenticated) return
    const timer = setInterval(() => { void load() }, AI_CONVERSATION_POLL_MS)
    return () => clearInterval(timer)
  }, [active, changed, unauthenticated, load])

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
        if (result.reason === 'contact_changed') setChanged(true)
        setNotice(REFUSAL_LABELS[result.reason])
      } else if (result.duplicate) {
        setNotice('Этот звонок уже запущен.')
      }
      await load()
    } catch {
      setNotice(ACTION_ERROR_LABELS.unavailable)
    } finally {
      setPending(false)
    }
  }

  // OFF state: nothing on the card. Unknown yet: nothing either, so the card never jumps.
  if (!unauthenticated && !changed && !loadError && mode !== 'simulated') return null
  if (loadError && mode === null) return <div className="rounded-xl border border-[#E4ECFC] bg-white px-4 py-3 text-[13px] text-[#64748B]">AI-звонки сейчас недоступны.</div>

  const latest = conversations[0] ?? null
  const disabled = pending || unauthenticated || changed || active
  return (
    <section className="rounded-xl border border-[#E4ECFC] bg-white" data-testid="ai-conversation-panel">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
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
          <select
            value={variant}
            onChange={event => setVariant(event.target.value as AiConversationSimulationVariantV1)}
            aria-label="Сценарий симуляции"
            data-testid="ai-conversation-variant"
            className="h-[44px] rounded-lg border border-[#E4ECFC] bg-white px-2 text-[15px] text-[#0F172A] focus:border-[#2AABEE] focus:outline-none"
          >
            {(Object.keys(VARIANT_LABELS) as AiConversationSimulationVariantV1[]).map(key => (
              <option key={key} value={key}>{VARIANT_LABELS[key]}</option>
            ))}
          </select>
        )}
        <div className="min-w-0 flex-1 text-[13px] text-[#64748B]" data-testid="ai-conversation-status">
          {latest ? (
            <span className="inline-flex flex-wrap items-center gap-2">
              <Badge tone={stateTone(latest.state)}>{STATE_LABELS[latest.state]}</Badge>
              <span className="truncate">
                {latest.outcome?.summary ?? (latest.failure ? FAILURE_LABELS[latest.failure] : formatTime(latest.startedAt))}
              </span>
            </span>
          ) : 'AI-звонков ещё не было. Симуляция — реальный звонок не совершается.'}
        </div>
      </div>

      {unauthenticated && (
        <div className="px-4 py-3 text-[13px] text-[#0F172A] border-t border-[#E4ECFC]" data-testid="ai-conversation-unauthenticated">
          Сессия истекла.{' '}
          <a href={`/settings/integrations/access?next=${encodeURIComponent(`/contacts/${contactId}`)}`} className="font-medium text-[#2AABEE]">Войти</a>
        </div>
      )}
      {changed && !notice && <div className="px-4 py-3 text-[13px] text-[#0F172A] border-t border-[#E4ECFC]" role="status">{REFUSAL_LABELS.contact_changed}</div>}
      {notice && <div className="px-4 py-3 text-[13px] text-[#0F172A] border-t border-[#E4ECFC]" role="status" data-testid="ai-conversation-notice">{notice}</div>}
      {loadError && <div className="px-4 py-3 text-[13px] text-[#64748B] border-t border-[#E4ECFC]">{loadError}</div>}

      {conversations.length > 0 && (
        <details className="border-t border-[#E4ECFC]" data-testid="ai-conversation-history">
          <summary className="cursor-pointer px-4 h-[44px] flex items-center text-[13px] text-[#64748B] hover:bg-[#F1F5FD]">
            История AI-звонков ({conversations.length})
          </summary>
          {conversations.map(conversation => (
            <ConversationRow
              key={conversation.conversationId}
              conversation={conversation}
              open={expanded === conversation.conversationId}
              onToggle={() => setExpanded(expanded === conversation.conversationId ? null : conversation.conversationId)}
            />
          ))}
        </details>
      )}
    </section>
  )
}

export default function AiConversationPanel({ contactId }: { contactId: string }) {
  return <PanelBoundary><AiConversationPanelBody contactId={contactId} /></PanelBoundary>
}
