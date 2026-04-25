"use client"

import { useState, useEffect, useMemo } from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import {
    ChevronLeft,
    ChevronRight,
    Users,
    Send,
    MessageSquare,
    X,
    Phone,
    LayoutDashboard,
    Settings2,
    Clock,
    TrendingUp,
} from "lucide-react"
import { SegmentCards } from "./components/SegmentCards"
import { SegmentationSettings } from "./components/SegmentationSettings"
import { sendMaxMessage } from "../max-actions"
import { sendTelegramMessage } from "../tg-actions"
import { logManagerCall } from "./actions"
import type { DriverWithCells } from "./actions"

import { cn } from "@/lib/utils"

import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table"

import { ActivityGrid } from "./components/ActivityGrid"
import { ScoringDot } from "./components/ScoringDot"
import { DriverFilters } from "./components/DriverFilters"
import { YandexSyncControl } from "./components/YandexSyncControl"

// ─── Props ─────────────────────────────────────────────────────────────────

interface DriversClientProps {
    initialDrivers: DriverWithCells[]
    total: number
    currentPage: number
    segmentCounts: {
        profitable: number
        medium: number
        small: number
        dropped: number
        inactive: number
        unknown: number
    }
    initialSearch: string
    initialSegment: string
    initialStatus: string
    initialDateRange: number
    fromDate?: string
    toDate?: string
    initialPageSize: number
    initialExcludeInactive?: boolean
    telegramConnections?: any[]
    maxConnections?: any[]
}

// ─── Send Message Modal ────────────────────────────────────────────────────

