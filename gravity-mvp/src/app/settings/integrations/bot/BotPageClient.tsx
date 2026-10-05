"use client"

import { useState, useEffect, useCallback } from "react"
import { Loader2, X, Search, MessageCircle } from "lucide-react"
import { deleteBotUserMutation } from "./bot-user-mutations"

interface LinkedDriver {
    id: string
    telegramId: string
    username: string | null
    driverId: string
    driverName: string | null
    driverPhone: string | null
    activeParkId: string | null
    parkName: string | null
    chatId: string | null
    createdAt: string
}

interface PendingRequest {
    id: string
    telegramId: string
    phone: string | null
    username: string | null
    firstName: string | null
    lastName: string | null
    chatId: string | null
    // The Contact that owns the Telegram Chat: the person a driver confirmation
    // must be recorded on before the link authority admits the link.
    chatContactId: string | null
    createdAt: string
}

interface DriverSearchResult {
    id: string
    yandexDriverId: string | null
    fullName: string
    phone: string | null
    parkId: string | null
    parkName: string | null
    workStatus: string | null
    currentStatus: string | null
    source: 'crm' | 'yandex'
    profileClusterKey: string | null
    personContactId: string | null
    personReviewRequired: boolean
}

// Whether this screen may offer a link for the selected Driver. It only decides
// what to show; the Telegram link authority and the Contacts confirmation both
// re-prove everything server-side.
type LinkAvailability = 'ready' | 'chat_required' | 'person_review_required'

function linkAvailability(row: PendingRequest, driver: DriverSearchResult): LinkAvailability {
    if (!row.chatId || !row.chatContactId) return 'chat_required'
    if (driver.personReviewRequired) return 'person_review_required'
    if (driver.personContactId && driver.personContactId !== row.chatContactId) return 'person_review_required'
    return 'ready'
}

function confirmationError(status: number, data: Record<string, unknown>): string {
    if (status === 401 || status === 403) return 'Нет прав для подтверждения водителя.'
    if (status === 503) return 'Парки Яндекса сейчас не отвечают. Повторите подтверждение позже.'
    if (status === 409 && (data.status === 'contradiction' || data.confirmation || data.automaticMerge)) {
        return 'Этот профиль водителя уже подтверждён для другого контакта. Нужна сверка контактов в CRM.'
    }
    if (status === 409) return 'Данные водителя устарели. Повторите поиск.'
    return 'Не удалось подтвердить водителя.'
}

function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
}

