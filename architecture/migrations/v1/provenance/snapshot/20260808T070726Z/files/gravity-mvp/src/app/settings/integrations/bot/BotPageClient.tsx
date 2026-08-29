"use client"

import { useState, useEffect, useCallback } from "react"
import { Loader2, X, Search, MessageCircle } from "lucide-react"

interface LinkedDriver {
    id: string
    telegramId: string
    username: string | null
    firstName: string | null
    lastName: string | null
    driverId: string
    driverName: string | null
    driverPhone: string | null
    submittedPhone: string | null
    submittedPhoneAt: string | null
    phoneMatches: boolean | null
    activeParkId: string | null
    parkName: string | null
    chatId: string | null
    createdAt: string
}

interface PendingRequest {
    id: string
    requestId: string | null
    source: 'registry' | 'legacy' | 'broken_mapping'
    telegramId: string
    phone: string | null
    username: string | null
    firstName: string | null
    lastName: string | null
    chatId: string | null
    createdAt: string
    lastSeenAt: string | null
    status: 'PENDING_MANAGER_LINK'
}

interface DriverSearchResult {
    id: string
    fullName: string
    phone: string | null
}

function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
}

function formatPhone(phone: string | null) {
    if (!phone) return 'не сохранён'
    const digits = phone.replace(/\D/g, '')
    if (digits.length === 11 && (digits.startsWith('7') || digits.startsWith('8'))) {
        return `+7 ${digits.slice(1, 4)} ${digits.slice(4, 7)}-${digits.slice(7, 9)}-${digits.slice(9)}`
    }
    return phone
}

function telegramFullName(row: { firstName: string | null; lastName: string | null }) {
    return [row.firstName, row.lastName].filter(Boolean).join(' ').trim()
}

function TelegramUsername({ username }: { username: string }) {
    return (
        <a
            href={`https://t.me/${encodeURIComponent(username)}`}
            target="_blank"
            rel="noreferrer"
            title="Открыть пользователя в Telegram"
            className="font-medium text-[#2AABEE] hover:underline"
        >
            @{username}
        </a>
    )
}