function SendMessageModal({
    driver,
    telegramConnections,
    maxConnections,
    initialChannel = "telegram",
    onClose,
}: {
    driver: DriverWithCells
    telegramConnections: any[]
    maxConnections: any[]
    initialChannel?: "telegram" | "max"
    onClose: () => void
}) {
    const [channel, setChannel] = useState<"telegram" | "max">(initialChannel)
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
        const phone = driver.phone
        if (!phone) {
            setError("Нет номера телефона")
            setStatus("error")
            return
        }

        setStatus("sending")
        try {
            if (channel === "telegram") {
                await sendTelegramMessage(phone, message, selectedConnection)
            } else {
                await sendMaxMessage(phone, message, { 
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 animate-in fade-in duration-200">
            <div className="relative w-full max-w-md rounded-xl bg-white p-6 shadow-xl animate-in zoom-in-95 duration-200">
                <button
                    onClick={onClose}
                    className="absolute right-4 top-4 w-8 h-8 rounded-lg text-[#8A9099] hover:bg-[#F0F2F5] hover:text-[#111] flex items-center justify-center transition-colors"
                >
                    <X size={18} />
                </button>

                <h2 className="mb-1 flex items-center gap-2 text-[17px] font-semibold text-[#111]">
                    <MessageSquare size={18} className="text-[#3390EC]" />
                    Сообщение {driver.fullName.split(' ')[0]}
                </h2>
                <div className="mb-5 text-[12px] font-medium text-[#8A9099]">
                    Кому: <span className="text-[#111]">{driver.phone || "—"}</span>
                </div>

                {status === "success" ? (
                    <div className="py-10 text-center animate-in zoom-in">
                        <div className="w-12 h-12 rounded-full bg-emerald-50 text-emerald-500 flex items-center justify-center mx-auto mb-3">
                            <svg xmlns="http://www.w3.org/2000/svg" width={24} height={24} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="20 6 9 17 4 12" />
                            </svg>
                        </div>
                        <p className="text-[15px] font-semibold text-[#111]">Сообщение отправлено</p>
                    </div>
                ) : (
                    <div className="space-y-4">
                        <div className="flex gap-1 p-1 bg-[#F4F5F7] rounded-lg">
                            <button
                                onClick={() => setChannel("telegram")}
                                className={`flex-1 h-8 text-[13px] font-semibold rounded-md transition-colors ${channel === "telegram" ? "bg-white text-[#3390EC] shadow-[0_1px_2px_rgba(0,0,0,0.06)]" : "text-[#8A9099] hover:text-[#111]"}`}
                            >
                                Telegram
                            </button>
                            <button
                                onClick={() => setChannel("max")}
                                className={`flex-1 h-8 text-[13px] font-semibold rounded-md transition-colors ${channel === "max" ? "bg-white text-[#3390EC] shadow-[0_1px_2px_rgba(0,0,0,0.06)]" : "text-[#8A9099] hover:text-[#111]"}`}
                            >
                                MAX
                            </button>
                        </div>

                        {activeConnections.length > 0 ? (
                            <div>
                                <label className="mb-1.5 block text-[12px] font-semibold text-[#8A9099]">
                                    Аккаунт
                                </label>
                                <select
                                    value={selectedConnection}
                                    onChange={(e) => setSelectedConnection(e.target.value)}
                                    className="w-full h-[36px] rounded-lg bg-[#F4F5F7] px-3 text-[13px] font-medium text-[#111] outline-none focus:ring-2 focus:ring-[#3390EC]/40 border-0"
                                    disabled={status === "sending"}
                                >
                                    {activeConnections.map((c: any) => (
                                        <option key={c.id} value={c.id}>
                                            {c.name || 'Аккаунт без имени'} {c.phoneNumber ? `(${c.phoneNumber})` : ''} {c.isDefault ? '— Основной' : ''}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        ) : (
                            <div className="p-3 text-[12px] font-medium text-amber-700 bg-amber-50 rounded-lg">
                                Нет активных подключений для {channel === "telegram" ? "Telegram" : "MAX"}. Перейдите в настройки мессенджера.
                            </div>
                        )}

                        <div>
                            <label className="mb-1.5 block text-[12px] font-semibold text-[#8A9099]">
                                Сообщение
                            </label>
                            <textarea
                                value={message}
                                onChange={(e) => setMessage(e.target.value)}
                                className="h-28 w-full resize-none rounded-lg bg-[#F4F5F7] p-3 text-[13px] text-[#111] outline-none focus:ring-2 focus:ring-[#3390EC]/40 placeholder:text-[#8A9099] border-0"
                                placeholder="Напишите сообщение..."
                                disabled={status === "sending"}
                            />
                        </div>

                        {status === "error" && (
                            <div className="rounded-lg bg-red-50 p-3 text-[12px] font-medium text-red-600">
                                {error}
                            </div>
                        )}

                        <div className="flex gap-2 pt-1">
                            <button
                                onClick={onClose}
                                className="flex-1 h-[40px] rounded-lg bg-[#F4F5F7] hover:bg-[#EBEDF0] text-[13px] font-semibold text-[#111] transition-colors"
                            >
                                Отмена
                            </button>
                            <button
                                onClick={handleSend}
                                disabled={status === "sending" || !message.trim()}
                                className="flex-1 h-[40px] rounded-lg bg-[#3390EC] hover:bg-[#2B7FD0] disabled:opacity-50 disabled:cursor-not-allowed text-white text-[13px] font-semibold flex items-center justify-center gap-2 transition-colors"
                            >
                                {status === "sending" ? (
                                    <Spinner />
                                ) : (
                                    <>
                                        <Send size={14} /> Отправить
                                    </>
                                )}
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    )
}

function Spinner() {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="animate-spin">
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
        </svg>
    )
}

// ─── Main Component ────────────────────────────────────────────────────────

export default function DriversClient({
    initialDrivers,
    total,
    segmentCounts,
    initialSearch,
    initialSegment,
    initialStatus,
    initialDateRange,
    fromDate: initialFrom,
    toDate: initialTo,
    initialPageSize,
    initialExcludeInactive = false,
    currentPage: initialCurrentPage,
    telegramConnections = [],
    maxConnections = []
}: DriversClientProps) {
    const router = useRouter()
    const pathname = usePathname()
    const searchParams = useSearchParams()

    const [search, setSearch] = useState(initialSearch)
    const [segment, setSegment] = useState(initialSegment)
    const [status, setStatus] = useState(initialStatus)
    const [dateRange, setDateRange] = useState(initialDateRange)
    const [fromDate, setFromDate] = useState(initialFrom || "")
    const [toDate, setToDate] = useState(initialTo || "")
    const [pageSize, setPageSize] = useState(initialPageSize)
    const [excludeInactive, setExcludeInactive] = useState(initialExcludeInactive)
    const [isLoading, setIsLoading] = useState(false)
    const [messageTarget, setMessageTarget] = useState<{ driver: DriverWithCells, channel: "telegram" | "max" } | null>(null)
    const [isSegmentationOpen, setIsSegmentationOpen] = useState(false)
    const [currentPage, setCurrentPage] = useState(initialCurrentPage)

    // Sync state with props when navigation occurs
    useEffect(() => {
        setSearch(initialSearch)
        setSegment(initialSegment)
        setStatus(initialStatus)
        setDateRange(initialDateRange)
        setFromDate(initialFrom || "")
        setToDate(initialTo || "")
        setPageSize(initialPageSize)
        setExcludeInactive(initialExcludeInactive)
        setCurrentPage(initialCurrentPage)
    }, [
        initialSearch, 
        initialSegment, 
        initialStatus, 
        initialDateRange, 
        initialFrom, 
        initialTo, 
        initialPageSize, 
        initialExcludeInactive,
        initialCurrentPage
    ])

    const formatRelativeTime = (date: Date | null) => {
        if (!date) return 'Никогда'
        const now = new Date()
        const diffInMs = now.getTime() - date.getTime()
        const diffInHours = Math.floor(diffInMs / (1000 * 60 * 60))
        const diffInDays = Math.floor(diffInHours / 24)

        if (diffInHours < 1) return 'Меньше часа назад'
        if (diffInHours < 24) {
            const lastDigit = diffInHours % 10
            const lastTwoDigits = diffInHours % 100
            if (lastTwoDigits >= 11 && lastTwoDigits <= 14) return `${diffInHours} часов назад`
            if (lastDigit === 1) return `${diffInHours} час назад`
            if (lastDigit >= 2 && lastDigit <= 4) return `${diffInHours} часа назад`
            return `${diffInHours} часов назад`
        }
        
        const lastDigitDays = diffInDays % 10
        const lastTwoDigitsDays = diffInDays % 100
        if (lastTwoDigitsDays >= 11 && lastTwoDigitsDays <= 14) return `${diffInDays} дней назад`
        if (lastDigitDays === 1) return `${diffInDays} день назад`
        if (lastDigitDays >= 2 && lastDigitDays <= 4) return `${diffInDays} дня назад`
        return `${diffInDays} дней назад`
    }

    const pluralizeTrips = (n: number) => {
        const lastDigit = n % 10
        const lastTwoDigits = n % 100
        if (lastTwoDigits >= 11 && lastTwoDigits <= 14) return 'поездок'
        if (lastDigit === 1) return 'поездка'
        if (lastDigit >= 2 && lastDigit <= 4) return 'поездки'
        return 'поездок'
    }

    const getSegmentLabel = (segment: string) => {
        switch (segment) {
            case 'profitable': return { label: 'Прибыльный', color: 'bg-green-500', icon: '🟢' }
            case 'medium': return { label: 'Средний', color: 'bg-blue-500', icon: '🔵' }
            case 'small': return { label: 'Малый', color: 'bg-gray-400', icon: '⚪' }
            case 'dropped': return { label: 'Выпал', color: 'bg-red-500', icon: '⚫' }
            default: return { label: 'Неизвестно', color: 'bg-gray-200', icon: '⚪' }
        }
    }

    const totalPages = pageSize === -1 ? 1 : Math.ceil(total / pageSize)

    const updateFilters = (overrides: Record<string, string | number> = {}) => {
        setIsLoading(true)
        const params = new URLSearchParams(searchParams.toString())

        const newSearch = overrides.search !== undefined ? String(overrides.search) : search
        const newSegment = overrides.segment !== undefined ? String(overrides.segment) : segment
        const newStatus = overrides.status !== undefined ? String(overrides.status) : status
        const newDateRange = overrides.dateRange !== undefined ? Number(overrides.dateRange) : dateRange
        const newFrom = overrides.from !== undefined ? String(overrides.from) : fromDate
        const newTo = overrides.to !== undefined ? String(overrides.to) : toDate
        const newExcludeInactive = overrides.excludeInactive !== undefined ? Boolean(overrides.excludeInactive) : excludeInactive
        const newPage = overrides.page !== undefined ? Number(overrides.page) : undefined

        if (newSearch) params.set("search", newSearch)
        else params.delete("search")

        if (newSegment && newSegment !== "all") params.set("segment", newSegment)
        else params.delete("segment")

        if (newStatus && newStatus !== "all") params.set("status", newStatus)
        else params.delete("status")

        if (newDateRange !== 14 && newDateRange !== -1) params.set("dateRange", String(newDateRange))
        else params.delete("dateRange")

        if (overrides.pageSize !== undefined) {
            params.set("pageSize", String(overrides.pageSize))
            params.set("page", "1")
        } else if (pageSize !== 50) {
            params.set("pageSize", String(pageSize))
        }

        if (newPage !== undefined) params.set("page", String(newPage))
        else params.set("page", "1")

        router.push(`${pathname}?${params.toString()}`)
    }

    const allDates = useMemo(() => {
        const dates: string[] = []
        const today = new Date()
        today.setHours(0, 0, 0, 0)

        let start: Date
        let end: Date

        if (fromDate && toDate) {
            const [fsY, fsM, fsD] = fromDate.split('-').map(Number)
            start = new Date(fsY, fsM - 1, fsD)
            const [tsY, tsM, tsD] = toDate.split('-').map(Number)
            end = new Date(tsY, tsM - 1, tsD)
        } else {
            const range = dateRange || 14
            start = new Date(today)
            start.setDate(today.getDate() - range + 1)
            end = today
        }

        const currentIter = new Date(start)
        while (currentIter <= end) {
            const y = currentIter.getFullYear()
            const m = String(currentIter.getMonth() + 1).padStart(2, '0')
            const d = String(currentIter.getDate()).padStart(2, '0')
            dates.push(`${y}-${m}-${d}`)
            currentIter.setDate(currentIter.getDate() + 1)
        }
        return dates
    }, [fromDate, toDate, dateRange])

    useEffect(() => {
        setIsLoading(false)
    }, [initialDrivers])

    const handleCallClick = async (driver: DriverWithCells, e: React.MouseEvent) => {
        e.stopPropagation()
        await logManagerCall(driver.id)
    }

    return (
        <div className="flex w-full flex-col gap-4 animate-in fade-in duration-300">
            {messageTarget && (
                <SendMessageModal
                    driver={messageTarget.driver}
                    initialChannel={messageTarget.channel}
                    telegramConnections={telegramConnections}
                    maxConnections={maxConnections}
                    onClose={() => setMessageTarget(null)}
                />
            )}

            {/* Main Header */}
            <div className="flex items-center justify-between flex-wrap gap-3">
                <h1 className="text-[22px] font-semibold text-[#111] tracking-tight flex items-center gap-2.5">
                    Водители
                    <span className="text-[12px] font-semibold bg-[#F0F2F5] text-[#8A9099] px-2 py-0.5 rounded-full">{total}</span>
                </h1>
                <div className="flex items-center gap-2 flex-wrap">
                    <YandexSyncControl />
                    <button
                        onClick={() => setIsSegmentationOpen(true)}
                        className="h-[36px] px-3 rounded-lg bg-[#F4F5F7] hover:bg-[#EBEDF0] text-[13px] font-semibold text-[#111] flex items-center gap-2 transition-colors"
                    >
                        <Settings2 size={14} className="text-[#8A9099]" />
                        Настройка
                    </button>
                    <button
                        onClick={() => router.push('/drivers/stats')}
                        className="h-[36px] px-4 rounded-lg bg-[#3390EC] hover:bg-[#2B7FD0] text-white text-[13px] font-semibold flex items-center gap-2 transition-colors"
                    >
                        <TrendingUp size={14} />
                        Статистика
                    </button>
                </div>
            </div>

            <SegmentCards
                counts={segmentCounts}
                activeSegment={segment || 'all'}
                onSegmentClick={(seg) => {
                    setSegment(seg)
                    updateFilters({ segment: seg, page: 1 })
                }}
            />

            {/* Table with Filters */}
            <div className="flex flex-col rounded-xl border border-[#E8E8E8] bg-white overflow-hidden">
                <DriverFilters
                    search={search}
                    segment={segment}
                    status={status}
                    dateRange={dateRange}
                    fromDate={fromDate}
                    toDate={toDate}
                    onSearchChange={setSearch}
                    onSegmentChange={(v: string) => { setSegment(v); updateFilters({ segment: v }) }}
                    onStatusChange={(v: string) => { setStatus(v); updateFilters({ status: v }) }}
                    onDateRangeChange={(v: number) => { 
                        setDateRange(v); 
                        if (v !== -1) {
                            const to = new Date()
                            const from = new Date()
                            from.setDate(to.getDate() - v + 1)
                            
                            const formatDateStr = (d: Date) => {
                                const y = d.getFullYear()
                                const m = String(d.getMonth() + 1).padStart(2, '0')
                                const day = String(d.getDate()).padStart(2, '0')
                                return `${y}-${m}-${day}`
                            }

                            const fromStr = formatDateStr(from)
                            const toStr = formatDateStr(to)
                            
                            setFromDate(fromStr)
                            setToDate(toStr)
                            updateFilters({ dateRange: v, from: fromStr, to: toStr }) 
                        }
                    }}
                    onCustomDateChange={(from: string, to: string) => {
                        setFromDate(from)
                        setToDate(to)
                        updateFilters({ from, to, dateRange: -1 })
                    }}
                    onSubmit={() => updateFilters()}
                    isLoading={isLoading}
                    excludeGone={true}
                    excludeInactive={excludeInactive}
                    onExcludeInactiveChange={(v) => {
                        setExcludeInactive(v)
                        updateFilters({ excludeInactive: v as any })
                    }}
                    pageSize={pageSize}
                    onPageSizeChange={(v: number) => {
                        setPageSize(v)
                        updateFilters({ pageSize: v, page: 1 })
                    }}
                    segmentCounts={segmentCounts}
                />


                <Table wrapperClassName="!overflow-visible">
                    <TableHeader>
                        <TableRow className="bg-[#FAFAFA] hover:bg-[#FAFAFA] border-b border-[#E8E8E8]">
                            <TableHead className="py-2 px-3 text-[11px] font-semibold uppercase tracking-wider text-[#8A9099] bg-[#FAFAFA] sticky top-[64px] z-30 w-[220px]">Водитель</TableHead>
                            <TableHead className="py-2 px-3 text-[11px] font-semibold uppercase tracking-wider text-[#8A9099] bg-[#FAFAFA] sticky top-[64px] z-30 w-[130px]">Телефон</TableHead>
                            <TableHead className="py-2 px-3 text-[11px] font-semibold uppercase tracking-wider text-[#8A9099] bg-[#FAFAFA] sticky top-[64px] z-30 w-[120px]">Сегмент</TableHead>
                            <TableHead className="py-2 px-3 text-[11px] font-semibold uppercase tracking-wider text-[#8A9099] bg-[#FAFAFA] sticky top-[64px] z-30 w-[140px]">Посл. поездка</TableHead>
                            <TableHead className="py-2 px-3 text-[11px] font-semibold uppercase tracking-wider text-[#8A9099] bg-[#FAFAFA] sticky top-[64px] z-30 w-[90px] text-center">Поездки</TableHead>
                            <TableHead className="py-2 px-3 text-[11px] font-semibold uppercase tracking-wider text-[#8A9099] bg-[#FAFAFA] sticky top-[64px] z-30 min-w-[120px]">
                                <div className="flex flex-col gap-1 text-left">
                                    <span className="leading-none">Активность</span>
                                    <div className="flex gap-[1px]">
                                        {allDates.map((dateStr: string) => {
                                            const parts = dateStr.split('-').map(Number)
                                            const d = new Date(parts[0], parts[1] - 1, parts[2]);
                                            const day = d.getDate();
                                            const isWeekend = d.getDay() === 0 || d.getDay() === 6;
                                            return (
                                                <div
                                                    key={dateStr}
                                                    className={cn(
                                                        "w-3 flex-shrink-0 text-center text-[8px] font-semibold leading-none normal-case tracking-normal",
                                                        isWeekend ? 'text-[#F06A6A]' : 'text-[#B0B5BA]'
                                                    )}
                                                >
                                                    {day}
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            </TableHead>
                            <TableHead className="py-2 px-3 text-[11px] font-semibold uppercase tracking-wider text-[#8A9099] bg-[#FAFAFA] sticky top-[64px] z-30 w-[70px] text-right">Действия</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {isLoading ? (
                            <TableRow>
                                <TableCell colSpan={7} className="h-24 text-center text-[#8A9099]">
                                    <Spinner />
                                </TableCell>
                            </TableRow>
                        ) : initialDrivers.length === 0 ? (
                            <TableRow>
                                <TableCell colSpan={7} className="h-32 text-center">
                                    <div className="flex flex-col items-center gap-2 text-[#8A9099]">
                                        <Users size={24} className="opacity-30" />
                                        <span className="text-[13px] font-medium">Водители не найдены</span>
                                    </div>
                                </TableCell>
                            </TableRow>
                        ) : (
                            initialDrivers.map((driver) => (
                                <TableRow
                                    key={driver.id}
                                    className="group cursor-pointer hover:bg-[#F7F9FB] transition-colors border-b border-[#F0F2F5] last:border-0"
                                    onClick={() => router.push(`/drivers/${driver.id}`)}
                                >
                                    {/* Driver name */}
                                    <TableCell className="py-2 px-3 align-middle w-[220px]">
                                        <div className="flex items-center gap-2.5 min-w-0">
                                            <ScoringDot status={driver.computedStatus} />
                                            <span className="text-[13px] font-semibold text-[#111] truncate select-all">
                                                {driver.fullName}
                                            </span>
                                        </div>
                                    </TableCell>

                                    {/* Phone column */}
                                    <TableCell className="py-2 px-3 align-middle w-[130px]">
                                        <span className="text-[12px] font-medium text-[#8A9099] whitespace-nowrap">
                                            {driver.phone || "—"}
                                        </span>
                                    </TableCell>

                                    {/* Segment badge */}
                                    <TableCell className="py-2 px-3 align-middle w-[120px]">
                                        <div className="flex items-center gap-1.5 bg-[#F0F2F5] rounded-md px-2 py-1 w-fit whitespace-nowrap">
                                            <span className="text-[9px]">{getSegmentLabel(driver.segment).icon}</span>
                                            <span className="text-[10px] font-semibold text-[#8A9099] tracking-tight">
                                                {getSegmentLabel(driver.segment).label}
                                            </span>
                                        </div>
                                    </TableCell>

                                    {/* Last Trip */}
                                    <TableCell className="py-2 px-3 align-middle w-[140px]">
                                        <div className="flex items-center gap-1.5 text-[12px] font-medium text-[#8A9099] whitespace-nowrap">
                                            <Clock size={11} className="text-[#B0B5BA]" />
                                            {formatRelativeTime(driver.lastOrderAt)}
                                        </div>
                                    </TableCell>

                                    {/* Trips */}
                                    <TableCell className="py-2 px-3 align-middle text-center w-[90px]">
                                        <div className="flex items-center justify-center gap-1.5">
                                            <span className="text-[13px] font-semibold text-[#111]">
                                                {driver.periodTrips}
                                            </span>
                                            <span className="text-[#B0B5BA] text-[11px]">/</span>
                                            <span className="text-[12px] font-medium text-[#8A9099]">
                                                {driver.filteredTrips}
                                            </span>
                                        </div>
                                    </TableCell>

                                    {/* Activity cells */}
                                    <TableCell className="py-2 px-3 align-middle">
                                        <ActivityGrid cells={driver.cells} />
                                    </TableCell>

                                    {/* Actions */}
                                    <TableCell className="py-2 px-3 align-middle text-right">
                                        <div className="relative group/actions inline-block">
                                            <button
                                                className="h-8 w-8 rounded-lg hover:bg-[#F0F2F5] flex items-center justify-center transition-colors"
                                                onClick={(e) => e.stopPropagation()}
                                            >
                                                <MessageSquare size={15} className="text-[#8A9099]" />
                                            </button>

                                            <div className="absolute right-full top-0 h-full w-2 z-50 hidden group-hover/actions:block" />
                                            <div className="absolute right-full top-0 mr-1 hidden group-hover/actions:flex flex-col bg-white border border-[#E8E8E8] rounded-xl shadow-lg z-[60] py-1.5 min-w-[170px] animate-in fade-in slide-in-from-right-2 duration-150">
                                                <button
                                                    className="flex items-center gap-2 px-3 py-2 text-[12px] font-medium text-[#111] hover:bg-[#F4F5F7] transition-colors"
                                                    onClick={(e) => {
                                                        e.stopPropagation()
                                                        setMessageTarget({ driver, channel: "telegram" })
                                                    }}
                                                >
                                                    <Send size={13} className="text-[#3390EC]" /> Telegram
                                                </button>

                                                <button
                                                    className="flex items-center gap-2 px-3 py-2 text-[12px] font-medium text-[#111] hover:bg-[#F4F5F7] transition-colors"
                                                    onClick={(e) => {
                                                        e.stopPropagation()
                                                        setMessageTarget({ driver, channel: "max" })
                                                    }}
                                                >
                                                    <MessageSquare size={13} className="text-purple-500" /> MAX
                                                </button>

                                                {driver.phone && (
                                                    <a
                                                        href={`https://wa.me/${driver.phone.replace(/\D/g, '')}`}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        className="flex items-center gap-2 px-3 py-2 text-[12px] font-medium text-[#111] hover:bg-[#F4F5F7] transition-colors"
                                                        onClick={(e) => e.stopPropagation()}
                                                    >
                                                        <MessageSquare size={13} className="text-emerald-500" /> WhatsApp
                                                    </a>
                                                )}

                                                <button
                                                    className="flex items-center gap-2 px-3 py-2 text-[12px] font-medium text-[#111] hover:bg-[#F4F5F7] transition-colors"
                                                    onClick={(e) => {
                                                        e.stopPropagation()
                                                        window.open(`https://fleet.yandex.ru/drivers/${driver.id}`, '_blank')
                                                    }}
                                                >
                                                    <LayoutDashboard size={13} className="text-amber-500" /> Яндекс Про
                                                </button>

                                                <div className="h-[1px] bg-[#F0F2F5] my-1" />
                                                <button
                                                    className="flex items-center gap-2 px-3 py-2 text-[12px] font-medium text-[#111] hover:bg-[#F4F5F7] transition-colors"
                                                    onClick={(e) => handleCallClick(driver, e)}
                                                >
                                                    <Phone size={13} className="text-[#8A9099]" /> Отметить звонок
                                                </button>
                                            </div>
                                        </div>
                                    </TableCell>
                                </TableRow>
                            ))
                        )}
                    </TableBody>
                </Table>

                {/* Pagination */}
                <div className="flex items-center justify-between border-t border-[#E8E8E8] bg-[#FAFAFA] px-4 py-2.5">
                    <div className="text-[12px] font-medium text-[#8A9099]">
                        Показаны {pageSize === -1 ? "все" : "с "}{" "}
                        {pageSize !== -1 && (
                            <>
                                <span className="font-semibold text-[#111]">
                                    {(currentPage - 1) * pageSize + 1}
                                </span>{" "}
                                по{" "}
                                <span className="font-semibold text-[#111]">
                                    {Math.min(currentPage * pageSize, total)}
                                </span>{" "}
                                из{" "}
                            </>
                        )}
                        <span className="font-semibold text-[#111]">{total}</span>
                    </div>
                    {pageSize !== -1 && totalPages > 1 && (
                        <div className="flex items-center gap-1">
                            <button
                                onClick={() => updateFilters({ page: currentPage - 1 })}
                                disabled={currentPage === 1 || isLoading}
                                className="h-[28px] px-3 rounded-lg text-[12px] font-semibold text-[#8A9099] hover:bg-[#F0F2F5] hover:text-[#111] disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[#8A9099] transition-colors flex items-center gap-1"
                            >
                                <ChevronLeft size={14} />
                                Назад
                            </button>
                            <div className="flex items-center gap-0.5">
                                {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                                    let pageNum: number;
                                    if (totalPages <= 5) pageNum = i + 1;
                                    else if (currentPage <= 3) pageNum = i + 1;
                                    else if (currentPage >= totalPages - 2) pageNum = totalPages - 4 + i;
                                    else pageNum = currentPage - 2 + i;

                                    const isActive = currentPage === pageNum
                                    return (
                                        <button
                                            key={pageNum}
                                            onClick={() => updateFilters({ page: pageNum })}
                                            className={cn(
                                                "h-[28px] min-w-[28px] px-2 rounded-lg text-[12px] font-semibold transition-colors",
                                                isActive
                                                    ? "bg-[#3390EC] text-white"
                                                    : "text-[#8A9099] hover:bg-[#F0F2F5] hover:text-[#111]"
                                            )}
                                        >
                                            {pageNum}
                                        </button>
                                    )
                                })}
                            </div>
                            <button
                                onClick={() => updateFilters({ page: currentPage + 1 })}
                                disabled={currentPage >= totalPages || isLoading}
                                className="h-[28px] px-3 rounded-lg text-[12px] font-semibold text-[#8A9099] hover:bg-[#F0F2F5] hover:text-[#111] disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[#8A9099] transition-colors flex items-center gap-1"
                            >
                                Вперёд
                                <ChevronRight size={14} />
                            </button>
                        </div>
                    )}
                </div>
            </div>

            <SegmentationSettings 
                isOpen={isSegmentationOpen} 
                onClose={() => setIsSegmentationOpen(false)} 
            />
        </div>
    )
}
