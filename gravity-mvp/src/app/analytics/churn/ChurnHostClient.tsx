'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { evaluateChurnTriggerAction, startChurnSandboxRunAction, type ChurnEvaluationView } from './actions'

type MessageOutcome = 'accepted' | 'refused' | 'indeterminate'
type CallOutcome = 'answered' | 'no_answer' | 'failed' | 'indeterminate'

const MESSAGE_OPTIONS: Array<[MessageOutcome, string]> = [['accepted', 'Сообщение принято'], ['refused', 'Отклонено'], ['indeterminate', 'Исход неизвестен']]
const CALL_OPTIONS: Array<[CallOutcome, string]> = [['answered', 'Звонок: ответит'], ['no_answer', 'Не ответит'], ['failed', 'Ошибка'], ['indeterminate', 'Исход неизвестен']]

function newRequestKey(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export default function ChurnHostClient({ initial }: { initial: ChurnEvaluationView }) {
  const router = useRouter()
  const [days, setDays] = useState(initial.minInactiveDays)
  const [evaluation, setEvaluation] = useState(initial)
  const [selected, setSelected] = useState<Record<string, { message: MessageOutcome; call: CallOutcome }>>({})
  const [waitSeconds, setWaitSeconds] = useState(20)
  const [cooldownSeconds, setCooldownSeconds] = useState(60)
  const [requestKey, setRequestKey] = useState(newRequestKey)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const selectedIds = useMemo(() => Object.keys(selected), [selected])

  function check() {
    setError(null)
    startTransition(async () => {
      try {
        setEvaluation(await evaluateChurnTriggerAction(days))
        setSelected({})
        setRequestKey(newRequestKey())
      } catch {
        setError('Не удалось проверить триггер')
      }
    })
  }

  function toggle(contactId: string) {
    setSelected((current) => {
      const next = { ...current }
      if (next[contactId]) delete next[contactId]
      else if (Object.keys(next).length < 20) next[contactId] = { message: 'accepted', call: 'answered' }
      return next
    })
  }

  function start() {
    setError(null)
    startTransition(async () => {
      try {
        const result = await startChurnSandboxRunAction({
          requestKey,
          minInactiveDays: evaluation.minInactiveDays,
          allowlistContactIds: selectedIds,
          waitSeconds,
          cooldownSeconds,
          simulatedOutcomes: selected,
        })
        if (result.outcome === 'refused') {
          setError(result.reason === 'audience_empty' ? 'Под триггер никто не подошёл' : 'Запуск отклонён')
          return
        }
        router.push(`/analytics/churn/runs/${result.runId}`)
      } catch {
        setError('Не удалось запустить сценарий')
      }
    })
  }

  return (
    <section className="space-y-3 rounded-xl border border-[#E4ECFC] p-4">
      <h2 className="text-[17px] font-semibold">Триггер и Sandbox</h2>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="block text-[13px] font-medium">Не выполнял заказы, дней (≥)</span>
          <input type="number" min={1} max={365} value={days} onChange={(event) => setDays(Number(event.target.value) || 1)}
            className="mt-1 h-11 w-28 rounded-lg border border-[#E4ECFC] px-3 text-[15px] focus:border-[#2AABEE] focus:outline-none" />
        </label>
        <button type="button" onClick={check} disabled={pending}
          className="h-11 rounded-lg border border-[#E4ECFC] px-4 text-[15px] font-semibold hover:bg-[#F1F5FD] disabled:opacity-60">Проверить триггер</button>
      </div>
      <p className="text-[14px] text-[#64748B]">
        Подошли: <b className="text-[#0F172A]">{evaluation.matched.length}</b>
        {evaluation.withoutContact > 0 ? ` · без контакта (не адресуемы): ${evaluation.withoutContact}` : ''}
        {evaluation.truncated ? ' · список ограничен' : ''}
        {' · '}проверено {new Date(evaluation.asOf).toLocaleString('ru-RU')}
      </p>
      {evaluation.matched.length > 0 && (
        <ul className="divide-y divide-[#E4ECFC] rounded-lg border border-[#E4ECFC]">
          {evaluation.matched.slice(0, 100).map((match) => {
            const pick = selected[match.contactId]
            return (
              <li key={match.driverId} className="flex min-h-[56px] flex-wrap items-center gap-3 px-3 py-2">
                <input type="checkbox" checked={Boolean(pick)} onChange={() => toggle(match.contactId)} aria-label="Тестовый контакт Sandbox" className="h-5 w-5" />
                <div className="min-w-[160px] flex-1">
                  <div className="text-[15px] font-medium">{match.fullName}</div>
                  <div className="text-[12px] text-[#64748B]">нет заказов {match.inactiveDays} дн. · последний {new Date(match.lastOrderAt).toLocaleDateString('ru-RU')}</div>
                </div>
                {pick && (
                  <div className="flex gap-2">
                    <select value={pick.message} onChange={(event) => setSelected((current) => ({ ...current, [match.contactId]: { ...pick, message: event.target.value as MessageOutcome } }))}
                      className="h-9 rounded-md border border-[#E4ECFC] px-2 text-[13px]">
                      {MESSAGE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                    <select value={pick.call} onChange={(event) => setSelected((current) => ({ ...current, [match.contactId]: { ...pick, call: event.target.value as CallOutcome } }))}
                      className="h-9 rounded-md border border-[#E4ECFC] px-2 text-[13px]">
                      {CALL_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="block text-[13px] font-medium">Ожидание ответа в Sandbox, сек</span>
          <input type="number" min={0} max={3600} value={waitSeconds} onChange={(event) => setWaitSeconds(Math.max(0, Number(event.target.value) || 0))}
            className="mt-1 h-11 w-28 rounded-lg border border-[#E4ECFC] px-3 text-[15px] focus:border-[#2AABEE] focus:outline-none" />
        </label>
        <label className="block">
          <span className="block text-[13px] font-medium">Пауза между сценариями, сек</span>
          <input type="number" min={0} max={86400} value={cooldownSeconds} onChange={(event) => setCooldownSeconds(Math.max(0, Number(event.target.value) || 0))}
            className="mt-1 h-11 w-28 rounded-lg border border-[#E4ECFC] px-3 text-[15px] focus:border-[#2AABEE] focus:outline-none" />
        </label>
        <button type="button" onClick={start} disabled={pending || selectedIds.length === 0}
          className="h-11 rounded-lg bg-[#2AABEE] px-4 text-[15px] font-semibold text-white hover:bg-[#1E96D4] disabled:opacity-60">
          Запустить в Sandbox ({selectedIds.length})
        </button>
      </div>
      <p className="text-[12px] text-[#64748B]">В Sandbox исполняются только отмеченные тестовые контакты — остальные из выборки попадут в отчёт как «Не тестовый контакт». Повторное нажатие не создаст второй запуск.</p>
      {error && <p className="text-[14px] text-[#DC2626]">{error}</p>}
    </section>
  )
}
