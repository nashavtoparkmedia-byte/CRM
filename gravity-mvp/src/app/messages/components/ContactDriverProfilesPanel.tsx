"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { AlertTriangle, Check, ChevronDown, HelpCircle, Loader2, RefreshCw, ShieldCheck, UserCheck, X } from "lucide-react"
import type { ContactDriverProfilePayload, ContactProfilePayload } from "@/lib/contact-profile-contract"
import {
    formatAttachButton,
    formatAttachedProfilesHeader,
    formatFoundProfilesSummary,
    formatSelectedProfilesSummary,
    getDriverProfileStatusLabel,
    getEmploymentTypeLabel,
    getUniqueSelectedParkCount,
    groupDriverProfilesByPark,
    isSuggestedProfileSelectable,
} from "@/lib/contact-profile-ui"
import DriverCatalogSearchActions from "./DriverCatalogSearchActions"
import DispatcherProfileActions from "./DispatcherProfileActions"

type ProfileSyncViewState = 'idle' | 'syncing' | 'success' | 'error'

interface ContactDriverProfilesPanelProps {
    contact: ContactProfilePayload
    profileSyncState: ProfileSyncViewState
    profileSyncError: string | null
    profileSyncedAt: string | null
    onRetry: (parkCode?: string) => Promise<void> | void
    onRefetch: () => Promise<unknown> | void
    onOpenHelp: () => void
}

function formatPhone(phone: string | null): string {
    if (!phone) return 'Телефон не указан'
    const digits = phone.replace(/\D/g, '')
    if (digits.length === 11 && digits.startsWith('7')) {
        return `+7 ${digits.slice(1, 4)} ${digits.slice(4, 7)}-${digits.slice(7, 9)}-${digits.slice(9)}`
    }
    return phone
}

function formatDateTime(value: string | null): string {
    if (!value) return 'Нет данных'
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return 'Нет данных'
    return date.toLocaleString('ru-RU', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    })
}

function statusLabel(profile: ContactDriverProfilePayload): string {
    return profile.statusLabel || getDriverProfileStatusLabel(profile.normalizedStatus || profile.status)
}

function employmentLabel(profile: ContactDriverProfilePayload): string {
    return profile.employmentTypeLabel || getEmploymentTypeLabel(profile.employmentTypeCode || profile.employmentType)
}

function reviewCheckboxLabel(profile: ContactDriverProfilePayload): string {
    return `Выбрать профиль ${profile.fullName} — ${profile.parkName}`
}

