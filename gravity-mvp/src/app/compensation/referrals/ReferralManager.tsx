'use client'

import { useState, useTransition } from 'react'

import {
    grantCashAccess,
    loadReferralPerson,
    recordReferralInvitation,
    revokeCashAccess,
    searchReferralPeople,
    withdrawReferralInvitation,
} from './actions'
import {
    ACCESS_EVENT_LABELS,
    ACCESS_STATE_LABELS,
    BASIS_LABELS,
    CASH_IDENTITY_LABELS,
    DONE_LABELS,
    INVITATION_STATE_LABELS,
    MATCH_LABELS,
    UNSELECTABLE_LABELS,
    formatDateTime,
    refusalText,
    type ReferralCandidateView,
    type ReferralInvitationView,
    type ReferralPersonView,
    type ReferralProfileView,
    type ReferralWriteResponse,
} from './view'

/**
 * The manager's two referral tools on one screen.
 *
 *   «Закрепить приглашение»  pick who invited and whom, then record it.
 *                            Recording changes nobody's Cash access.
 *   «Водитель»               open a person: their invitations, and their
 *                            Cash access with a grant or a revoke.
 *
 * Nothing is chosen for the manager: a search lists people, and only the row
 * the manager presses is taken. A form keeps one request id until it
 * succeeds, so pressing again after a failure does not write twice.
 */

export type PickedPerson = { personContactId: string; displayName: string }

function newRequestId(): string {
    return globalThis.crypto.randomUUID()
}

function messageOf(response: ReferralWriteResponse): { ok: boolean; text: string } {
    if (response.status === 'done') return { ok: true, text: DONE_LABELS[response.code] ?? 'Готово.' }
    const base = refusalText(response.reason)
    return { ok: false, text: response.detail ? `${base} Пригласивший: ${response.detail}.` : base }
}

function profileLine(profile: ReferralProfileView): string {
    return [
        profile.parkName ?? 'парк не указан',
        profile.employment,
        profile.dismissed ? 'уволен' : 'работает',
        profile.phone,
        profile.licenseNumber ? `ВУ ${profile.licenseNumber}` : null,
    ].filter((part): part is string => part !== null && part !== '').join(' · ')
}

const inputClass = 'h-11 w-full rounded-lg border border-border px-3 text-[15px] text-foreground placeholder:text-muted focus:border-primary focus:outline-none'
const primaryButton = 'h-11 rounded-lg bg-primary px-4 text-[15px] font-semibold text-white disabled:opacity-50'
const secondaryButton = 'h-11 rounded-lg border border-border px-4 text-[15px] text-foreground disabled:opacity-50'

