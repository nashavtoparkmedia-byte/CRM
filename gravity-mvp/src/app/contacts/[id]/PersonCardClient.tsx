'use client'

// The interactive parts of «Карточка человека» (Contact Identity V2). Every
// action calls an operation CRM already has; this file decides nothing about who
// a person is. The server answers each request under its own authority, and a
// refusal is shown as such, never hidden or retried behind the operator's back.

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import DriverPersonSearchModal from '@/app/messages/components/DriverPersonSearchModal'

export type MessengerRowV1 = {
  key: string
  identityId: string | null
  phoneId: string | null
  channel: string
  channelLabel: string
  account: string
  reachability: 'confirmed' | 'unreachable' | 'unknown'
  bot: 'linked' | 'not_linked' | 'unknown' | 'not_applicable'
  preference: 'primary' | 'additional' | null
  /** The exact conversation of this account when it is known; otherwise «Написать» asks the server for it. */
  conversationId: string | null
  channelTab: string | null
  writable: boolean
  note: string | null
}

export type CardConversationV1 = { channel: string; channelLabel: string; conversationId: string; channelTab: string | null; count: number }

const MERGE_REASON_TEXT: Record<string, string> = {
  manual_canonical_pin: 'карточка закреплена вручную',
  substantive_contact: 'в ней больше данных о человеке',
  current_workflows: 'у неё есть активные процессы',
  richer_history: 'у неё больше истории',
  confirmed_physical_driver: 'она подтверждена как водитель',
  older_contact: 'она создана раньше',
  immutable_id: 'порядок идентификаторов',
}

const REFUSALS: Record<number, string> = {
  401: 'Нет прав на это действие. Войдите в CRM со своим паролем или через «Доступ к интеграциям».',
  403: 'Запрос отклонён проверкой безопасности.',
}