function DriverRow({ row, onUnlink }: { row: LinkedDriver; onUnlink: () => void }) {
    const [confirming, setConfirming] = useState(false)
    const [loading, setLoading] = useState(false)
    const tgName = telegramFullName(row)

    const handleUnlink = async () => {
        setLoading(true)
        await fetch(`/api/bot-users?telegramId=${row.telegramId}`, { method: 'DELETE' })
        onUnlink()
    }

    return (
        <div className="flex items-center min-h-[64px] px-4 py-2 hover:bg-[#F1F5FD] transition-colors border-b border-[#E4ECFC] last:border-0">
            <div className="w-9 h-9 rounded-full bg-[#2AABEE] text-white flex items-center justify-center text-[13px] font-semibold shrink-0 mr-3">
                {(row.driverName || '?').substring(0, 2).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
                <div className="text-[14px] font-medium text-[#0F172A] truncate">{row.driverName ?? '—'}</div>
                <div className="text-[12px] text-[#64748B]">
                    {row.username ? <><TelegramUsername username={row.username} /> · </> : (tgName ? `${tgName} · ` : '')}ID {row.telegramId}
                    {row.parkName ? ` · ${row.parkName}` : ''}
                    <span className="ml-1.5 rounded-full bg-emerald-100 text-emerald-700 px-1.5 py-0.5 font-medium">Привязан</span>
                </div>
                <div className="text-[11px] text-[#64748B] mt-0.5 flex flex-wrap items-center gap-x-2">
                    <span>Бот: <span className="font-mono">{formatPhone(row.submittedPhone)}</span></span>
                    <span>Профиль: <span className="font-mono">{formatPhone(row.driverPhone)}</span></span>
                    {row.phoneMatches === true && <span className="text-emerald-600 font-medium">совпадает</span>}
                    {row.phoneMatches === false && <span className="text-red-600 font-medium">не совпадает</span>}
                </div>
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
    const [linkError, setLinkError] = useState<string | null>(null)
    const [contacting, setContacting] = useState(false)
    const [contactSent, setContactSent] = useState(false)
    const [contactError, setContactError] = useState<string | null>(null)
    const tgName = telegramFullName(row)

    useEffect(() => {
        if (query.length < 3) { setResults([]); return }
        setSearching(true)
        const timer = setTimeout(async () => {
            try {
                const res = await fetch('/api/bot-link', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'search', query }),
                })
                const d = await res.json()
                setResults(d.drivers || [])
            } finally { setSearching(false) }
        }, 300)
        return () => { clearTimeout(timer); setSearching(false) }
    }, [query])

    const handleLink = async (driver: DriverSearchResult) => {
        setSaving(true)
        setLinkError(null)
        const response = await fetch('/api/bot-link', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'link', telegramId: row.telegramId, driverId: driver.id }),
        })
        if (!response.ok) {
            setSaving(false)
            setLinkError('Не удалось создать рабочую привязку. Проверьте профиль водителя Яндекс.')
            return
        }
        if (row.requestId) {
            await fetch(`/api/bot-users?requestId=${row.requestId}`, { method: 'DELETE' })
        }
        setSaving(false)
        onLinked()
    }

    const handleDismiss = async () => {
        setDismissing(true)
        await fetch(`/api/bot-users?requestId=${row.id}`, { method: 'DELETE' })
        onDismiss()
    }

    const handleContact = async () => {
        setContacting(true)
        setContactError(null)
        try {
            const response = await fetch('/api/bot-users', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ telegramId: row.telegramId }),
            })
            const result = await response.json().catch(() => ({}))
            if (!response.ok) {
                setContactError(result.error || 'Не удалось отправить сообщение')
                return
            }
            setContactSent(true)
        } catch {
            setContactError('Бот сейчас недоступен. Попробуйте ещё раз.')
        } finally {
            setContacting(false)
        }
    }

    return (
        <div className="px-4 py-2.5 border-b border-[#E4ECFC] last:border-0 hover:bg-[#F1F5FD] transition-colors">
            <div className="flex items-center">
                <div className="w-9 h-9 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center text-[16px] shrink-0 mr-3">⚠️</div>
                <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-medium text-[#0F172A]">
                        {row.username
                            ? <TelegramUsername username={row.username} />
                            : (tgName || `TG ID ${row.telegramId}`)}
                        {row.username && tgName && <span className="ml-2 font-normal text-[#64748B]">{tgName}</span>}
                        {row.phone && <span className="ml-2 font-normal text-[#64748B]">{row.phone}</span>}
                    </div>
                    <div className="text-[11px] text-[#64748B] flex items-center gap-1.5">
                        <span>
                            {!row.username && tgName ? 'Нет публичного @username · ' : ''}
                            ID {row.telegramId} · {formatDate(row.lastSeenAt || row.createdAt)}
                        </span>
                        <span className="rounded-full bg-amber-100 text-amber-700 px-1.5 py-0.5 font-medium">Ожидает привязки</span>
                    </div>
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
                                onClick={handleContact}
                                disabled={contacting || contactSent}
                                title="Попросить пользователя написать менеджеру в Telegram"
                                className="text-[11px] font-semibold text-[#2AABEE] border border-[#2AABEE] px-2 py-1 rounded hover:bg-sky-50 disabled:opacity-60 disabled:cursor-default flex items-center gap-1"
                            >
                                {contacting && <Loader2 size={10} className="animate-spin" />}
                                {contactSent ? 'Отправлено ✓' : 'Написать через бота'}
                            </button>
                            {row.source === 'legacy' && (
                                <button
                                    onClick={handleDismiss}
                                    disabled={dismissing}
                                    className="text-[11px] text-[#64748B] hover:text-[#0F172A] px-1.5 py-1 rounded hover:bg-gray-100"
                                >
                                    {dismissing ? <Loader2 size={10} className="animate-spin" /> : 'Убрать'}
                                </button>
                            )}
                        </>
                    )}
                    {showSearch && (
                        <button onClick={() => { setShowSearch(false); setQuery(''); setResults([]) }} className="text-[#64748B] hover:text-[#0F172A]">
                            <X size={14} />
                        </button>
                    )}
                </div>
            </div>

            {contactError && <div className="mt-1 ml-12 text-[11px] text-[#DC2626]">{contactError}</div>}

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
                    {searching ? (
                        <div className="text-[11px] text-[#64748B] flex items-center gap-1"><Loader2 size={10} className="animate-spin" /> Ищу...</div>
                    ) : results.length > 0 ? (
                        <div className="space-y-px">
                            {results.map(d => (
                                <div key={d.id} className="flex items-center justify-between py-1 px-1 hover:bg-white rounded">
                                    <div>
                                        <div className="text-[12px] font-medium text-[#0F172A]">{d.fullName}</div>
                                        {d.phone && <div className="text-[10px] text-[#64748B] font-mono">{d.phone}</div>}
                                    </div>
                                    <button
                                        disabled={saving}
                                        onClick={() => handleLink(d)}
                                        className="text-[11px] font-semibold text-white bg-[#2AABEE] px-2 py-0.5 rounded hover:bg-[#1E96D4] disabled:opacity-50 flex items-center gap-1"
                                    >
                                        {saving ? <Loader2 size={9} className="animate-spin" /> : 'Привязать'}
                                    </button>
                                </div>
                            ))}
                        </div>
                    ) : query.length >= 3 ? (
                        <div className="text-[11px] text-[#64748B] italic">Водители не найдены</div>
                    ) : (
                        <div className="text-[11px] text-[#64748B]">Введите минимум 3 символа</div>
                    )}
                    {linkError && <div className="mt-1 text-[11px] text-[#DC2626]">{linkError}</div>}
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
