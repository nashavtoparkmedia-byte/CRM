'use client'

import { useState, type FormEvent } from 'react'
import Link from 'next/link'

/**
 * «Люди» → поиск по ВУ (Owner D2, OD-03). The full licence goes to the server in
 * a POST body; the answer shows each profile's ВУ only as the reader's view
 * allows («•••• 5678» for everyone but Администратор) and never repeats the
 * typed value. A profile opens the person card through the row's own stored
 * Contact link; a profile without one is shown as such, never matched here.
 */
type LicenceSearchProfile = {
  driverId: string
  linkedContactId: string | null
  fullName: string
  parkName: string | null
  licence: string | null
  dismissedAt: string | null
}

type SearchState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'answered'; profiles: LicenceSearchProfile[]; truncated: boolean }
  | { kind: 'error'; text: string }

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function profilesOf(data: unknown): LicenceSearchProfile[] {
  if (typeof data !== 'object' || data === null || !Array.isArray((data as { profiles?: unknown }).profiles)) return []
  return ((data as { profiles: unknown[] }).profiles).flatMap((row) => {
    if (typeof row !== 'object' || row === null) return []
    const item = row as Record<string, unknown>
    const driverId = text(item.driverId)
    if (driverId === null) return []
    return [{
      driverId,
      linkedContactId: text(item.linkedContactId),
      fullName: text(item.fullName) ?? 'Без имени',
      parkName: text(item.parkName),
      licence: text(item.licence),
      dismissedAt: text(item.dismissedAt),
    }]
  })
}

function formatDate(value: string | null): string | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

function ProfileRow({ profile }: { profile: LicenceSearchProfile }) {
  const meta = [
    profile.parkName ?? 'Парк не указан',
    profile.licence ? `ВУ ${profile.licence}` : null,
    profile.dismissedAt ? `уволен ${formatDate(profile.dismissedAt) ?? ''}` : null,
    profile.linkedContactId === null ? 'профиль без карточки человека' : null,
  ].filter(Boolean).join(' · ')
  const body = (
    <div className="min-w-0 flex-1">
      <div className="truncate text-[15px] font-medium text-[#0F172A]">{profile.fullName}</div>
      <div className="mt-0.5 truncate text-[13px] text-[#64748B]">{meta}</div>
    </div>
  )
  return profile.linkedContactId === null ? (
    <li className="flex min-h-[56px] items-center px-3">{body}</li>
  ) : (
    <li>
      <Link href={`/contacts/${encodeURIComponent(profile.linkedContactId)}`} className="flex min-h-[56px] items-center rounded-lg px-3 hover:bg-[#F1F5FD]">
        {body}
      </Link>
    </li>
  )
}

export default function LicenceSearchClient() {
  const [licence, setLicence] = useState('')
  const [state, setState] = useState<SearchState>({ kind: 'idle' })

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (licence.trim() === '' || state.kind === 'loading') return
    setState({ kind: 'loading' })
    try {
      const response = await fetch('/contacts/licence-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ licence }),
        cache: 'no-store',
      })
      if (response.status === 401) {
        setState({ kind: 'error', text: 'Чтобы искать по ВУ, войдите в CRM со своим паролем.' })
        return
      }
      if (!response.ok) {
        setState({ kind: 'error', text: 'Поиск по ВУ сейчас недоступен. Попробуйте ещё раз.' })
        return
      }
      const data: unknown = await response.json()
      setState({ kind: 'answered', profiles: profilesOf(data), truncated: (data as { truncated?: unknown })?.truncated === true })
    } catch {
      setState({ kind: 'error', text: 'Поиск по ВУ сейчас недоступен. Попробуйте ещё раз.' })
    }
  }

  return (
    <form onSubmit={search} className="mt-8 max-w-[560px]">
      <label htmlFor="contacts-licence-search" className="block text-[13px] font-medium text-[#0F172A]">Поиск по ВУ</label>
      <div className="mt-1 flex gap-2">
        <input
          id="contacts-licence-search"
          value={licence}
          onChange={(event) => setLicence(event.target.value)}
          placeholder="Полный номер ВУ"
          autoComplete="off"
          spellCheck={false}
          maxLength={64}
          className="h-11 min-w-0 flex-1 rounded-lg border border-[#E4ECFC] px-3 text-[15px] text-[#0F172A] outline-none placeholder:text-[#64748B] focus:border-[#2AABEE]"
        />
        <button
          type="submit"
          disabled={state.kind === 'loading'}
          className="h-11 rounded-lg bg-[#2AABEE] px-4 text-[15px] font-semibold text-white hover:bg-[#1E96D4] disabled:opacity-60"
        >
          Найти
        </button>
      </div>
      <p className="mt-2 text-[13px] text-[#64748B]">Ищется только полный номер ВУ, без частичных совпадений.</p>
      {state.kind === 'loading' && <div className="mt-3 h-14 animate-pulse rounded-lg bg-[#F1F5FD]" />}
      {state.kind === 'error' && <p className="mt-3 text-[15px] text-[#0F172A]">{state.text}</p>}
      {state.kind === 'answered' && state.profiles.length === 0 && (
        <p className="mt-3 text-[15px] text-[#0F172A]">Профилей с таким ВУ нет.</p>
      )}
      {state.kind === 'answered' && state.profiles.length > 0 && (
        <ul className="mt-3 rounded-xl border border-[#E4ECFC] py-1">
          {state.profiles.map((profile) => <ProfileRow key={profile.driverId} profile={profile} />)}
        </ul>
      )}
      {state.kind === 'answered' && state.truncated && (
        <p className="mt-2 text-[13px] text-[#64748B]">Показаны первые профили; совпало больше.</p>
      )}
    </form>
  )
}