function DriverRow({ row, onUnlink }: { row: LinkedDriver; onUnlink: () => void }) {
    const [confirming, setConfirming] = useState(false)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const handleUnlink = async () => {
        setLoading(true)
        setError(null)
        try {
            await deleteBotUserMutation({ action: 'unlink', telegramId: row.telegramId })
            onUnlink()
        } catch (unlinkError) {
            setError(unlinkError instanceof Error ? unlinkError.message : 'Не удалось отвязать водителя')
        } finally {
            setLoading(false)
        }
    }

    return (
        <div className="flex items-center h-[56px] px-4 hover:bg-[#F1F5FD] transition-colors border-b border-[#E4ECFC] last:border-0">
            <div className="w-9 h-9 rounded-full bg-[#2AABEE] text-white flex items-center justify-center text-[13px] font-semibold shrink-0 mr-3">
                {(row.driverName || '?').substring(0, 2).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
                <div className="text-[14px] font-medium text-[#0F172A] truncate">{row.driverName ?? '—'}</div>
                <div className="text-[12px] text-[#64748B]">
                    {row.username ? `@${row.username} · ` : ''}ID {row.telegramId}
                    {row.parkName ? ` · ${row.parkName}` : ''}
                </div>
                {error && <div className="text-[10px] text-red-600 truncate">{error}</div>}
            </div>
            <div className="text-[11px] text-[#64748B] mr-3 shrink-0">{formatDate(row.createdAt)}</div>
            {row.chatId && (
                <a
                    href={`/messages?chatId=${row.chatId}`}
                    title="Открыть чат"
                    className="shrink-0 mr-2 text-[#64748B] hover:text-[#2AABEE] transition-colors"
                >
                    <MessageCircle size={15} />
                </a>
            )}
            {confirming ? (
                <div className="flex items-center gap-1.5 shrink-0">
                    <span className="text-[11px] text-[#64748B]">Отвязать?</span>
                    <button
                        onClick={handleUnlink}
                        disabled={loading}
                        className="text-[11px] font-semibold text-white bg-[#DC2626] px-2 py-1 rounded hover:bg-red-700 disabled:opacity-50 flex items-center gap-1"
                    >
                        {loading ? <Loader2 size={10} className="animate-spin" /> : 'Да'}
                    </button>
                    <button onClick={() => setConfirming(false)} className="text-[11px] text-[#64748B] hover:text-[#0F172A]">Нет</button>
                </div>
            ) : (
                <button
                    onClick={() => setConfirming(true)}
                    className="shrink-0 text-[11px] text-[#64748B] hover:text-[#DC2626] transition-colors px-2 py-1 rounded hover:bg-red-50"
                >
                    Отвязать
                </button>
            )}
        </div>
    )
}

function RequestRow({ row, onDismiss, onLinked }: { row: PendingRequest; onDismiss: () => void; onLinked: () => void }) {
    const [showSearch, setShowSearch] = useState(false)
    const [query, setQuery] = useState('')
    const [results, setResults] = useState<DriverSearchResult[]>([])
    const [searching, setSearching] = useState(false)
    const [saving, setSaving] = useState(false)
    const [dismissing, setDismissing] = useState(false)
    const [checkedParks, setCheckedParks] = useState(0)
    const [error, setError] = useState<string | null>(null)
    // Explicit, visible person confirmation: never a side effect of linking.
    const [confirmFor, setConfirmFor] = useState<DriverSearchResult | null>(null)
    const [confirming, setConfirming] = useState(false)
    const [confirmedDriverId, setConfirmedDriverId] = useState<string | null>(null)
    const [refreshNonce, setRefreshNonce] = useState(0)
    // The refresh a confirmation requests must finish before linking is offered:
    // the link then runs against the refreshed authoritative state.
    const [settledNonce, setSettledNonce] = useState(0)

    useEffect(() => {
        if (query.length < 3) { setResults([]); setSettledNonce(settled => Math.max(settled, refreshNonce)); return }
        setSearching(true)
        setError(null)
        const timer = setTimeout(async () => {
            try {
                const res = await fetch('/api/bot-link', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'search', query }),
                })
                const d = await res.json()
                if (!res.ok) throw new Error(d.error || 'Ошибка поиска водителя')
                setResults(d.drivers || [])
                setCheckedParks(d.checkedParks || 0)
                if ((d.errors || []).length > 0 && (d.drivers || []).length === 0) {
                    setError('Не все парки Яндекса ответили. Попробуйте поиск ещё раз.')
                }
            } catch (searchError) {
                setResults([])
                setError(searchError instanceof Error ? searchError.message : 'Ошибка поиска водителя')
            } finally { setSearching(false); setSettledNonce(settled => Math.max(settled, refreshNonce)) }
        }, 300)
        return () => { clearTimeout(timer); setSearching(false) }
    }, [query, refreshNonce])

    const handleLink = async (driver: DriverSearchResult) => {
        setSaving(true)
        setError(null)
        try {
            const response = await fetch('/api/bot-link', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'link',
                    telegramId: row.telegramId,
                    username: row.username,
                    driverId: driver.id,
                    yandexDriverId: driver.yandexDriverId,
                    driverName: driver.fullName,
                    parkId: driver.parkId,
                }),
            })
            const data = await response.json()
            if (!response.ok || !data.success) {
                if (data.code === 'PERSON_CONFIRMATION_REQUIRED') {
                    if (driver.profileClusterKey && row.chatContactId) {
                        setConfirmFor(driver)
                        return
                    }
                    throw new Error('Подтвердить водителя здесь нельзя: профиль не найден в парках Яндекса. Найдите водителя по телефону или ВУ.')
                }
                throw new Error(data.error || 'Не удалось привязать водителя')
            }

            try {
                await deleteBotUserMutation({ action: 'dismiss', requestId: row.id })
            } catch {
                throw new Error('Связь сохранена, но запрос не удалось убрать из очереди')
            }
            onLinked()
        } catch (linkError) {
            setError(linkError instanceof Error ? linkError.message : 'Не удалось привязать водителя')
        } finally {
            setSaving(false)
        }
    }

    // Contacts owns the person decision: its public route re-runs the Fleet search,
    // requires a fresh exact cluster and records the confirmation. Telegram code
    // writes nothing here.
    const handleConfirm = async (driver: DriverSearchResult) => {
        if (!row.chatContactId || !driver.profileClusterKey) return
        setConfirming(true)
        setError(null)
        try {
            const response = await fetch(`/api/contacts/${encodeURIComponent(row.chatContactId)}/driver-person`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    profileClusterKey: driver.profileClusterKey,
                    representativeDriverId: driver.id,
                    searchInput: query.trim(),
                }),
            })
            const data = await response.json().catch(() => ({})) as Record<string, unknown>
            // 502 means the confirmation was persisted and only the Fleet follow-up failed.
            const confirmation = data.confirmation as { contactId?: string } | undefined
            if (response.ok || (response.status === 502 && confirmation)) {
                setConfirmedDriverId(driver.id)
                if (confirmation?.contactId && confirmation.contactId !== row.chatContactId) {
                    // Contacts reconciled the person onto another Contact: reload the
                    // requests so the link uses the authoritative Chat Contact.
                    onLinked()
                    return
                }
                setRefreshNonce(n => n + 1)
                return
            }
            setError(confirmationError(response.status, data))
            if (response.status === 409 && !data.confirmation && !data.automaticMerge && data.status !== 'contradiction') {
                setConfirmFor(null)
                setRefreshNonce(n => n + 1)
            }
        } catch {
            setError('Не удалось подтвердить водителя.')
        } finally {
            setConfirming(false)
        }
    }

    const handleDismiss = async () => {
        setDismissing(true)
        setError(null)
        try {
            await deleteBotUserMutation({ action: 'dismiss', requestId: row.id })
            onDismiss()
        } catch (dismissError) {
            setError(dismissError instanceof Error ? dismissError.message : 'Не удалось убрать запрос')
        } finally {
            setDismissing(false)
        }
    }

    const telegramName = [row.firstName, row.lastName].filter(Boolean).join(' ').trim()

    return (
        <div className="px-4 py-2.5 border-b border-[#E4ECFC] last:border-0 hover:bg-[#F1F5FD] transition-colors">
            <div className="flex items-center">
                <div className="w-9 h-9 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center text-[16px] shrink-0 mr-3">⚠️</div>
                <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-medium text-[#0F172A]">
                        {row.username ? `@${row.username}` : telegramName || `TG ID ${row.telegramId}`}
                        {row.phone && <span className="ml-2 font-normal text-[#64748B]">{row.phone}</span>}
                    </div>
                    <div className="text-[11px] text-[#64748B]">ID {row.telegramId} · {formatDate(row.createdAt)}</div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0 ml-2">
                    {row.chatId && (
                        <a
                            href={`/messages?chatId=${row.chatId}`}
                            title="Открыть чат"
                            className="text-[#64748B] hover:text-[#2AABEE] transition-colors"
                        >
                            <MessageCircle size={15} />
                        </a>
                    )}
                    {!showSearch && (
                        <>
                            <button
                                onClick={() => setShowSearch(true)}
                                className="text-[11px] font-semibold text-white bg-[#2AABEE] px-2 py-1 rounded hover:bg-[#1E96D4]"
                            >
                                Привязать
                            </button>
                            <button
                                onClick={handleDismiss}
                                disabled={dismissing}
                                className="text-[11px] text-[#64748B] hover:text-[#0F172A] px-1.5 py-1 rounded hover:bg-gray-100"
                            >
                                {dismissing ? <Loader2 size={10} className="animate-spin" /> : 'Убрать'}
                            </button>
                        </>
                    )}
                    {showSearch && (
                        <button onClick={() => { setShowSearch(false); setQuery(''); setResults([]); setConfirmFor(null); setConfirmedDriverId(null) }} className="text-[#64748B] hover:text-[#0F172A]">
                            <X size={14} />
                        </button>
                    )}
                </div>
            </div>

            {error && !showSearch && <div className="mt-1 ml-12 text-[11px] text-red-600">{error}</div>}

            {showSearch && (
                <div className="mt-2 ml-12">
                    <div className="flex items-center gap-1.5 mb-1.5">
                        <Search size={12} className="text-[#64748B] shrink-0" />
                        <input
                            autoFocus
                            value={query}
                            onChange={e => setQuery(e.target.value)}
                            placeholder="Телефон или имя водителя..."
                            className="flex-1 h-[28px] rounded border border-[#E4ECFC] px-2 text-[12px] outline-none focus:border-[#2AABEE]"
                        />
                    </div>
                    {error && !searching && <div className="text-[11px] text-red-600 mb-1">{error}</div>}
                    {(!row.chatId || !row.chatContactId) && (
                        <div className="text-[11px] text-[#64748B] mb-1">
                            Пользователь ещё не писал боту. Привязка станет доступна после его первого сообщения.
                        </div>
                    )}
                    {confirmFor && (() => {
                        const current = results.find(r => r.id === confirmFor.id) ?? confirmFor
                        const confirmed = confirmedDriverId === confirmFor.id
                        const blocked = linkAvailability(row, current) !== 'ready'
                        return (
                            <div className="mb-1.5 rounded border border-[#E4ECFC] bg-white px-2 py-1.5">
                                <div className="text-[12px] font-medium text-[#0F172A]">
                                    {current.fullName}{current.parkName ? ` · ${current.parkName}` : ''}
                                </div>
                                {blocked ? (
                                    <div className="text-[11px] text-red-600 mt-0.5">
                                        Профиль водителя относится к другому контакту в CRM. Нужна сверка контактов.
                                    </div>
                                ) : confirmed ? (
                                    <>
                                        <div className="text-[11px] text-[#059669] mt-0.5">Водитель подтверждён.</div>
                                        <button
                                            disabled={saving || searching || settledNonce !== refreshNonce}
                                            onClick={() => handleLink(current)}
                                            className="mt-1 text-[11px] font-semibold text-white bg-[#2AABEE] px-2 py-0.5 rounded hover:bg-[#1E96D4] disabled:opacity-50 flex items-center gap-1"
                                        >
                                            {saving ? <Loader2 size={9} className="animate-spin" /> : 'Привязать Telegram'}
                                        </button>
                                    </>
                                ) : (
                                    <>
                                        <div className="text-[11px] text-[#64748B] mt-0.5">
                                            Перед привязкой Telegram необходимо подтвердить, что этот профиль водителя относится к этому человеку.
                                        </div>
                                        <div className="flex items-center gap-1.5 mt-1">
                                            <button
                                                disabled={confirming}
                                                onClick={() => handleConfirm(current)}
                                                className="text-[11px] font-semibold text-white bg-[#2AABEE] px-2 py-0.5 rounded hover:bg-[#1E96D4] disabled:opacity-50 flex items-center gap-1"
                                            >
                                                {confirming ? <Loader2 size={9} className="animate-spin" /> : 'Подтвердить водителя'}
                                            </button>
                                            <button
                                                disabled={confirming}
                                                onClick={() => setConfirmFor(null)}
                                                className="text-[11px] text-[#64748B] hover:text-[#0F172A] px-1.5 py-0.5 rounded hover:bg-gray-100"
                                            >
                                                Отмена
                                            </button>
                                        </div>
                                    </>
                                )}
                            </div>
                        )
                    })()}
                    {searching ? (
                        <div className="text-[11px] text-[#64748B] flex items-center gap-1"><Loader2 size={10} className="animate-spin" /> Ищу...</div>
                    ) : results.length > 0 ? (
                        <div className="space-y-px">
                            {results.map(d => (
                                <div key={`${d.parkId || 'crm'}:${d.yandexDriverId || d.id}`} className="flex items-center justify-between py-1 px-1 hover:bg-white rounded">
                                    <div>
                                        <div className="text-[12px] font-medium text-[#0F172A]">{d.fullName}</div>
                                        <div className="text-[10px] text-[#64748B]">
                                            {d.phone && <span className="font-mono">{d.phone}</span>}
                                            {d.phone && d.parkName && <span> · </span>}
                                            {d.parkName && <span>{d.parkName}</span>}
                                            {d.workStatus === 'fired' && <span className="text-red-600"> · уволен</span>}
                                        </div>
                                    </div>
                                    {linkAvailability(row, d) === 'person_review_required' ? (
                                        <span
                                            title="Профиль водителя относится к другому контакту в CRM. Сначала выполните сверку контактов."
                                            className="text-[10px] text-red-600 shrink-0 ml-2"
                                        >
                                            Нужна сверка контакта
                                        </span>
                                    ) : linkAvailability(row, d) === 'ready' ? (
                                        <button
                                            disabled={saving || confirming}
                                            onClick={() => handleLink(d)}
                                            className="text-[11px] font-semibold text-white bg-[#2AABEE] px-2 py-0.5 rounded hover:bg-[#1E96D4] disabled:opacity-50 flex items-center gap-1"
                                        >
                                            {saving ? <Loader2 size={9} className="animate-spin" /> : 'Привязать'}
                                        </button>
                                    ) : null}
                                </div>
                            ))}
                        </div>
                    ) : !error && query.length >= 3 ? (
                        <div className="text-[11px] text-[#64748B] italic">
                            Водители не найдены{checkedParks > 0 ? ` в ${checkedParks} парках Яндекса` : ''}
                        </div>
                    ) : !error ? (
                        <div className="text-[11px] text-[#64748B]">Введите минимум 3 символа</div>
                    ) : null}
                </div>
            )}
        </div>
    )
}

