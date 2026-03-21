"use client"

import { useState, useEffect } from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { Search, MessageSquare, X, Send } from "lucide-react"
import type { DriverCard as DriverCardType } from "../actions"
import { sendTelegramMessage } from "../../tg-actions"
import { sendMaxMessage } from "../../max-actions"
import { DriverCardGrid } from "../components/DriverCardGrid"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

interface CardsClientProps {
    initialDrivers: DriverCardType[]
    total: number
    currentPage: number
    initialSearch: string
    initialSegment: string
    initialStatus: string
    initialDateRange: number
    initialSortBy: string
}

// ─── Send Message Modal ────────────────────────────────────────────────────

function SendMessageModal({
    driver,
    telegramConnections,
    maxConnections,
    onClose,
}: {
    driver: DriverCardType
    telegramConnections: any[]
    maxConnections: any[]
    onClose: () => void
}) {
    const [channel, setChannel] = useState<"telegram" | "max">("telegram")
    const [message, setMessage] = useState("")
    const [status, setStatus] = useState<"idle" | "sending" | "success" | "error">("idle")
    const [error, setError] = useState("")
    
    // Derived state for the active connection based on selected channel
    const activeConnections = channel === "telegram" ? telegramConnections : maxConnections
    
    const [selectedConnection, setSelectedConnection] = useState<string>(
        activeConnections.find((c: any) => c.isDefault)?.id || activeConnections[0]?.id || ""
    )

    // Reset selected connection when switching channels
    useEffect(() => {
        setSelectedConnection(activeConnections.find((c: any) => c.isDefault)?.id || activeConnections[0]?.id || "")
    }, [channel, activeConnections])

    const handleSend = async () => {
        if (!message.trim()) return
        if (!driver.phone) {
            setError("Нет номера телефона")
            setStatus("error")
            return
        }
        setStatus("sending")
        try {
            if (channel === "telegram") {
                await sendTelegramMessage(driver.phone, message, selectedConnection)
            } else {
                await sendMaxMessage(driver.phone, message, { 
                    connectionId: selectedConnection,
                    isPersonal: channel === "max",
                    name: driver.fullName
                })
            }
            setStatus("success")
            setTimeout(onClose, 2000)
        } catch (err: any) {
            setError(err.message)
            setStatus("error")
        }
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="relative w-full max-w-lg rounded-2xl bg-white p-8 shadow-xl animate-in zoom-in-95 duration-200">
                <button
                    onClick={onClose}
                    className="absolute right-6 top-6 text-muted-foreground transition-colors hover:text-foreground"
                >
                    <X size={24} />
                </button>

                <h2 className="mb-2 flex items-center gap-3 text-2xl font-bold text-foreground">
                    <MessageSquare size={24} className="text-primary" />
                    Сообщение {driver.fullName.split(' ')[0]}
                </h2>
                <div className="mb-6 font-mono text-xs tracking-widest text-muted-foreground uppercase">
                    Кому: {driver.phone || "—"}
                </div>

                {status === "success" ? (
                    <div className="py-12 text-center text-green-600 animate-in zoom-in">
                        <p className="text-4xl mb-4">✓</p>
                        <p className="font-bold">Сообщение отправлено!</p>
                    </div>
                ) : (
                    <div className="space-y-6">
                        <div className="flex gap-2 p-1 bg-secondary rounded-xl">
                            <button
                                onClick={() => setChannel("telegram")}
                                className={`flex-1 py-1.5 text-sm font-medium rounded-lg transition-colors ${channel === "telegram" ? "bg-white shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                            >
                                Telegram
                            </button>
                            <button
                                onClick={() => setChannel("max")}
                                className={`flex-1 py-1.5 text-sm font-medium rounded-lg transition-colors ${channel === "max" ? "bg-white shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                            >
                                MAX
                            </button>
                        </div>

                        {activeConnections.length > 0 ? (
                            <div className="relative">
                                <label className="mb-2 block text-sm font-medium text-muted-foreground">
                                    Отправить с аккаунта
                                </label>
                                <select 
                                    value={selectedConnection}
                                    onChange={(e) => setSelectedConnection(e.target.value)}
                                    className="w-full rounded-xl border bg-gray-50 p-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary/50"
                                    disabled={status === "sending"}
                                >
                                    {activeConnections.map((c: any) => (
                                        <option key={c.id} value={c.id}>
                                            {c.name || 'Аккаунт без имени'} {c.phoneNumber ? `(${c.phoneNumber})` : ''} {c.isDefault ? '- Основной' : ''}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        ) : (
                            <div className="p-3 text-sm text-amber-600 bg-amber-50 border border-amber-200 rounded-xl">
                                Нет активных подключений для {channel === "telegram" ? "Telegram" : "MAX"}. Перейдите в настройки мессенджера.
                            </div>
                        )}
                        <textarea
                            value={message}
                            onChange={(e) => setMessage(e.target.value)}
                            className="h-32 w-full resize-none rounded-xl border bg-gray-50 p-4 text-sm text-foreground outline-none transition-all focus:ring-2 focus:ring-primary/50"
                            placeholder="Напишите ваше сообщение здесь..."
                            disabled={status === "sending"}
                        />
                        {status === "error" && (
                            <div className="rounded-xl border border-destructive/20 bg-destructive/10 p-4 text-sm text-destructive">
                                {error}
                            </div>
                        )}
                        <div className="flex gap-4">
                            <Button
                                onClick={handleSend}
                                disabled={status === "sending" || !message.trim()}
                                className="flex-1 gap-2 py-6 text-base"
                            >
                                <Send size={18} /> Отправить
                            </Button>
                            <Button variant="outline" onClick={onClose} className="py-6 px-8 text-base">
                                Отмена
                            </Button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    )
}

// ─── Main Client ───────────────────────────────────────────────────────────

export default function CardsClient({
    initialDrivers,
    total,
    currentPage,
    initialSearch,
    initialSegment,
    initialStatus,
    initialDateRange,
    initialSortBy,
    telegramConnections = [],
    maxConnections = []
}: CardsClientProps & { telegramConnections?: any[], maxConnections?: any[] }) {
    const router = useRouter()
    const pathname = usePathname()
    const searchParams = useSearchParams()

    const [search, setSearch] = useState(initialSearch)
    const [segment, setSegment] = useState(initialSegment)
    const [status, setStatus] = useState(initialStatus)
    const [dateRange, setDateRange] = useState(initialDateRange)
    const [sortBy, setSortBy] = useState(initialSortBy)
    const [isLoading, setIsLoading] = useState(false)
    const [messageTarget, setMessageTarget] = useState<DriverCardType | null>(null)

    const pageSize = 20

    const updateFilters = (overrides: Record<string, string | number> = {}) => {
        setIsLoading(true)
        const params = new URLSearchParams(searchParams.toString())

        const newSearch = overrides.search !== undefined ? String(overrides.search) : search
        const newSegment = overrides.segment !== undefined ? String(overrides.segment) : segment
        const newStatus = overrides.status !== undefined ? String(overrides.status) : status
        const newDateRange = overrides.dateRange !== undefined ? Number(overrides.dateRange) : dateRange
        const newSortBy = overrides.sortBy !== undefined ? String(overrides.sortBy) : sortBy
        const newPage = overrides.page !== undefined ? Number(overrides.page) : undefined

        if (newSearch) params.set("search", newSearch)
        else params.delete("search")

        if (newSegment && newSegment !== "all") params.set("segment", newSegment)
        else params.delete("segment")

        if (newStatus && newStatus !== "all") params.set("status", newStatus)
        else params.delete("status")

        if (newDateRange !== 14) params.set("dateRange", String(newDateRange))
        else params.delete("dateRange")

        if (newSortBy !== "score") params.set("sortBy", newSortBy)
        else params.delete("sortBy")

        if (newPage !== undefined) params.set("page", String(newPage))
        else params.set("page", "1")

        router.push(`${pathname}?${params.toString()}`)
    }

    useEffect(() => {
        setIsLoading(false)
    }, [initialDrivers])

    return (
        <div className="flex flex-col gap-6 animate-in fade-in duration-500">
            {messageTarget && (
                <SendMessageModal
                    driver={messageTarget}
                    telegramConnections={telegramConnections}
                    maxConnections={maxConnections}
                    onClose={() => setMessageTarget(null)}
                />
            )}

            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-foreground">Карточки водителей</h1>
                    <p className="text-sm text-muted-foreground mt-0.5">
                        {total} водителей • Отсортированы по скорингу
                    </p>
                </div>
            </div>

            {/* Filters */}
            <div className="flex flex-col gap-4 rounded-xl border bg-card p-4 shadow-sm md:flex-row md:items-end">
                <form
                    onSubmit={(e) => { e.preventDefault(); updateFilters() }}
                    className="flex w-full flex-col gap-4 md:flex-row"
                >
                    <div className="flex-1">
                        <label className="mb-2 block text-xs font-medium text-muted-foreground uppercase">
                            Поиск по ФИО
                        </label>
                        <Input
                            placeholder="Введите имя..."
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            className="h-10 bg-secondary/50"
                        />
                    </div>

                    <div className="w-full md:w-36">
                        <label className="mb-2 block text-xs font-medium text-muted-foreground uppercase">
                            Сегмент
                        </label>
                        <select
                            value={segment}
                            onChange={(e) => { setSegment(e.target.value); updateFilters({ segment: e.target.value }) }}
                            className="flex h-10 w-full rounded-md border border-input bg-secondary/50 px-3 py-2 text-sm"
                        >
                            <option value="all">Все</option>
                            <option value="profitable">Прибыльный</option>
                            <option value="medium">Средний</option>
                            <option value="small">Малый</option>
                            <option value="sleeping">Спящий</option>
                        </select>
                    </div>

                    <div className="w-full md:w-36">
                        <label className="mb-2 block text-xs font-medium text-muted-foreground uppercase">
                            Статус
                        </label>
                        <select
                            value={status}
                            onChange={(e) => { setStatus(e.target.value); updateFilters({ status: e.target.value }) }}
                            className="flex h-10 w-full rounded-md border border-input bg-secondary/50 px-3 py-2 text-sm"
                        >
                            <option value="all">Все</option>
                            <option value="active">Активный</option>
                            <option value="risk">Риск ухода</option>
                            <option value="gone">Ушёл</option>
                        </select>
                    </div>

                    <div className="w-full md:w-28">
                        <label className="mb-2 block text-xs font-medium text-muted-foreground uppercase">
                            Период
                        </label>
                        <select
                            value={dateRange}
                            onChange={(e) => { setDateRange(Number(e.target.value)); updateFilters({ dateRange: Number(e.target.value) }) }}
                            className="flex h-10 w-full rounded-md border border-input bg-secondary/50 px-3 py-2 text-sm"
                        >
                            <option value={7}>7 дн</option>
                            <option value={14}>14 дн</option>
                            <option value={30}>30 дн</option>
                        </select>
                    </div>

                    <div className="w-full md:w-36">
                        <label className="mb-2 block text-xs font-medium text-muted-foreground uppercase">
                            Сортировка
                        </label>
                        <select
                            value={sortBy}
                            onChange={(e) => { setSortBy(e.target.value); updateFilters({ sortBy: e.target.value }) }}
                            className="flex h-10 w-full rounded-md border border-input bg-secondary/50 px-3 py-2 text-sm"
                        >
                            <option value="score">По скорингу ↓</option>
                            <option value="name">По имени</option>
                        </select>
                    </div>

                    <Button type="submit" className="h-10 px-6 self-end" disabled={isLoading}>
                        <Search className="mr-2 h-4 w-4" /> Найти
                    </Button>
                </form>
            </div>

            {/* Cards Grid */}
            <DriverCardGrid
                drivers={initialDrivers}
                total={total}
                page={currentPage}
                pageSize={pageSize}
                onPageChange={(p) => updateFilters({ page: p })}
                onMessage={(d) => setMessageTarget(d)}
            />
        </div>
    )
}
