"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { AlertTriangle, Check, Database, Loader2, Search, X } from "lucide-react"

import type { DriverCatalogSummary, DriverSearchResult } from "@/lib/driver-profile-search"
import DispatcherProfileActions from "./DispatcherProfileActions"

interface DriverCatalogSearchActionsProps {
    contactId: string
    contactDisplayName: string
    phone: string | null
    onRefetch: () => Promise<unknown> | void
}

interface DriverSearchResponse {
    drivers: DriverSearchResult[]
    total: number
    catalog?: DriverCatalogSummary
    error?: string
}

function formatPhone(phone: string | null): string {
    if (!phone) return 'Телефон не указан'
    const digits = phone.replace(/\D/g, '')
    if (digits.length === 11 && digits.startsWith('7')) {
        return `+7 ${digits.slice(1, 4)} ${digits.slice(4, 7)}-${digits.slice(7, 9)}-${digits.slice(9)}`
    }
    return phone
}

function formatDateTime(value: string | null | undefined): string {
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

export default function DriverCatalogSearchActions({
    contactId,
    contactDisplayName,
    phone,
    onRefetch,
}: DriverCatalogSearchActionsProps) {
    const [open, setOpen] = useState(false)
    const [query, setQuery] = useState('')
    const [results, setResults] = useState<DriverSearchResult[]>([])
    const [catalog, setCatalog] = useState<DriverCatalogSummary | null>(null)
    const [selectedIds, setSelectedIds] = useState<string[]>([])
    const [loading, setLoading] = useState(false)
    const [attaching, setAttaching] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const requestSequence = useRef(0)

    useEffect(() => {
        setOpen(false)
        setQuery('')
        setResults([])
        setCatalog(null)
        setSelectedIds([])
        setError(null)
        requestSequence.current += 1
    }, [contactId])

    const selectedResults = useMemo(
        () => results.filter(result => selectedIds.includes(result.id)),
        [results, selectedIds],
    )

    const runSearch = async (searchQuery: string) => {
        const normalizedQuery = searchQuery.trim()
        if (normalizedQuery.length < 2) {
            setError('Введите не менее двух символов')
            setResults([])
            return
        }
        const sequence = ++requestSequence.current
        setLoading(true)
        setError(null)
        setSelectedIds([])
        try {
            const response = await fetch(`/api/drivers-search?q=${encodeURIComponent(normalizedQuery)}&limit=50`)
            const body = await response.json().catch(() => ({})) as DriverSearchResponse
            if (sequence !== requestSequence.current) return
            if (!response.ok) {
                setError(body.error || `Ошибка ${response.status}`)
                setResults([])
                return
            }
            setResults(body.drivers || [])
            setCatalog(body.catalog || null)
        } catch (searchError: unknown) {
            if (sequence !== requestSequence.current) return
            setError(searchError instanceof Error ? searchError.message : 'Ошибка сети')
            setResults([])
        } finally {
            if (sequence === requestSequence.current) setLoading(false)
        }
    }

    const openManualSearch = () => {
        requestSequence.current += 1
        setOpen(true)
        setQuery('')
        setResults([])
        setCatalog(null)
        setSelectedIds([])
        setError(null)
        setLoading(false)
    }

    const checkAcrossParks = () => {
        const initialQuery = phone || contactDisplayName
        setOpen(true)
        setQuery(initialQuery)
        void runSearch(initialQuery)
    }

    const toggleResult = (result: DriverSearchResult) => {
        if (result.linkedContact) return
        setSelectedIds(current => current.includes(result.id)
            ? current.filter(id => id !== result.id)
            : [...current, result.id])
    }

    const attachSelected = async () => {
        if (selectedResults.length === 0 || attaching) return
        setAttaching(true)
        setError(null)
        try {
            const response = await fetch(`/api/contacts/${contactId}/driver-profiles/attach`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    driverIds: selectedResults.map(result => result.id),
                    selectedBy: 'operator',
                }),
            })
            const body = await response.json().catch(() => ({}))
            if (!response.ok || body.ok === false) {
                setError(body.error || `Ошибка ${response.status}`)
                return
            }
            await onRefetch()
            setOpen(false)
        } catch (attachError: unknown) {
            setError(attachError instanceof Error ? attachError.message : 'Ошибка сети')
        } finally {
            setAttaching(false)
        }
    }

    return (
        <>
            <div className="mb-2 grid grid-cols-2 gap-1.5" data-testid="driver-catalog-actions">
                <button
                    type="button"
                    onClick={openManualSearch}
                    title="Найти профиль в локальном каталоге водителей"
                    className="inline-flex h-7 min-w-0 items-center justify-center gap-1 rounded bg-blue-50 px-2 text-[10px] font-semibold text-[#3390EC] hover:bg-blue-100"
                >
                    <Search size={11} className="shrink-0" />
                    <span className="truncate">Найти водителя</span>
                </button>
                <button
                    type="button"
                    onClick={checkAcrossParks}
                    title="Проверить локальный каталог всех шести парков"
                    className="inline-flex h-7 min-w-0 items-center justify-center gap-1 rounded bg-gray-100 px-2 text-[10px] font-semibold text-gray-700 hover:bg-gray-200"
                >
                    <Database size={11} className="shrink-0" />
                    <span className="truncate">Проверить в парках</span>
                </button>
            </div>

            {open && (
                <div
                    className="fixed inset-0 z-[125] flex items-center justify-center bg-black/40 p-4"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="driver-catalog-search-title"
                    data-testid="driver-catalog-search"
                    onClick={() => !attaching && setOpen(false)}
                >
                    <div className="flex max-h-[86vh] w-[640px] max-w-full flex-col overflow-hidden rounded-lg bg-white shadow-2xl" onClick={event => event.stopPropagation()}>
                        <div className="flex items-start justify-between gap-3 border-b border-gray-200 px-4 py-3">
                            <div className="min-w-0">
                                <h3 id="driver-catalog-search-title" className="text-[15px] font-bold text-[#111]">Поиск профиля водителя</h3>
                                <p className="mt-0.5 text-[10px] text-gray-500">Локальный каталог парков</p>
                            </div>
                            <button type="button" disabled={attaching} onClick={() => setOpen(false)} title="Закрыть" className="shrink-0 text-gray-400 hover:text-gray-700 disabled:opacity-50">
                                <X size={17} />
                            </button>
                        </div>

                        <form
                            className="flex gap-2 border-b border-gray-100 px-4 py-3"
                            onSubmit={event => {
                                event.preventDefault()
                                void runSearch(query)
                            }}
                        >
                            <input
                                autoFocus
                                value={query}
                                onChange={event => setQuery(event.target.value)}
                                placeholder="ФИО, телефон или ID профиля"
                                aria-label="Поиск водителя"
                                className="h-8 min-w-0 flex-1 rounded border border-gray-300 px-2.5 text-[11px] outline-none focus:border-[#3390EC]"
                            />
                            <button type="submit" disabled={loading} className="inline-flex h-8 shrink-0 items-center gap-1 rounded bg-[#3390EC] px-3 text-[10px] font-semibold text-white hover:bg-[#2B7FD4] disabled:opacity-50">
                                {loading ? <Loader2 size={11} className="animate-spin" /> : <Search size={11} />}
                                Найти
                            </button>
                        </form>

                        {catalog && (
                            <div className={`flex items-start gap-1.5 border-b px-4 py-2 text-[10px] ${catalog.coverage === 'complete' ? 'border-emerald-100 bg-emerald-50 text-emerald-800' : 'border-amber-100 bg-amber-50 text-amber-900'}`} data-testid="driver-catalog-coverage">
                                {catalog.coverage === 'complete' ? <Check size={11} className="mt-px shrink-0" /> : <AlertTriangle size={11} className="mt-px shrink-0" />}
                                <span>
                                    Каталог: {catalog.availableParkCount} из {catalog.configuredParkCount} парков
                                    {' · '}Последняя синхронизация: {formatDateTime(catalog.lastSuccessfulSyncAt)}
                                </span>
                            </div>
                        )}

                        <div className="flex-1 overflow-y-auto px-4 py-2" data-testid="driver-catalog-results">
                            {loading && <div className="py-8 text-center text-[11px] text-gray-500">Ищем в локальном каталоге…</div>}
                            {!loading && error && <div role="alert" className="my-2 rounded border border-red-200 bg-red-50 px-3 py-2 text-[11px] text-red-700">{error}</div>}
                            {!loading && !error && results.length === 0 && query.trim().length >= 2 && (
                                <div className="py-8 text-center text-[11px] text-gray-500">Профили не найдены</div>
                            )}
                            {!loading && results.map(result => {
                                const linkedToThisContact = result.linkedContact?.id === contactId
                                const unavailable = Boolean(result.linkedContact)
                                const checked = selectedIds.includes(result.id)
                                return (
                                    <label key={result.id} className={`mb-1.5 flex gap-2 rounded border px-3 py-2 ${unavailable ? 'border-gray-200 bg-gray-50' : checked ? 'border-[#3390EC] bg-blue-50' : 'border-gray-200 bg-white'}`}>
                                        <input
                                            type="checkbox"
                                            checked={checked}
                                            disabled={unavailable}
                                            onChange={() => toggleResult(result)}
                                            aria-label={`Выбрать профиль ${result.fullName} — ${result.park?.parkName || 'Парк не определён'}`}
                                        />
                                        <div className="min-w-0 flex-1">
                                            <div className="flex items-start justify-between gap-2">
                                                <span className="min-w-0 break-words text-[12px] font-semibold text-[#111]">{result.fullName}</span>
                                                <span className={`shrink-0 text-[9px] font-semibold ${result.status === 'working' ? 'text-emerald-700' : 'text-gray-500'}`}>{result.statusLabel}</span>
                                            </div>
                                            <div className="mt-0.5 text-[10px] text-gray-700">
                                                {result.park?.parkName || 'Парк не определён'} · {result.employmentTypeLabel}
                                                {result.isMain && <span className="ml-1 rounded bg-emerald-50 px-1 py-0.5 font-semibold text-emerald-700">Главный</span>}
                                            </div>
                                            <div className="text-[10px] text-gray-500">{formatPhone(result.phone)}</div>
                                            <div className="mt-0.5 break-all text-[9px] text-gray-400">ID: {result.externalDriverProfileId || 'не указан'}</div>
                                            <div className="text-[9px] text-gray-400">Синхронизация: {formatDateTime(result.lastSuccessfulSyncAt)}</div>
                                            <DispatcherProfileActions target={result.dispatcher} compact />
                                            {result.linkedContact && (
                                                <div className={`mt-1 text-[10px] font-medium ${linkedToThisContact ? 'text-emerald-700' : 'text-amber-700'}`}>
                                                    {linkedToThisContact ? 'Уже связан с этим контактом' : `Связан с контактом «${result.linkedContact.displayName}»`}
                                                </div>
                                            )}
                                            {result.anomaly && (
                                                <div className="mt-1 flex items-start gap-1 text-[10px] text-amber-700">
                                                    <AlertTriangle size={10} className="mt-px shrink-0" />
                                                    <span>{result.anomaly}</span>
                                                </div>
                                            )}
                                        </div>
                                    </label>
                                )
                            })}
                        </div>

                        <div className="flex items-center justify-between gap-2 border-t border-gray-200 px-4 py-3">
                            <span className="text-[10px] text-gray-500">Выбрано: {selectedResults.length}</span>
                            <div className="flex gap-2">
                                <button type="button" disabled={attaching} onClick={() => setOpen(false)} className="h-8 rounded bg-gray-100 px-3 text-[10px] font-semibold text-gray-700 hover:bg-gray-200 disabled:opacity-50">
                                    Отмена
                                </button>
                                <button
                                    type="button"
                                    disabled={selectedResults.length === 0 || attaching}
                                    onClick={() => void attachSelected()}
                                    className="inline-flex h-8 items-center gap-1 rounded bg-[#3390EC] px-3 text-[10px] font-semibold text-white hover:bg-[#2B7FD4] disabled:opacity-50"
                                >
                                    {attaching && <Loader2 size={11} className="animate-spin" />}
                                    Привязать выбранные
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </>
    )
}