export default function ContactDriverProfilesPanel({
    contact,
    profileSyncState,
    profileSyncError,
    profileSyncedAt,
    onRetry,
    onRefetch,
    onOpenHelp,
}: ContactDriverProfilesPanelProps) {
    const [showReview, setShowReview] = useState(false)
    const [showAttachConfirmation, setShowAttachConfirmation] = useState(false)
    const [selectedProfileIds, setSelectedProfileIds] = useState<string[]>([])
    const [attaching, setAttaching] = useState(false)
    const [attachError, setAttachError] = useState<string | null>(null)
    const [mainError, setMainError] = useState<string | null>(null)
    const [savingMainId, setSavingMainId] = useState<string | null>(null)
    const [pendingMainProfile, setPendingMainProfile] = useState<ContactDriverProfilePayload | null>(null)
    const [profilesOpen, setProfilesOpen] = useState(false)
    const [dismissedOpen, setDismissedOpen] = useState<Record<string, boolean>>({})
    const [reviewDismissedOpen, setReviewDismissedOpen] = useState<Record<string, boolean>>({})
    const mainRequestInFlight = useRef(false)

    useEffect(() => {
        setShowReview(false)
        setShowAttachConfirmation(false)
        setSelectedProfileIds([])
        setAttachError(null)
        setMainError(null)
        setPendingMainProfile(null)
        mainRequestInFlight.current = false
        try {
            setProfilesOpen(window.localStorage.getItem(`crm:contact-profiles:${contact.id}`) === 'open')
        } catch {
            setProfilesOpen(false)
        }
        setDismissedOpen({})
        setReviewDismissedOpen({})
    }, [contact.id])

    const suggestions = useMemo(
        () => contact.suggestedProfiles || contact.suggestedDriverProfiles || [],
        [contact.suggestedProfiles, contact.suggestedDriverProfiles],
    )
    const attachedProfiles = useMemo(
        () => contact.attachedProfiles || contact.driverProfiles || [],
        [contact.attachedProfiles, contact.driverProfiles],
    )
    const mainProfile = contact.mainDriverProfile || contact.mainDriver || null
    const selectableSuggestions = useMemo(
        () => suggestions.filter(isSuggestedProfileSelectable),
        [suggestions],
    )
    const suggestionGroups = useMemo(() => groupDriverProfilesByPark(suggestions), [suggestions])
    const profilesByPark = useMemo(() => groupDriverProfilesByPark(attachedProfiles), [attachedProfiles])
    const selectedProfiles = useMemo(
        () => selectableSuggestions.filter(profile => selectedProfileIds.includes(profile.id)),
        [selectableSuggestions, selectedProfileIds],
    )
    const selectedParkCount = getUniqueSelectedParkCount(selectedProfiles)
    const allSelectableSelected = selectableSuggestions.length > 0
        && selectableSuggestions.every(profile => selectedProfileIds.includes(profile.id))
    const activeProfileCount = profilesByPark.reduce((sum, group) => sum + group.active.length, 0)
    const dismissedProfileCount = profilesByPark.reduce((sum, group) => sum + group.dismissed.length, 0)

    useEffect(() => {
        if (!pendingMainProfile) return
        const handleEscape = (event: KeyboardEvent) => {
            if (event.key !== 'Escape' || mainRequestInFlight.current) return
            setPendingMainProfile(null)
            setMainError(null)
        }
        document.addEventListener('keydown', handleEscape)
        return () => document.removeEventListener('keydown', handleEscape)
    }, [pendingMainProfile])

    const toggleProfile = (profile: ContactDriverProfilePayload) => {
        if (!isSuggestedProfileSelectable(profile)) return
        setAttachError(null)
        setSelectedProfileIds(current => current.includes(profile.id)
            ? current.filter(id => id !== profile.id)
            : [...current, profile.id])
    }

    const toggleAll = () => {
        setAttachError(null)
        setSelectedProfileIds(allSelectableSelected ? [] : selectableSuggestions.map(profile => profile.id))
    }

    const closeReview = () => {
        if (attaching) return
        setShowAttachConfirmation(false)
        setShowReview(false)
        setAttachError(null)
    }

    const requestAttachment = () => {
        if (selectedProfiles.length === 0) return
        setAttachError(null)
        setShowAttachConfirmation(true)
    }

    const attachSelected = async () => {
        if (selectedProfiles.length === 0) return
        setAttaching(true)
        setAttachError(null)
        try {
            const response = await fetch(`/api/contacts/${contact.id}/driver-profiles/attach`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ driverIds: selectedProfiles.map(profile => profile.id), selectedBy: 'operator' }),
            })
            const body = await response.json().catch(() => ({}))
            if (!response.ok || body.ok === false) {
                setAttachError(body.error || `Ошибка ${response.status}`)
                setShowAttachConfirmation(false)
                return
            }
            setShowAttachConfirmation(false)
            setShowReview(false)
            setSelectedProfileIds([])
            await onRefetch()
        } catch (error: unknown) {
            setAttachError(error instanceof Error ? error.message : 'Ошибка сети')
            setShowAttachConfirmation(false)
        } finally {
            setAttaching(false)
        }
    }

    const toggleProfiles = () => {
        setProfilesOpen(current => {
            const next = !current
            try {
                window.localStorage.setItem(`crm:contact-profiles:${contact.id}`, next ? 'open' : 'closed')
            } catch {
                // The UI state still works when storage is unavailable.
            }
            return next
        })
    }

    const requestMainProfileChange = (profile: ContactDriverProfilePayload) => {
        if ((profile.normalizedStatus || profile.status) !== 'working') return
        if (mainRequestInFlight.current || savingMainId !== null) return
        setMainError(null)
        setPendingMainProfile(profile)
    }

    const closeMainProfileConfirmation = () => {
        if (mainRequestInFlight.current) return
        setPendingMainProfile(null)
        setMainError(null)
    }

    const confirmMainProfileChange = async () => {
        const profile = pendingMainProfile
        if (!profile || mainRequestInFlight.current) return
        mainRequestInFlight.current = true
        setSavingMainId(profile.id)
        setMainError(null)
        try {
            const response = await fetch(`/api/contacts/${contact.id}/main-driver`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ driverId: profile.id, selectedBy: 'operator' }),
            })
            const body = await response.json().catch(() => ({}))
            if (!response.ok) {
                setMainError(body.error || `Ошибка ${response.status}`)
                return
            }
            await onRefetch()
            setPendingMainProfile(null)
        } catch (error: unknown) {
            setMainError(error instanceof Error ? error.message : 'Ошибка сети')
        } finally {
            mainRequestInFlight.current = false
            setSavingMainId(null)
        }
    }

    const effectiveSyncTime = profileSyncedAt || contact.syncState?.lastSuccessfulAt || null
    const confirmationGroups = groupDriverProfilesByPark(selectedProfiles)
    const rawContactPhone = contact.primaryPhone?.phone || contact.phones[0]?.phone || null
    const contactPhone = formatPhone(rawContactPhone)
    const staleSyncParks = (contact.syncState?.parks || []).filter(park => park.state === 'stale' || park.state === 'backoff')
    const visibleAnomalies = (contact.anomalies || []).filter(anomaly => anomaly.type !== 'sync_stale')

    const renderReviewProfile = (profile: ContactDriverProfilePayload, historical: boolean) => {
        const disabled = !isSuggestedProfileSelectable(profile)
        const checked = selectedProfileIds.includes(profile.id)
        const linkedContact = profile.linkedContactSummary || profile.conflictContact
        return (
            <label key={profile.id} className={`flex gap-2 rounded border px-3 py-2 ${disabled ? 'border-gray-200 bg-gray-50' : checked ? 'border-[#3390EC] bg-blue-50' : 'border-gray-200 bg-white'}`}>
                <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled}
                    onChange={() => toggleProfile(profile)}
                    aria-label={reviewCheckboxLabel(profile)}
                />
                <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-[12px] font-semibold text-[#111]">{profile.fullName}</span>
                        <span className={`shrink-0 text-[10px] font-semibold ${(profile.normalizedStatus || profile.status) === 'working' ? 'text-emerald-700' : 'text-gray-500'}`}>{statusLabel(profile)}</span>
                    </div>
                    <div className="mt-0.5 text-[11px] text-gray-700">{employmentLabel(profile)}</div>
                    <div className="text-[10px] text-gray-500">{formatPhone(profile.phone)}</div>
                    <div className="text-[9px] text-gray-500">{profile.suggestionBasisLabel || 'Основание предложения не определено'}</div>
                    <DispatcherProfileActions target={profile.dispatcher} compact />
                    {historical && <div className="mt-0.5 text-[9px] font-medium text-gray-500">Исторический профиль</div>}
                    {disabled && (
                        <div className="mt-1 text-[10px] font-medium text-red-600">
                            Профиль принадлежит контакту «{linkedContact?.displayName || profile.conflictContactId}».
                            {linkedContact?.chatId && (
                                <a className="ml-1 underline" href={`/messages?id=${encodeURIComponent(linkedContact.chatId)}&profile=1`}>Открыть контакт</a>
                            )}
                        </div>
                    )}
                </div>
            </label>
        )
    }

    return (
        <>
            <section className="border-b border-[#E8E8E8] px-3 py-3" data-testid="contact-driver-profile-panel">
                <div className="mb-2 flex items-center justify-between gap-2">
                    <h4 className="text-[10px] font-bold uppercase text-gray-500">Профили водителя</h4>
                    <button type="button" onClick={onOpenHelp} className="inline-flex h-6 items-center gap-1 rounded bg-gray-100 px-2 text-[10px] font-semibold text-gray-600 hover:bg-gray-200">
                        <HelpCircle size={11} /> Как работает раздел
                    </button>
                </div>

                <div className="mb-2 flex items-start justify-between gap-2 rounded border border-gray-200 bg-gray-50 px-2 py-2">
                    <div className="min-w-0">
                        <div className="text-[12px] font-semibold text-[#111]">
                            {attachedProfiles.length === 0 ? 'Профиль водителя не привязан' : `Привязано профилей: ${attachedProfiles.length}`}
                        </div>
                        <div className="mt-0.5 text-[10px] text-gray-500">
                            {staleSyncParks.length > 0 && 'Показана последняя сохранённая информация'}
                            {profileSyncState === 'syncing' && 'Обновляем данные…'}
                            {staleSyncParks.length === 0 && profileSyncState === 'success' && `Обновлено: ${formatDateTime(effectiveSyncTime)}`}
                            {profileSyncState === 'error' && 'Не удалось обновить данные'}
                            {staleSyncParks.length === 0 && profileSyncState === 'idle' && `Последнее обновление: ${formatDateTime(effectiveSyncTime)}`}
                        </div>
                        {profileSyncState === 'error' && profileSyncError && <div className="mt-0.5 text-[9px] text-amber-700">Показана последняя сохранённая информация.</div>}
                    </div>
                    {profileSyncState === 'syncing' ? (
                        <Loader2 size={14} className="mt-0.5 shrink-0 animate-spin text-[#3390EC]" />
                    ) : profileSyncState === 'error' ? (
                        <button type="button" onClick={() => void onRetry()} className="inline-flex h-6 shrink-0 items-center gap-1 rounded bg-amber-100 px-2 text-[10px] font-semibold text-amber-800 hover:bg-amber-200">
                            <RefreshCw size={10} /> Повторить
                        </button>
                    ) : (
                        staleSyncParks.length > 0
                            ? <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-600" />
                            : <ShieldCheck size={14} className="mt-0.5 shrink-0 text-emerald-600" />
                    )}
                </div>

                <DriverCatalogSearchActions
                    contactId={contact.id}
                    contactDisplayName={contact.displayName}
                    phone={rawContactPhone}
                    onRefetch={onRefetch}
                />

                {staleSyncParks.map(park => (
                    <div key={park.parkCode} className="mb-2 flex items-start justify-between gap-2 rounded border border-amber-200 bg-amber-50 px-2 py-2 text-[10px] text-amber-900" data-testid="profile-sync-warning">
                        <div className="min-w-0">
                            <div className="font-semibold">Не удалось обновить данные «{park.parkName}».</div>
                            <div>Показана последняя сохранённая информация.</div>
                            <div className="mt-0.5 text-[9px] text-amber-800">Последняя синхронизация: {formatDateTime(park.lastSuccessfulAt)}</div>
                        </div>
                        <button
                            type="button"
                            disabled={!park.canRetry}
                            title={park.canRetry ? 'Повторить обновление' : 'Повторная попытка будет доступна после паузы'}
                            onClick={() => void onRetry(park.parkCode)}
                            className="inline-flex h-6 shrink-0 items-center gap-1 rounded bg-amber-100 px-2 text-[10px] font-semibold text-amber-800 enabled:hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            <RefreshCw size={10} /> Повторить
                        </button>
                    </div>
                ))}

                {visibleAnomalies.length > 0 && (
                    <div className="mb-2 space-y-1" data-testid="profile-anomalies">
                        {visibleAnomalies.map((anomaly, index) => (
                            <div
                                key={anomaly.type + '-' + index}
                                className={'flex gap-1.5 rounded border px-2 py-1.5 text-[10px] ' + (
                                    anomaly.severity === 'error'
                                        ? 'border-red-200 bg-red-50 text-red-700'
                                        : 'border-amber-200 bg-amber-50 text-amber-800'
                                )}
                            >
                                <AlertTriangle size={11} className="mt-px shrink-0" />
                                <span>{anomaly.message}</span>
                            </div>
                        ))}
                    </div>
                )}

                {attachedProfiles.length === 0 && suggestions.length > 0 && (
                    <div className="border-l-2 border-amber-400 bg-amber-50 px-2.5 py-2" data-testid="suggested-driver-profiles">
                        <div className="text-[12px] font-bold text-[#111]">Возможные профили водителя: {suggestions.length}</div>
                        <div className="mt-0.5 text-[10px] leading-snug text-gray-600">Проверьте, принадлежат ли эти профили одному человеку.</div>
                        <button type="button" onClick={() => { setShowReview(true); setAttachError(null) }} className="mt-2 inline-flex h-7 items-center gap-1 rounded bg-[#3390EC] px-2.5 text-[10px] font-semibold text-white hover:bg-[#2B7FD4]">
                            <UserCheck size={11} /> Проверить профили
                        </button>
                    </div>
                )}

                {mainProfile && (
                    <div className="mb-2 border-l-2 border-emerald-500 bg-emerald-50 px-2.5 py-2" data-testid="main-driver-profile">
                        <div className="mb-1 flex items-center justify-between gap-2">
                            <span className="text-[10px] font-bold uppercase text-emerald-700">Главный профиль</span>
                            <span className="rounded bg-white px-1.5 py-0.5 text-[9px] font-bold text-emerald-700">Главный</span>
                        </div>
                        <div className="text-[12px] font-semibold text-[#111]">{mainProfile.fullName}</div>
                        <div className="mt-0.5 text-[10px] text-gray-600">{mainProfile.parkName} · {employmentLabel(mainProfile)}</div>
                        <div className="text-[10px] text-gray-600">{formatPhone(mainProfile.phone)} · {statusLabel(mainProfile)}</div>
                        <div className="mt-1 text-[9px] text-gray-500">Синхронизация: {formatDateTime(mainProfile.lastSuccessfulSyncAt || mainProfile.sourceUpdatedAt)}</div>
                        <DispatcherProfileActions target={mainProfile.dispatcher} />
                    </div>
                )}

                {profilesByPark.length > 0 && (
                    <div data-testid="attached-profiles-section">
                        <button
                            type="button"
                            onClick={toggleProfiles}
                            aria-expanded={profilesOpen}
                            aria-controls={`contact-profiles-${contact.id}`}
                            aria-label={`${profilesOpen ? 'Скрыть' : 'Показать'} профили водителя`}
                            className="flex w-full min-w-0 items-center justify-between gap-2 border-t border-gray-100 py-2 text-left"
                            data-testid="profiles-collapse-toggle"
                        >
                            <span className="min-w-0">
                                <span className="block truncate text-[11px] font-bold text-[#111]">{formatAttachedProfilesHeader(attachedProfiles.length, profilesByPark.length)}</span>
                                <span className="block text-[9px] text-gray-500">Активных: {activeProfileCount} · Уволенных: {dismissedProfileCount}</span>
                            </span>
                            <span className="inline-flex shrink-0 items-center gap-1 text-[10px] font-semibold text-[#3390EC]">
                                {profilesOpen ? 'Скрыть' : 'Показать'}
                                <ChevronDown size={12} className={`transition-transform ${profilesOpen ? 'rotate-180' : ''}`} />
                            </span>
                        </button>
                        {profilesOpen && (
                            <div id={`contact-profiles-${contact.id}`} className="mt-1 space-y-2" data-testid="profiles-by-park">
                            {profilesByPark.map(group => (
                            <div key={group.key} className="border-t border-gray-100 pt-1.5" data-park={group.parkName}>
                                <div className="mb-1 text-[11px] font-bold text-[#111]">{group.parkName}</div>
                                {group.activeCount > 1 && <div className="mb-1 flex gap-1 rounded bg-amber-50 px-2 py-1 text-[9px] text-amber-800"><AlertTriangle size={10} /> Несколько активных профилей</div>}
                                <div className="space-y-1">
                                    {group.active.map(profile => (
                                        <div key={profile.id} className="flex items-start justify-between gap-2 py-1">
                                            <div className="min-w-0">
                                                <div className="truncate text-[11px] font-medium text-[#111]">{profile.fullName}</div>
                                                <div className="truncate text-[10px] text-gray-500">{employmentLabel(profile)} · {formatPhone(profile.phone)}</div>
                                                <div className={`text-[9px] font-semibold ${(profile.normalizedStatus || profile.status) === 'working' ? 'text-emerald-700' : 'text-gray-500'}`}>{statusLabel(profile)}</div>
                                                <DispatcherProfileActions target={profile.dispatcher} compact />
                                            </div>
                                            {profile.id === mainProfile?.id ? (
                                                <span className="shrink-0 rounded bg-emerald-50 px-1 py-0.5 text-[9px] font-semibold text-emerald-700">Главный</span>
                                            ) : (profile.normalizedStatus || profile.status) === 'working' ? (
                                                <button type="button" disabled={savingMainId !== null} onClick={() => requestMainProfileChange(profile)} className="shrink-0 rounded bg-blue-50 px-1.5 py-0.5 text-[9px] font-semibold text-[#3390EC] hover:bg-blue-100 disabled:opacity-50">
                                                    {savingMainId === profile.id ? 'Сохраняем…' : 'Сделать главным'}
                                                </button>
                                            ) : null}
                                        </div>
                                    ))}
                                </div>
                                {group.dismissed.length > 0 && (
                                    <div className="mt-1">
                                        <button type="button" onClick={() => setDismissedOpen(current => ({ ...current, [group.key]: !current[group.key] }))} className="flex items-center gap-1 text-[10px] font-medium text-gray-500 hover:text-[#3390EC]">
                                            <ChevronDown size={10} className={dismissedOpen[group.key] ? 'rotate-180' : ''} />
                                            Уволенные профили: {group.dismissed.length} · {dismissedOpen[group.key] ? 'Скрыть' : 'Показать'}
                                        </button>
                                        {dismissedOpen[group.key] && (
                                            <div className="mt-1 space-y-1">
                                                {group.dismissed.map(profile => (
                                                    <div key={profile.id} className="bg-gray-50 px-2 py-1">
                                                        <div className="text-[10px] font-medium text-gray-700">{profile.fullName}</div>
                                                        <div className="text-[9px] text-gray-500">{employmentLabel(profile)} · {formatPhone(profile.phone)} · {statusLabel(profile)}</div>
                                                        <DispatcherProfileActions target={profile.dispatcher} compact />
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                            ))}
                            </div>
                        )}
                    </div>
                )}
            </section>

            {pendingMainProfile && (
                <div
                    className="fixed inset-0 z-[120] flex items-center justify-center bg-black/40 p-4"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="main-profile-confirmation-title"
                    data-testid="main-profile-confirmation"
                    onClick={closeMainProfileConfirmation}
                >
                    <div className="w-[420px] max-w-full overflow-hidden rounded-lg bg-white shadow-2xl" onClick={event => event.stopPropagation()}>
                        <div className="border-b border-gray-200 px-4 py-3">
                            <h3 id="main-profile-confirmation-title" className="text-[15px] font-bold text-[#111]">Сделать профиль главным?</h3>
                            <p className="mt-1 text-[11px] leading-snug text-gray-600">
                                Главным профилем контакта станет {pendingMainProfile.parkName} / {employmentLabel(pendingMainProfile)}.
                            </p>
                        </div>
                        <dl className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-1.5 px-4 py-3 text-[11px]">
                            <dt className="text-gray-500">ФИО</dt>
                            <dd className="min-w-0 break-words font-semibold text-[#111]">{pendingMainProfile.fullName}</dd>
                            <dt className="text-gray-500">Парк</dt>
                            <dd className="min-w-0 break-words text-[#111]">{pendingMainProfile.parkName}</dd>
                            <dt className="text-gray-500">Тип оформления</dt>
                            <dd className="min-w-0 break-words text-[#111]">{employmentLabel(pendingMainProfile)}</dd>
                            <dt className="text-gray-500">Телефон</dt>
                            <dd className="min-w-0 break-words text-[#111]">{formatPhone(pendingMainProfile.phone)}</dd>
                            <dt className="text-gray-500">Статус</dt>
                            <dd className="min-w-0 break-words font-semibold text-emerald-700">{statusLabel(pendingMainProfile)}</dd>
                        </dl>
                        {mainError && <div role="alert" className="mx-4 mb-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-[11px] text-red-700">{mainError}</div>}
                        <div className="grid grid-cols-2 gap-2 border-t border-gray-200 px-4 py-3">
                            <button
                                type="button"
                                autoFocus
                                disabled={savingMainId !== null}
                                onClick={closeMainProfileConfirmation}
                                className="h-9 rounded bg-gray-100 px-3 text-[11px] font-semibold text-gray-700 hover:bg-gray-200 disabled:opacity-50"
                            >
                                Отмена
                            </button>
                            <button
                                type="button"
                                disabled={savingMainId !== null}
                                onClick={() => void confirmMainProfileChange()}
                                className="inline-flex h-9 items-center justify-center gap-1.5 rounded bg-[#3390EC] px-3 text-[11px] font-semibold text-white hover:bg-[#2B7FD4] disabled:opacity-50"
                            >
                                {savingMainId !== null && <Loader2 size={12} className="animate-spin" />}
                                {savingMainId !== null ? 'Сохраняем…' : 'Сделать главным'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {showReview && (
                <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/35 p-4" onClick={closeReview} data-testid="suggested-profile-review">
                    <div className="flex max-h-[86vh] w-[600px] max-w-full flex-col overflow-hidden rounded-lg bg-white shadow-2xl" onClick={event => event.stopPropagation()}>
                        <div className="flex items-start justify-between gap-3 border-b border-gray-200 px-4 py-3">
                            <div>
                                <h3 className="text-[15px] font-bold text-[#111]">Проверить профили</h3>
                                <p className="mt-0.5 text-[11px] font-medium text-gray-700">{formatFoundProfilesSummary(suggestions.length, suggestionGroups.length)}</p>
                                <p className="mt-1 text-[10px] leading-snug text-gray-500">Профили предложены по совпадению номера телефона и не будут привязаны без вашего подтверждения.</p>
                            </div>
                            <button type="button" disabled={attaching} onClick={closeReview} className="text-gray-400 hover:text-gray-700 disabled:opacity-50" title="Закрыть без изменений"><X size={17} /></button>
                        </div>
                        <div className="flex items-center justify-between gap-2 border-b border-gray-100 px-4 py-2">
                            <span className="text-[11px] font-semibold text-gray-700">Выбрано {selectedProfiles.length} из {selectableSuggestions.length}</span>
                            <button type="button" onClick={toggleAll} disabled={selectableSuggestions.length === 0} className="text-[11px] font-semibold text-[#3390EC] hover:text-[#2B7FD4] disabled:text-gray-400">
                                {allSelectableSelected ? 'Снять выбор' : 'Выбрать все'}
                            </button>
                        </div>
                        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3" data-testid="suggested-profiles-by-park">
                            {suggestionGroups.map(group => (
                                <section key={group.key} data-review-park={group.parkCode || group.parkName}>
                                    <div className="mb-1.5 flex items-center justify-between gap-2 border-b border-gray-100 pb-1">
                                        <h4 className="text-[12px] font-bold text-[#111]">{group.parkName}</h4>
                                        <span className="text-[9px] text-gray-400">{group.active.length + group.dismissed.length} проф.</span>
                                    </div>
                                    {group.activeCount > 1 && (
                                        <div className="mb-1.5 flex items-start gap-1.5 rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-[10px] text-amber-800" data-testid="multiple-active-anomaly">
                                            <AlertTriangle size={11} className="mt-px shrink-0" /> В этом парке несколько активных профилей. Проверьте каждый.
                                        </div>
                                    )}
                                    <div className="space-y-1.5">{group.active.map(profile => renderReviewProfile(profile, false))}</div>
                                    {group.dismissed.length > 0 && (
                                        <div className="mt-2">
                                            <button type="button" onClick={() => setReviewDismissedOpen(current => ({ ...current, [group.key]: !current[group.key] }))} className="flex items-center gap-1 text-[10px] font-semibold text-gray-500 hover:text-[#3390EC]">
                                                <ChevronDown size={10} className={reviewDismissedOpen[group.key] ? 'rotate-180' : ''} />
                                                Уволенные профили: {group.dismissed.length} · {reviewDismissedOpen[group.key] ? 'Скрыть' : 'Показать'}
                                            </button>
                                            {reviewDismissedOpen[group.key] && <div className="mt-1.5 space-y-1.5">{group.dismissed.map(profile => renderReviewProfile(profile, true))}</div>}
                                        </div>
                                    )}
                                </section>
                            ))}
                        </div>
                        <div className="border-t border-gray-200 px-4 py-3">
                            <div className={`mb-2 rounded px-3 py-2 text-[11px] ${selectedProfiles.length === 0 ? 'bg-gray-50 text-gray-600' : 'bg-blue-50 text-blue-900'}`} data-testid="selection-summary">
                                {selectedProfiles.length === 0 ? 'Выберите хотя бы один профиль' : formatSelectedProfilesSummary(selectedProfiles.length, selectedParkCount)}
                            </div>
                            {attachError && <div className="mb-2 text-[11px] text-red-600">{attachError}</div>}
                            <div className="flex justify-end gap-2">
                                <button type="button" disabled={attaching} onClick={closeReview} className="h-8 rounded bg-gray-100 px-3 text-[11px] font-semibold text-gray-700 hover:bg-gray-200 disabled:opacity-50">Закрыть без изменений</button>
                                <button type="button" disabled={attaching || selectedProfiles.length === 0} onClick={requestAttachment} className="inline-flex h-8 items-center gap-1 rounded bg-[#3390EC] px-3 text-[11px] font-semibold text-white hover:bg-[#2B7FD4] disabled:opacity-50">
                                    <Check size={12} /> {formatAttachButton(selectedProfiles.length)}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {showReview && showAttachConfirmation && (
                <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/45 p-4" onClick={() => !attaching && setShowAttachConfirmation(false)} data-testid="attach-confirmation">
                    <div className="w-[430px] max-w-full rounded-lg bg-white p-4 shadow-2xl" onClick={event => event.stopPropagation()}>
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <h3 className="text-[15px] font-bold text-[#111]">Подтвердите привязку</h3>
                                <p className="mt-2 text-[12px] leading-snug text-gray-700">
                                    Вы собираетесь привязать {selectedProfiles.length} {formatAttachButton(selectedProfiles.length).replace(/^Привязать \d+ /, '')} из {selectedParkCount} {selectedParkCount === 1 ? 'парка' : 'парков'} к контакту {contactPhone}.
                                </p>
                                <p className="mt-2 text-[11px] font-medium text-amber-800">Проверьте, что все выбранные профили принадлежат одному человеку.</p>
                            </div>
                            <button type="button" disabled={attaching} onClick={() => setShowAttachConfirmation(false)} className="text-gray-400 hover:text-gray-700 disabled:opacity-50"><X size={17} /></button>
                        </div>
                        <ul className="mt-3 space-y-1 rounded bg-gray-50 px-3 py-2 text-[11px] text-gray-700">
                            {confirmationGroups.map(group => <li key={group.key}>• {group.parkName}</li>)}
                        </ul>
                        <div className="mt-4 grid grid-cols-2 gap-2">
                            <button type="button" disabled={attaching} onClick={() => setShowAttachConfirmation(false)} className="h-9 whitespace-nowrap rounded bg-gray-100 px-2 text-[10px] font-semibold text-gray-700 hover:bg-gray-200 disabled:opacity-50">Назад к проверке</button>
                            <button type="button" disabled={attaching} onClick={() => void attachSelected()} className="inline-flex h-9 items-center justify-center gap-1 whitespace-nowrap rounded bg-[#3390EC] px-2 text-[10px] font-semibold text-white hover:bg-[#2B7FD4] disabled:opacity-50">
                                {attaching ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Подтвердить привязку
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    )
}
