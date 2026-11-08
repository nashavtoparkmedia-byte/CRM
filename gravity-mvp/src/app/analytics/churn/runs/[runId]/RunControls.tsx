'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { advanceRunAction, simulateReplyAction } from '../../actions'

/**
 * Drives the Run while the page is open. Every step still goes through the
 * execution core's leases and version checks, so two open pages (or a page and
 * a worker) never perform the same step twice.
 */
export default function RunControls({ runId, inProgress, canSimulateReply, waiting }: {
  runId: string
  inProgress: number
  canSimulateReply: boolean
  waiting: Array<{ participantId: string; name: string }>
}) {
  const router = useRouter()
  const [auto, setAuto] = useState(inProgress > 0)
  const [pending, startTransition] = useTransition()
  const [note, setNote] = useState<string | null>(null)
  const busy = useRef(false)

  function advance() {
    if (busy.current) return
    busy.current = true
    startTransition(async () => {
      try {
        const result = await advanceRunAction(runId)
        setNote(`Шагов выполнено: ${result.moved}${result.repliesStopped ? ` · остановлено по ответу: ${result.repliesStopped}` : ''}`)
        router.refresh()
      } catch {
        setNote('Не удалось выполнить шаги')
      } finally {
        busy.current = false
      }
    })
  }

  useEffect(() => {
    if (!auto || inProgress === 0) return
    const timer = setInterval(advance, 3000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, inProgress, runId])

  function reply(participantId: string) {
    startTransition(async () => {
      const result = await simulateReplyAction(participantId)
      setNote(result.ok ? 'Ответ записан (симуляция). Следующий шаг остановит сценарий для этого контакта.' : 'Ответ не записан')
      router.refresh()
    })
  }

  return (
    <section className="space-y-2 rounded-xl border border-[#E4ECFC] p-4">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={advance} disabled={pending}
          className="h-11 rounded-lg bg-[#2AABEE] px-4 text-[15px] font-semibold text-white hover:bg-[#1E96D4] disabled:opacity-60">Выполнить шаги</button>
        <label className="flex items-center gap-2 text-[14px]">
          <input type="checkbox" checked={auto} onChange={(event) => setAuto(event.target.checked)} className="h-5 w-5" />
          Автоматически, пока страница открыта
        </label>
        <span className="text-[13px] text-[#64748B]">В работе: {inProgress}</span>
      </div>
      {canSimulateReply && waiting.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {waiting.map((item) => (
            <button key={item.participantId} type="button" onClick={() => reply(item.participantId)} disabled={pending}
              className="h-9 rounded-lg border border-[#E4ECFC] px-3 text-[13px] hover:bg-[#F1F5FD]">
              Симулировать ответ: {item.name}
            </button>
          ))}
        </div>
      )}
      {note && <p className="text-[13px] text-[#64748B]">{note}</p>}
    </section>
  )
}