export function PersonPicker({ label, picked, onPick }: {
    label: string
    picked: PickedPerson | null
    onPick: (person: PickedPerson | null) => void
}) {
    const [query, setQuery] = useState('')
    const [results, setResults] = useState<ReferralCandidateView[] | null>(null)
    const [truncated, setTruncated] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [pending, start] = useTransition()

    if (picked !== null) {
        return (
            <div className="mb-4">
                <p className="mb-1 text-[13px] font-medium text-foreground">{label}</p>
                <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2" data-testid="picked">
                    <span className="text-[15px] font-medium text-foreground">{picked.displayName}</span>
                    <button type="button" onClick={() => onPick(null)} className="text-[13px] text-primary">Изменить</button>
                </div>
            </div>
        )
    }

    const search = () => start(async () => {
        setError(null)
        const response = await searchReferralPeople(query)
        if (response.status !== 'ok') {
            setResults(null)
            setError(refusalText(response.reason))
            return
        }
        setResults(response.candidates)
        setTruncated(response.truncated)
    })

    return (
        <div className="mb-4">
            <label className="mb-1 block text-[13px] font-medium text-foreground">
                {label}
                <div className="mt-1 flex gap-2">
                    <input
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); search() } }}
                        placeholder="ФИО, телефон или ВУ"
                        aria-label={label}
                        className={inputClass}
                    />
                    <button type="button" onClick={search} disabled={pending} className={secondaryButton}>Найти</button>
                </div>
            </label>
            {error && <p className="mt-2 text-[13px] text-destructive">{error}</p>}
            {results !== null && results.length === 0 && (
                <p className="mt-2 text-[13px] text-muted" data-testid="no-results">Никого не нашли. Проверьте написание или поищите по телефону или ВУ.</p>
            )}
            {results !== null && results.length > 0 && (
                <ul className="mt-2 divide-y divide-border rounded-lg border border-border" data-testid="results">
                    {results.map((candidate, index) => (
                        <li key={candidate.personContactId ?? `loose-${index}`}>
                            <button
                                type="button"
                                disabled={!candidate.selectable}
                                onClick={() => candidate.personContactId && onPick({ personContactId: candidate.personContactId, displayName: candidate.displayName })}
                                className="block w-full px-3 py-2 text-left hover:bg-surface disabled:cursor-not-allowed disabled:opacity-60"
                            >
                                <span className="flex items-baseline justify-between gap-2">
                                    <span className="text-[15px] font-medium text-foreground">{candidate.displayName}</span>
                                    <span className="text-[12px] text-muted">
                                        совпало: {candidate.matchedBy.map((match) => MATCH_LABELS[match] ?? match).join(', ')}
                                    </span>
                                </span>
                                {candidate.profiles.map((profile) => (
                                    <span key={profile.driverId} className="block text-[13px] text-muted">{profileLine(profile)}</span>
                                ))}
                                {candidate.profiles.length > 1 && (
                                    <span className="block text-[12px] text-muted">Профилей в парках: {candidate.profiles.length}</span>
                                )}
                                {candidate.merged && <span className="block text-[12px] text-muted">Контакты объединялись</span>}
                                {!candidate.selectable && candidate.unselectableReason && (
                                    <span className="block text-[12px] text-destructive">{UNSELECTABLE_LABELS[candidate.unselectableReason] ?? 'Выбрать нельзя'}</span>
                                )}
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            {truncated && <p className="mt-1 text-[12px] text-muted">Показаны не все совпадения — уточните запрос.</p>}
        </div>
    )
}

export function RecordInvitation({ writesAvailable, onRecorded }: {
    writesAvailable: boolean
    onRecorded: (inviter: PickedPerson) => void
}) {
    const [inviter, setInviter] = useState<PickedPerson | null>(null)
    const [invitee, setInvitee] = useState<PickedPerson | null>(null)
    const [comment, setComment] = useState('')
    const [requestId, setRequestId] = useState(newRequestId)
    const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
    const [pending, start] = useTransition()

    const pick = (setter: (person: PickedPerson | null) => void) => (person: PickedPerson | null) => {
        setter(person)
        setMessage(null)
        setRequestId(newRequestId())
    }

    const submit = () => start(async () => {
        if (inviter === null || invitee === null) return
        const response = await recordReferralInvitation({
            inviterContactId: inviter.personContactId,
            inviteeContactId: invitee.personContactId,
            comment,
            requestId,
        })
        setMessage(messageOf(response))
        if (response.status === 'done') {
            const recordedBy = inviter
            setInvitee(null)
            setComment('')
            setRequestId(newRequestId())
            onRecorded(recordedBy)
        }
    })

    return (
        <section className="mb-8 rounded-md border border-border p-4" data-testid="record-invitation">
            <h2 className="mb-3 text-[17px] font-semibold text-foreground">Закрепить приглашение</h2>
            <PersonPicker label="Кто пригласил" picked={inviter} onPick={pick(setInviter)} />
            <PersonPicker label="Кого пригласил" picked={invitee} onPick={pick(setInvitee)} />
            <label className="mb-3 block text-[13px] font-medium text-foreground">
                Комментарий (необязательно)
                <input value={comment} onChange={(event) => setComment(event.target.value)} aria-label="Комментарий к приглашению" className={`mt-1 ${inputClass}`} />
            </label>
            <button
                type="button"
                disabled={pending || !writesAvailable || inviter === null || invitee === null}
                onClick={submit}
                className={primaryButton}
            >
                Закрепить приглашение
            </button>
            <p className="mt-2 text-[12px] text-muted">Закрепление не меняет доступ к компенсации наличных.</p>
            {message && <p className={`mt-2 text-[13px] ${message.ok ? 'text-accent' : 'text-destructive'}`} role="status">{message.text}</p>}
        </section>
    )
}

function InvitationRow({ entry, writesAvailable, onChanged, direction }: {
    entry: ReferralInvitationView
    writesAvailable: boolean
    onChanged: () => void
    direction: 'invited' | 'invitedBy'
}) {
    const [confirming, setConfirming] = useState(false)
    const [comment, setComment] = useState('')
    const [requestId, setRequestId] = useState(newRequestId)
    const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
    const [pending, start] = useTransition()

    const withdraw = () => start(async () => {
        const response = await withdrawReferralInvitation({ attributionId: entry.attributionId, expectedVersion: entry.version, comment, requestId })
        setMessage(messageOf(response))
        if (response.status === 'done') {
            setConfirming(false)
            setRequestId(newRequestId())
            onChanged()
        }
    })

    const who = entry.otherName ?? (entry.otherContactId === null ? 'ещё не определён' : 'водитель без имени')
    return (
        <li className="py-2" data-testid="invitation">
            <div className="flex items-baseline justify-between gap-2">
                <span className="text-[15px] text-foreground">{direction === 'invited' ? who : `Пригласил: ${who}`}</span>
                <span className="text-[12px] text-muted">{formatDateTime(entry.at)}</span>
            </div>
            <p className="text-[13px] text-muted">
                {INVITATION_STATE_LABELS[entry.state] ?? entry.state}
                {entry.recordedBy ? ` · ${entry.recordedBy}` : ''}
                {entry.withdrawnAt ? ` · снято ${formatDateTime(entry.withdrawnAt)}${entry.withdrawnBy ? `, ${entry.withdrawnBy}` : ''}` : ''}
            </p>
            {entry.reason && <p className="text-[12px] text-muted">{entry.reason}</p>}
            {entry.withdrawable && direction === 'invited' && !confirming && (
                <button type="button" disabled={!writesAvailable} onClick={() => setConfirming(true)} className="mt-1 text-[13px] text-primary disabled:opacity-50">
                    Снять закрепление
                </button>
            )}
            {confirming && (
                <div className="mt-2 flex gap-2">
                    <input value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Почему (необязательно)" aria-label="Причина снятия" className={inputClass} />
                    <button type="button" disabled={pending} onClick={withdraw} className="h-11 rounded-lg bg-destructive px-4 text-[15px] font-semibold text-white disabled:opacity-50">Снять</button>
                    <button type="button" onClick={() => setConfirming(false)} className={secondaryButton}>Отмена</button>
                </div>
            )}
            {message && <p className={`mt-1 text-[13px] ${message.ok ? 'text-accent' : 'text-destructive'}`} role="status">{message.text}</p>}
        </li>
    )
}

function GrantForm({ person, onDone, onCancel }: {
    person: ReferralPersonView
    onDone: () => void
    onCancel: () => void
}) {
    const counted = person.invited.filter((entry) => entry.state === 'recorded' || entry.state === 'qualified')
    const [basis, setBasis] = useState<'referral_program' | 'manager_decision'>('referral_program')
    const [invitation, setInvitation] = useState<string>(counted[0]?.attributionId ?? '')
    const [comment, setComment] = useState('')
    const [requestId] = useState(newRequestId)
    const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
    const [pending, start] = useTransition()

    const commentShort = basis === 'manager_decision' && comment.trim().length < 10
    const submit = () => start(async () => {
        const response = await grantCashAccess({
            contactId: person.personContactId,
            basis,
            referralAttributionId: basis === 'referral_program' && invitation !== '' ? invitation : null,
            comment,
            requestId,
        })
        setMessage(messageOf(response))
        if (response.status === 'done') onDone()
    })

    return (
        <div className="mt-3 rounded-md border border-border p-4" data-testid="grant-form">
            <p className="mb-2 text-[15px] font-medium text-foreground">Основание</p>
            <label className="mb-1 flex items-center gap-2 text-[15px] text-foreground">
                <input type="radio" name="basis" checked={basis === 'referral_program'} onChange={() => setBasis('referral_program')} />
                Реферальная программа
            </label>
            {basis === 'referral_program' && counted.length > 0 && (
                <select value={invitation} onChange={(event) => setInvitation(event.target.value)} aria-label="За приглашение" className={`mb-2 ml-6 ${inputClass}`}>
                    <option value="">Без указания приглашения</option>
                    {counted.map((entry) => (
                        <option key={entry.attributionId} value={entry.attributionId}>За приглашение: {entry.otherName ?? 'водитель'}</option>
                    ))}
                </select>
            )}
            <label className="mb-2 flex items-center gap-2 text-[15px] text-foreground">
                <input type="radio" name="basis" checked={basis === 'manager_decision'} onChange={() => setBasis('manager_decision')} />
                Другое решение менеджера
            </label>
            <input
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                placeholder={basis === 'manager_decision' ? 'Опишите решение (обязательно)' : 'Комментарий (необязательно)'}
                aria-label="Комментарий к доступу"
                className={inputClass}
            />
            <p className="mt-2 text-[12px] text-muted">Доступ бессрочный. Лимиты, бюджет и проверки выплат не меняются.</p>
            <div className="mt-3 flex gap-2">
                <button type="button" disabled={pending || commentShort} onClick={submit} className={primaryButton}>Предоставить</button>
                <button type="button" onClick={onCancel} className={secondaryButton}>Отмена</button>
            </div>
            {message && <p className={`mt-2 text-[13px] ${message.ok ? 'text-accent' : 'text-destructive'}`} role="status">{message.text}</p>}
        </div>
    )
}

function RevokeForm({ person, onDone, onCancel }: {
    person: ReferralPersonView
    onDone: () => void
    onCancel: () => void
}) {
    const [comment, setComment] = useState('')
    const [requestId] = useState(newRequestId)
    const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
    const [pending, start] = useTransition()
    const submit = () => start(async () => {
        const response = await revokeCashAccess({ contactId: person.personContactId, comment, requestId })
        setMessage(messageOf(response))
        if (response.status === 'done') onDone()
    })
    return (
        <div className="mt-3 rounded-md border border-border p-4" data-testid="revoke-form">
            <p className="text-[15px] text-foreground">Отозвать бессрочный доступ у водителя {person.displayName}? Закреплённые приглашения останутся.</p>
            <input value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Почему (необязательно)" aria-label="Причина отзыва" className={`mt-2 ${inputClass}`} />
            <div className="mt-3 flex gap-2">
                <button type="button" disabled={pending} onClick={submit} className="h-11 rounded-lg bg-destructive px-4 text-[15px] font-semibold text-white disabled:opacity-50">Отозвать доступ</button>
                <button type="button" onClick={onCancel} className={secondaryButton}>Отмена</button>
            </div>
            {message && <p className={`mt-2 text-[13px] ${message.ok ? 'text-accent' : 'text-destructive'}`} role="status">{message.text}</p>}
        </div>
    )
}

export function PersonCard({ person, writesAvailable, onChanged }: {
    person: ReferralPersonView
    writesAvailable: boolean
    onChanged: () => void
}) {
    const [form, setForm] = useState<'grant' | 'revoke' | null>(null)
    const grant = person.access.manualGrant
    const grantInvitation = grant?.referralAttributionId
        ? person.invited.find((entry) => entry.attributionId === grant.referralAttributionId) ?? null
        : null
    const done = () => { setForm(null); onChanged() }

    return (
        <div className="rounded-md border border-border p-4" data-testid="person-card">
            <h3 className="text-[17px] font-semibold text-foreground">{person.displayName}</h3>
            <ul className="mt-1">
                {person.profiles.map((profile) => (
                    <li key={profile.driverId} className="text-[13px] text-muted">{profileLine(profile)}</li>
                ))}
            </ul>
            <p className="mt-2 text-[13px] text-muted">{CASH_IDENTITY_LABELS[person.cashIdentity]}</p>

            <section className="mt-4" data-testid="access">
                <h4 className="text-[15px] font-semibold text-foreground">Доступ к компенсации наличных</h4>
                <p className="text-[15px] text-foreground" data-testid="access-state">{ACCESS_STATE_LABELS[person.access.state]}</p>
                {grant && (
                    <p className="text-[13px] text-muted" data-testid="access-basis">
                        {BASIS_LABELS[grant.basis ?? ''] ?? 'Основание не указано'}
                        {grantInvitation ? ` — за приглашение: ${grantInvitation.otherName ?? 'водитель'}` : ''}
                        {` · с ${formatDateTime(grant.since)}`}
                        {grant.operatorLabel ? ` · ${grant.operatorLabel}` : ''}
                    </p>
                )}
                {person.access.referralEntitlement && (
                    <p className="text-[13px] text-muted">По ссылке в Telegram с {formatDateTime(person.access.referralEntitlement.since)}</p>
                )}
                <div className="mt-2 flex gap-2">
                    {person.access.state === 'granted' ? (
                        <button type="button" disabled={!writesAvailable || form !== null} onClick={() => setForm('revoke')} className={secondaryButton}>Отозвать доступ</button>
                    ) : (
                        <button
                            type="button"
                            disabled={!writesAvailable || form !== null || person.merged}
                            onClick={() => setForm('grant')}
                            className={primaryButton}
                        >
                            Предоставить бессрочный доступ
                        </button>
                    )}
                </div>
                {form === 'grant' && <GrantForm person={person} onDone={done} onCancel={() => setForm(null)} />}
                {form === 'revoke' && <RevokeForm person={person} onDone={done} onCancel={() => setForm(null)} />}
                {person.access.history.length > 0 && (
                    <ul className="mt-3 divide-y divide-border" data-testid="access-history">
                        {person.access.history.map((entry, index) => (
                            <li key={`${entry.occurredAt}-${index}`} className="py-1">
                                <span className="text-[13px] text-foreground">{ACCESS_EVENT_LABELS[entry.kind] ?? entry.kind}</span>
                                <span className="text-[12px] text-muted">
                                    {` · ${formatDateTime(entry.occurredAt)}`}
                                    {entry.system ? ' · автоматически' : entry.operatorLabel ? ` · ${entry.operatorLabel}` : ''}
                                    {entry.stale ? ' · до объединения контактов' : ''}
                                </span>
                                {entry.reason && <span className="block text-[12px] text-muted">{entry.reason}</span>}
                            </li>
                        ))}
                    </ul>
                )}
            </section>

            <section className="mt-4" data-testid="invited">
                <h4 className="text-[15px] font-semibold text-foreground">Пригласил</h4>
                {person.invited.length === 0 ? (
                    <p className="text-[13px] text-muted">Приглашений нет.</p>
                ) : (
                    <ul className="divide-y divide-border">
                        {person.invited.map((entry) => (
                            <InvitationRow key={entry.attributionId} entry={entry} writesAvailable={writesAvailable} onChanged={onChanged} direction="invited" />
                        ))}
                    </ul>
                )}
            </section>

            {person.invitedBy.length > 0 && (
                <section className="mt-4" data-testid="invited-by">
                    <h4 className="text-[15px] font-semibold text-foreground">Кто пригласил</h4>
                    <ul className="divide-y divide-border">
                        {person.invitedBy.map((entry) => (
                            <InvitationRow key={entry.attributionId} entry={entry} writesAvailable={writesAvailable} onChanged={onChanged} direction="invitedBy" />
                        ))}
                    </ul>
                </section>
            )}
        </div>
    )
}

export default function ReferralManager({ writesAvailable, writesRefusal = 'staff_session_unavailable' }: {
    writesAvailable: boolean
    /** Why the server refused to resolve a writer, as it answered; it decides nothing here. */
    writesRefusal?: string
}) {
    const [picked, setPicked] = useState<PickedPerson | null>(null)
    const [person, setPerson] = useState<ReferralPersonView | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [, start] = useTransition()

    const open = (next: PickedPerson | null) => {
        setPicked(next)
        setPerson(null)
        setError(null)
        if (next === null) return
        start(async () => {
            const response = await loadReferralPerson(next.personContactId)
            if (response.status === 'ok') setPerson(response.person)
            else setError(refusalText(response.reason))
        })
    }
    const reload = () => { if (picked !== null) open(picked) }

    return (
        <>
            {!writesAvailable && (
                <p className="mb-4 rounded-md border border-border bg-surface p-3 text-[13px] text-muted" data-testid="writes-unavailable">
                    {refusalText(writesRefusal)}
                    {writesRefusal !== 'staff_role_not_allowed' && (
                        <>{' '}<a href="/login" className="font-medium text-primary">Войти</a></>
                    )}
                </p>
            )}
            <RecordInvitation writesAvailable={writesAvailable} onRecorded={open} />
            <section data-testid="person-section">
                <h2 className="mb-3 text-[17px] font-semibold text-foreground">Водитель</h2>
                <PersonPicker label="Найти водителя" picked={picked} onPick={open} />
                {error && <p className="text-[13px] text-destructive">{error}</p>}
                {picked !== null && person === null && error === null && (
                    <div className="h-24 animate-pulse rounded-md bg-surface" aria-label="Загрузка" />
                )}
                {person && <PersonCard person={person} writesAvailable={writesAvailable} onChanged={reload} />}
            </section>
        </>
    )
}