function BotDriversTab() {
    const [linked, setLinked] = useState<LinkedDriver[]>([])
    const [requests, setRequests] = useState<PendingRequest[]>([])
    const [loading, setLoading] = useState(true)

    const load = useCallback(async () => {
        setLoading(true)
        try {
            const res = await fetch('/api/bot-users')
            const d = await res.json()
            setLinked(d.linked || [])
            setRequests(d.requests || [])
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => { load() }, [load])

    if (loading) {
        return (
            <div className="flex items-center justify-center h-40 text-[#64748B]">
                <Loader2 size={20} className="animate-spin mr-2" /> Загрузка...
            </div>
        )
    }

    return (
        <div className="space-y-4">
            {/* Pending requests */}
            {requests.length > 0 && (
                <div>
                    <div className="text-[10px] font-bold text-[#64748B] uppercase tracking-wider px-4 pb-1">
                        Запросы привязки — {requests.length}
                    </div>
                    <div className="bg-white rounded-xl border border-[#E4ECFC]">
                        {requests.map(r => (
                            <RequestRow
                                key={r.id}
                                row={r}
                                onDismiss={() => { setRequests(prev => prev.filter(x => x.id !== r.id)) }}
                                onLinked={load}
                            />
                        ))}
                    </div>
                </div>
            )}

            {/* Linked drivers */}
            <div>
                <div className="text-[10px] font-bold text-[#64748B] uppercase tracking-wider px-4 pb-1">
                    Привязаны — {linked.length}
                </div>
                {linked.length === 0 ? (
                    <div className="bg-white rounded-xl border border-[#E4ECFC] px-4 py-6 text-center text-[13px] text-[#64748B] italic">
                        Нет привязанных водителей
                    </div>
                ) : (
                    <div className="bg-white rounded-xl border border-[#E4ECFC]">
                        {linked.map(row => (
                            <DriverRow
                                key={row.id}
                                row={row}
                                onUnlink={() => { setLinked(prev => prev.filter(x => x.id !== row.id)) }}
                            />
                        ))}
                    </div>
                )}
            </div>
        </div>
    )
}

export default function BotPageClient({ iframeSrc }: { iframeSrc: string }) {
    const [tab, setTab] = useState<'panel' | 'drivers'>('panel')

    return (
        <div className="flex flex-col gap-4 h-[calc(100vh-theme(spacing.16))] pb-6 mt-[4px]">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-3xl font-bold text-foreground">Телеграм Бот</h1>
                    <p className="text-[#64748B] mt-[2px] text-sm">Управление ботом и привязками водителей</p>
                </div>
            </div>

            {/* Tabs */}
            <div className="flex gap-1 border-b border-[#E4ECFC]">
                <button
                    onClick={() => setTab('panel')}
                    className={`px-4 py-2 text-[13px] font-medium border-b-2 transition-colors ${
                        tab === 'panel'
                            ? 'border-[#2AABEE] text-[#2AABEE]'
                            : 'border-transparent text-[#64748B] hover:text-[#0F172A]'
                    }`}
                >
                    Панель бота
                </button>
                <button
                    onClick={() => setTab('drivers')}
                    className={`px-4 py-2 text-[13px] font-medium border-b-2 transition-colors ${
                        tab === 'drivers'
                            ? 'border-[#2AABEE] text-[#2AABEE]'
                            : 'border-transparent text-[#64748B] hover:text-[#0F172A]'
                    }`}
                >
                    Водители
                </button>
            </div>

            {/* Tab content */}
            {tab === 'panel' ? (
                <div className="flex-1 bg-black/5 rounded-xl border shadow-inner overflow-hidden relative">
                    <iframe
                        src={iframeSrc}
                        className="w-full h-full border-0 absolute top-0 left-0"
                        title="Telegram Bot Admin Panel"
                        allow="clipboard-write"
                    />
                </div>
            ) : (
                <div className="flex-1 overflow-y-auto">
                    <BotDriversTab />
                </div>
            )}
        </div>
    )
}