function messagesHref(conversationId: string, channelTab: string | null): string {
  const params = new URLSearchParams({ id: conversationId })
  if (channelTab) params.set('channel', channelTab)
  return `/messages?${params.toString()}`
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json()
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function Pill({ tone, children }: { tone: 'ok' | 'bad' | 'muted' | 'info'; children: React.ReactNode }) {
  const classes = {
    ok: 'bg-[#059669]/10 text-[#047857]',
    bad: 'bg-red-100 text-[#DC2626]',
    muted: 'bg-[#F1F5FD] text-[#64748B]',
    info: 'bg-[#2AABEE]/10 text-[#1E96D4]',
  }[tone]
  return <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[12px] font-medium ${classes}`}>{children}</span>
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="w-full max-w-[480px] rounded-xl bg-white p-6">
        <h2 className="text-[17px] font-semibold text-[#0F172A]">{title}</h2>
        <div className="mt-4">{children}</div>
        <div className="mt-6 flex justify-end">
          <button type="button" onClick={onClose} className="h-11 rounded-lg border border-[#E4ECFC] px-4 text-[15px] text-[#0F172A] hover:bg-[#F1F5FD]">Отмена</button>
        </div>
      </div>
    </div>
  )
}

// ── Block 2: «Мессенджеры» ───────────────────────────────────────────────────

export function MessengersTable({ contactId, rows }: { contactId: string; rows: MessengerRowV1[] }) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // «Проверить» (W5): the server resolves the number from this row's ids; the answer is a state, never a number.
  const [checked, setChecked] = useState<Record<string, 'confirmed' | 'unreachable' | 'checking'>>({})
  const checkable = (row: MessengerRowV1) => (row.channel === 'telegram' || row.channel === 'whatsapp' || row.channel === 'max') && (row.phoneId !== null || row.identityId !== null)

  async function check(row: MessengerRowV1) {
    setError(null)
    setBusy(`check:${row.key}`)
    try {
      const response = await fetch(`/contacts/${encodeURIComponent(contactId)}/reachability`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: row.channel, phoneId: row.phoneId, identityId: row.identityId }),
      })
      const body = await readJson(response)
      if (response.ok && (body.status === 'confirmed' || body.status === 'unreachable' || body.status === 'checking')) {
        setChecked(previous => ({ ...previous, [row.key]: body.status as 'confirmed' | 'unreachable' | 'checking' }))
        if (body.status !== 'checking') router.refresh()
        return
      }
      setError(REFUSALS[response.status] ?? 'Проверка не выполнена.')
    } catch {
      setError('Проверка не выполнена: сервер недоступен.')
    } finally {
      setBusy(null)
    }
  }

  async function write(row: MessengerRowV1) {
    setError(null)
    if (row.conversationId) {
      router.push(messagesHref(row.conversationId, row.channelTab))
      return
    }
    if (!row.identityId) return
    setBusy(row.key)
    try {
      const response = await fetch(`/api/contacts/${encodeURIComponent(contactId)}/chats`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: row.channel, identityId: row.identityId }),
      })
      const body = await readJson(response)
      const chat = body.chat && typeof body.chat === 'object' ? body.chat as Record<string, unknown> : null
      if (response.ok && chat && typeof chat.id === 'string') {
        router.push(messagesHref(chat.id, row.channelTab))
        return
      }
      setError(REFUSALS[response.status] ?? (typeof body.message === 'string' ? body.message : 'Не удалось открыть переписку с этим аккаунтом.'))
    } catch {
      setError('Не удалось открыть переписку: сервер недоступен.')
    } finally {
      setBusy(null)
    }
  }

  if (rows.length === 0) return <div className="px-4 py-4 text-[13px] text-[#64748B]">Аккаунтов мессенджеров и телефонов для проверки нет.</div>
  return (
    <div>
      {error && <div className="mx-4 mt-3 rounded-lg bg-red-50 px-3 py-2 text-[13px] text-[#DC2626]" role="alert">{error}</div>}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left">
          <thead>
            <tr className="bg-[#F1F5FD] text-[13px] text-[#64748B]">
              <th className="px-4 py-2 font-medium">Мессенджер</th>
              <th className="px-4 py-2 font-medium">Номер / аккаунт</th>
              <th className="px-4 py-2 font-medium">Есть на номере</th>
              <th className="px-4 py-2 font-medium">ТГ-бот</th>
              <th className="px-4 py-2 font-medium">Для связи</th>
              <th className="px-4 py-2 font-medium">Действие</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.key} className="border-b border-[#E4ECFC] last:border-b-0 text-[14px] text-[#0F172A]">
                <td className="px-4 py-3 font-medium">{row.channelLabel}</td>
                <td className="px-4 py-3">
                  <div>{row.account}</div>
                  {row.note && <div className="text-[12px] text-[#64748B]">{row.note}</div>}
                </td>
                <td className="px-4 py-3">
                  {(checked[row.key] ?? row.reachability) === 'confirmed' && <Pill tone="ok">Есть</Pill>}
                  {(checked[row.key] ?? row.reachability) === 'unreachable' && <Pill tone="bad">Нет</Pill>}
                  {(checked[row.key] ?? row.reachability) === 'unknown' && <Pill tone="muted">Не проверен</Pill>}
                  {checked[row.key] === 'checking' && <Pill tone="info">Проверяется</Pill>}
                </td>
                <td className="px-4 py-3">
                  {row.bot === 'linked' && <Pill tone="ok">Да</Pill>}
                  {row.bot === 'not_linked' && <Pill tone="bad">Нет</Pill>}
                  {row.bot === 'unknown' && <Pill tone="muted">неизвестно</Pill>}
                  {row.bot === 'not_applicable' && <span className="text-[#64748B]">—</span>}
                </td>
                <td className="px-4 py-3">
                  {row.preference === 'primary' && <Pill tone="ok">Основной</Pill>}
                  {row.preference === 'additional' && <Pill tone="muted">Дополнительный</Pill>}
                  {row.preference === null && <span className="text-[#64748B]">—</span>}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-4">
                    {row.writable && (
                      <button type="button" disabled={busy === row.key} onClick={() => write(row)} className="text-[14px] font-medium text-[#2AABEE] hover:text-[#1E96D4] disabled:opacity-60">
                        {busy === row.key ? 'Открываю…' : 'Написать'}
                      </button>
                    )}
                    {checkable(row) && (
                      <button type="button" disabled={busy === `check:${row.key}`} onClick={() => check(row)} className="text-[14px] font-medium text-[#2AABEE] hover:text-[#1E96D4] disabled:opacity-60">
                        {busy === `check:${row.key}` ? 'Проверяю…' : 'Проверить'}
                      </button>
                    )}
                    {!row.writable && !checkable(row) && <span className="text-[#64748B]">—</span>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Block 3: «Действия и управление» ──────────────────────────────────────────

type LookupItem = { contactId: string; displayTitle: string }

function MergeDialog({ contactId, displayName, onClose }: { contactId: string; displayName: string; onClose: () => void }) {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<LookupItem[]>([])
  const [picked, setPicked] = useState<LookupItem | null>(null)
  const [preview, setPreview] = useState<{ survivorContactId: string; reasons: string[] } | { unavailable: string } | null>(null)
  const [state, setState] = useState<'idle' | 'searching' | 'previewing' | 'merging'>('idle')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const text = query.trim()
    if (text.length < 2 || picked) { setItems([]); return }
    const timer = setTimeout(async () => {
      setState('searching')
      try {
        const response = await fetch(`/api/contacts/lookup?q=${encodeURIComponent(text)}&limit=8`, { cache: 'no-store' })
        const body = await readJson(response)
        const list = Array.isArray(body.items) ? body.items as Array<Record<string, unknown>> : []
        setItems(list.flatMap(item => typeof item.contactId === 'string' && item.contactId !== contactId
          ? [{ contactId: item.contactId, displayTitle: typeof item.displayTitle === 'string' ? item.displayTitle : item.contactId }]
          : []))
      } finally {
        setState('idle')
      }
    }, 300)
    return () => clearTimeout(timer)
  }, [query, picked, contactId])

  async function pick(item: LookupItem) {
    setPicked(item)
    setPreview(null)
    setError(null)
    setState('previewing')
    try {
      const response = await fetch(`/api/contacts/${encodeURIComponent(contactId)}/merge-preview?target=${encodeURIComponent(item.contactId)}`, { cache: 'no-store' })
      const body = await readJson(response)
      if (!response.ok) { setError(REFUSALS[response.status] ?? 'Не удалось получить решение политики объединения.'); return }
      if (body.status === 'previewed' && typeof body.survivorContactId === 'string') {
        setPreview({ survivorContactId: body.survivorContactId, reasons: Array.isArray(body.reasons) ? body.reasons.filter((r): r is string => typeof r === 'string') : [] })
      } else {
        setPreview({ unavailable: typeof body.reason === 'string' ? body.reason : 'unknown' })
      }
    } finally {
      setState('idle')
    }
  }

  async function merge() {
    if (!picked || !preview || 'unavailable' in preview) return
    setState('merging')
    setError(null)
    try {
      const response = await fetch(`/api/contacts/${encodeURIComponent(contactId)}/merge-to/${encodeURIComponent(picked.contactId)}`, { method: 'POST' })
      const body = await readJson(response)
      if (!response.ok) {
        setError(REFUSALS[response.status] ?? (typeof body.error === 'string' ? `Объединение отклонено: ${body.error}` : 'Объединение отклонено.'))
        return
      }
      const survivor = typeof body.survivorId === 'string' ? body.survivorId : typeof body.targetId === 'string' ? body.targetId : preview.survivorContactId
      router.push(`/contacts/${encodeURIComponent(survivor)}`)
      router.refresh()
      onClose()
    } catch {
      setError('Объединение не выполнено: сервер недоступен.')
    } finally {
      setState('idle')
    }
  }

  const survivorName = preview && !('unavailable' in preview)
    ? (preview.survivorContactId === contactId ? displayName : picked?.displayTitle ?? preview.survivorContactId)
    : null
  const unavailableText: Record<string, string> = {
    same_contact: 'Это тот же контакт.',
    missing: 'Контакт не найден.',
    archived: 'Один из контактов уже объединён или в архиве.',
    merge_forbidden: 'Для одного из контактов объединение запрещено.',
  }

  return (
    <Modal title="Объединить контакт" onClose={onClose}>
      {!picked ? (
        <>
          <label htmlFor="merge-search" className="block text-[13px] font-medium text-[#0F172A]">Найдите контакт по ФИО или номеру</label>
          <input id="merge-search" value={query} onChange={event => setQuery(event.target.value)} autoComplete="off" placeholder="ФИО или телефон"
            className="mt-1 h-11 w-full rounded-lg border border-[#E4ECFC] px-3 text-[15px] outline-none focus:border-[#2AABEE]" />
          {state === 'searching' && <div className="mt-2 h-10 animate-pulse rounded-lg bg-[#F1F5FD]" />}
          <ul className="mt-2">
            {items.map(item => (
              <li key={item.contactId}>
                <button type="button" onClick={() => pick(item)} className="flex min-h-[44px] w-full items-center rounded-lg px-3 text-left text-[15px] text-[#0F172A] hover:bg-[#F1F5FD]">{item.displayTitle}</button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <div className="text-[15px] text-[#0F172A]">
          <div>Объединить «{displayName}» и «{picked.displayTitle}».</div>
          {state === 'previewing' && <div className="mt-3 h-10 animate-pulse rounded-lg bg-[#F1F5FD]" />}
          {preview && 'unavailable' in preview && <div className="mt-3 text-[#DC2626]">{unavailableText[preview.unavailable] ?? 'Объединение сейчас невозможно.'}</div>}
          {survivorName && preview && !('unavailable' in preview) && (
            <div className="mt-3 rounded-lg bg-[#F1F5FD] px-3 py-2 text-[14px]">
              Останется карточка <b>«{survivorName}»</b>: так решает действующая политика объединения
              {preview.reasons[0] ? ` (${MERGE_REASON_TEXT[preview.reasons[0]] ?? preview.reasons[0]})` : ''}. Телефоны, аккаунты и переписки второй карточки перейдут в неё.
            </div>
          )}
          {error && <div className="mt-3 text-[13px] text-[#DC2626]" role="alert">{error}</div>}
          <div className="mt-4 flex gap-2">
            <button type="button" onClick={() => { setPicked(null); setPreview(null) }} className="h-11 rounded-lg border border-[#E4ECFC] px-4 text-[15px] hover:bg-[#F1F5FD]">Другой контакт</button>
            <button type="button" disabled={!preview || 'unavailable' in preview || state === 'merging'} onClick={merge}
              className="h-11 rounded-lg bg-[#2AABEE] px-4 text-[15px] font-semibold text-white hover:bg-[#1E96D4] disabled:opacity-60">
              {state === 'merging' ? 'Объединяю…' : 'Объединить'}
            </button>
          </div>
        </div>
      )}
      {!picked && error && <div className="mt-3 text-[13px] text-[#DC2626]" role="alert">{error}</div>}
    </Modal>
  )
}

function AddPhoneDialog({ contactId, onClose }: { contactId: string; onClose: () => void }) {
  const router = useRouter()
  const [phone, setPhone] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function add(event: React.FormEvent) {
    event.preventDefault()
    if (phone.trim() === '' || busy) return
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(`/api/contacts/${encodeURIComponent(contactId)}/phones`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, isPrimary: false }),
      })
      const body = await readJson(response)
      if (response.ok) { router.refresh(); onClose(); return }
      if (response.status === 409) setError('Этот номер уже у другого контакта. Если это один человек, объедините контакты.')
      else if (response.status === 400) setError('Номер не распознан. Проверьте код страны и количество цифр.')
      else setError(REFUSALS[response.status] ?? (typeof body.message === 'string' ? body.message : 'Номер не добавлен.'))
    } catch {
      setError('Номер не добавлен: сервер недоступен.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Добавить номер" onClose={onClose}>
      <form onSubmit={add}>
        <label htmlFor="add-phone" className="block text-[13px] font-medium text-[#0F172A]">Номер телефона</label>
        <input id="add-phone" value={phone} onChange={event => setPhone(event.target.value)} autoComplete="off" placeholder="+7 999 000-00-00 или +998 …"
          className="mt-1 h-11 w-full rounded-lg border border-[#E4ECFC] px-3 text-[15px] outline-none focus:border-[#2AABEE]" />
        {error && <div className="mt-3 text-[13px] text-[#DC2626]" role="alert">{error}</div>}
        <button type="submit" disabled={busy} className="mt-4 h-11 rounded-lg bg-[#2AABEE] px-4 text-[15px] font-semibold text-white hover:bg-[#1E96D4] disabled:opacity-60">
          {busy ? 'Добавляю…' : 'Добавить'}
        </button>
      </form>
    </Modal>
  )
}

// ── Block 3: «Ограничения связи» (Q4: three flags, a required reason, every staff role sets and lifts) ──

type Restriction = { denyAll: boolean; denyMessage: boolean; denyVoice: boolean }
type RestrictionState = { version: number; restriction: Restriction }

const RESTRICTION_FLAGS: Array<{ key: keyof Restriction; label: string; hint: string }> = [
  { key: 'denyAll', label: 'Не связываться совсем', hint: 'ни сообщений, ни звонков' },
  { key: 'denyMessage', label: 'Не писать', hint: 'сообщения во всех мессенджерах' },
  { key: 'denyVoice', label: 'Не звонить', hint: 'обычные и ИИ-звонки' },
]

export function restrictionSummaryV1(restriction: Restriction): string {
  if (restriction.denyAll) return 'не связываться совсем'
  const parts = [restriction.denyMessage ? 'не писать' : null, restriction.denyVoice ? 'не звонить' : null].filter(Boolean)
  return parts.length === 0 ? 'нет' : parts.join(' · ')
}

async function readRestriction(contactId: string): Promise<RestrictionState | { refused: number }> {
  const response = await fetch(`/api/contacts/${encodeURIComponent(contactId)}/communication-policy`, { cache: 'no-store' })
  if (!response.ok) return { refused: response.status }
  const body = await readJson(response)
  const restriction = body.restriction as Restriction | undefined
  if (typeof body.version !== 'number' || !restriction) return { refused: 500 }
  return { version: body.version, restriction }
}

function newRequestId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `card-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function RestrictionsDialog({ contactId, current, onClose, onSaved }: {
  contactId: string
  current: RestrictionState
  onClose: () => void
  onSaved: (state: RestrictionState) => void
}) {
  const [draft, setDraft] = useState<Restriction>(current.restriction)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // One id per decision: a retry of the same click replays instead of deciding twice.
  const [requestId] = useState(newRequestId)
  const unchanged = RESTRICTION_FLAGS.every(flag => draft[flag.key] === current.restriction[flag.key])

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (busy) return
    if (reason.trim() === '') { setError('Укажите причину.'); return }
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(`/api/contacts/${encodeURIComponent(contactId)}/communication-policy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, expectedVersion: current.version, restriction: draft, reason }),
      })
      const body = await readJson(response)
      if (response.ok && typeof body.version === 'number') { onSaved({ version: body.version, restriction: body.restriction as Restriction }); return }
      if (response.status === 409 && body.code === 'VERSION_CONFLICT') setError('Пока окно было открыто, ограничения изменил кто-то другой. Закройте окно и откройте заново.')
      else if (response.status === 409 && body.code === 'CONTACT_MERGED') setError('Этот контакт объединён с другим. Откройте итоговую карточку.')
      else if (response.status === 400) setError('Укажите причину и проверьте выбранные ограничения.')
      else setError(REFUSALS[response.status] ?? 'Ограничения не сохранены.')
    } catch {
      setError('Ограничения не сохранены: сервер недоступен.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Ограничения связи" onClose={onClose}>
      <form onSubmit={save}>
        <ul className="rounded-xl border border-[#E4ECFC]">
          {RESTRICTION_FLAGS.map(flag => (
            <li key={flag.key} className="border-b border-[#E4ECFC] last:border-b-0">
              <label className="flex min-h-[56px] cursor-pointer items-center justify-between gap-3 px-4">
                <span>
                  <span className="block text-[15px] font-medium text-[#0F172A]">{flag.label}</span>
                  <span className="block text-[12px] text-[#64748B]">{flag.hint}</span>
                </span>
                <input type="checkbox" role="switch" aria-label={flag.label} checked={draft[flag.key]}
                  onChange={event => setDraft({ ...draft, [flag.key]: event.target.checked })}
                  className="h-5 w-5 accent-[#2AABEE]" />
              </label>
            </li>
          ))}
        </ul>
        <label htmlFor="restriction-reason" className="mt-4 block text-[13px] font-medium text-[#0F172A]">Причина</label>
        <textarea id="restriction-reason" value={reason} onChange={event => setReason(event.target.value)} maxLength={512} rows={2}
          placeholder="Например: просил не звонить"
          className="mt-1 w-full rounded-lg border border-[#E4ECFC] px-3 py-2 text-[15px] outline-none focus:border-[#2AABEE]" />
        {error && <div className="mt-3 text-[13px] text-[#DC2626]" role="alert">{error}</div>}
        <button type="submit" disabled={busy || unchanged} className="mt-4 h-11 rounded-lg bg-[#2AABEE] px-4 text-[15px] font-semibold text-white hover:bg-[#1E96D4] disabled:opacity-60">
          {busy ? 'Сохраняю…' : 'Сохранить'}
        </button>
      </form>
    </Modal>
  )
}

export function CardActions({ contactId, displayName, conversations }: { contactId: string; displayName: string; conversations: CardConversationV1[] }) {
  const router = useRouter()
  const [open, setOpen] = useState<'merge' | 'phone' | 'driver' | 'messages' | 'restrictions' | null>(null)
  const [restriction, setRestriction] = useState<RestrictionState | { refused: number } | null>(null)
  useEffect(() => {
    let live = true
    readRestriction(contactId).then(state => { if (live) setRestriction(state) }, () => { if (live) setRestriction({ refused: 503 }) })
    return () => { live = false }
  }, [contactId])
  const sorted = useMemo(() => [...conversations].sort((a, b) => a.channelLabel.localeCompare(b.channelLabel)), [conversations])
  const button = 'flex h-11 flex-1 min-w-[180px] items-center justify-center gap-2 rounded-lg border border-[#E4ECFC] px-4 text-[15px] font-medium text-[#2AABEE] hover:bg-[#F1F5FD]'
  return (
    <div className="px-4 py-4">
      <div className="flex flex-wrap gap-3">
        <button type="button" className={button} onClick={() => setOpen('merge')}>Объединить контакт</button>
        <button type="button" className={button} onClick={() => setOpen('phone')}>Добавить номер</button>
        <button type="button" className={button} onClick={() => setOpen('driver')}>Привязать профиль Яндекс</button>
        <button type="button" className={button} disabled={sorted.length === 0} onClick={() => setOpen(open === 'messages' ? null : 'messages')}
          title={sorted.length === 0 ? 'Переписок с этим человеком нет' : undefined}>
          Открыть в сообщениях
        </button>
        <button type="button" className={button} disabled={restriction === null || 'refused' in restriction} onClick={() => setOpen('restrictions')}>
          Ограничения связи
        </button>
      </div>
      <div className="mt-3 text-[13px] text-[#64748B]" data-testid="restriction-summary">
        {'Ограничения связи: '}
        {restriction === null ? 'загружаю…'
          : 'refused' in restriction ? (restriction.refused === 401 ? 'нет прав на просмотр' : 'сейчас недоступны')
          : <span className={restriction.restriction.denyAll || restriction.restriction.denyMessage || restriction.restriction.denyVoice ? 'font-medium text-[#DC2626]' : undefined}>{restrictionSummaryV1(restriction.restriction)}</span>}
      </div>
      {open === 'messages' && sorted.length > 0 && (
        <ul className="mt-3 rounded-xl border border-[#E4ECFC]">
          {sorted.map(conversation => (
            <li key={conversation.conversationId}>
              <Link href={messagesHref(conversation.conversationId, conversation.channelTab)} className="flex min-h-[44px] items-center justify-between px-4 text-[15px] text-[#0F172A] hover:bg-[#F1F5FD]">
                <span>{conversation.channelLabel}</span>
                <span className="text-[12px] text-[#64748B]">переписок: {conversation.count}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {open === 'merge' && <MergeDialog contactId={contactId} displayName={displayName} onClose={() => setOpen(null)} />}
      {open === 'phone' && <AddPhoneDialog contactId={contactId} onClose={() => setOpen(null)} />}
      {open === 'restrictions' && restriction !== null && !('refused' in restriction) && (
        <RestrictionsDialog contactId={contactId} current={restriction} onClose={() => setOpen(null)}
          onSaved={state => { setRestriction(state); setOpen(null); router.refresh() }} />
      )}
      <DriverPersonSearchModal contactId={contactId} isOpen={open === 'driver'} onClose={() => setOpen(null)} onConfirmed={() => { setOpen(null); router.refresh() }} />
    </div>
  )
}
