"use client"

import { useState, useEffect, useMemo } from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import {
    ChevronLeft,
    ChevronRight,
    Users,
    TrendingDown,
    AlertTriangle,
    Send,
    MessageSquare,
    X,
    Phone,
    ExternalLink,
    LayoutDashboard,
    Settings2,
    Clock,
    TrendingUp,
    Zap,
} from "lucide-react"
import { SegmentCards } from "./components/SegmentCards"
import { SegmentationSettings } from "./components/SegmentationSettings"
import { sendMaxMessage } from "../max-actions"
import { sendTelegramMessage } from "../tg-actions"
import { logManagerCall } from "./actions"
import type { DriverWithCells } from "./actions"

import { cn } from "@/lib/utils"

import { Button } from "@/components/ui/button"
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table"

import { ActivityGrid } from "./components/ActivityGrid"
import { SegmentBadge } from "./components/SegmentBadge"
import { ScoringDot } from "./components/ScoringDot"
import { DriverFilters } from "./components/DriverFilters"

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
                        <svg xmlns="http://www.w3.org/2000/svg" width={48} height={48} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mx-auto mb-4">
                            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                            <polyline points="22 4 12 14.01 9 11.01" />
                        </svg>
                        <p className="font-bold">Сообщение успешно отправлено!</p>
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
                                <label className="mb-2 ml-1 block text-sm font-medium text-muted-foreground">
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

                        <div className="relative">
                            <label className="mb-2 ml-1 block text-sm font-medium text-muted-foreground">
                                Текст сообщения
                            </label>
                            <textarea
                                value={message}
                                onChange={(e) => setMessage(e.target.value)}
                                className="h-32 w-full resize-none rounded-xl border bg-gray-50 p-4 text-sm text-foreground outline-none transition-all focus:ring-2 focus:ring-primary/50"
                                placeholder="Напишите ваше сообщение здесь..."
                                disabled={status === "sending"}
                            />
                        </div>

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
                                {status === "sending" ? (
                                    <Spinner />
                                ) : (
                                    <>
                                        <Send size={18} /> Отправить
                                    </>
                                )}
                            </Button>
                            <Button
                                variant="outline"
                                onClick={onClose}
                                className="py-6 px-8 text-base"
                            >
                                Отмена
                            </Button>
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
        <div className="flex w-full flex-col gap-6 animate-in fade-in duration-500">
            <style dangerouslySetInnerHTML={{ __html: `
                .bg-\\[\\#FFD700\\] { background-color: #FFD700 !important; }
                .calendar-range-active { background-color: #FFD700 !important; }
            `}} />
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
            <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                    <h1 className="text-3xl font-black text-gray-900 flex items-center gap-3">
                        Водители
                        <span className="text-sm font-bold bg-gray-100 text-gray-400 px-3 py-1 rounded-full">{total}</span>
                    </h1>
                    <div className="flex items-center gap-2">
                        <Button 
                            variant="outline" 
                            onClick={() => setIsSegmentationOpen(true)}
                            className="rounded-2xl font-bold border-gray-100 hover:bg-gray-50 flex items-center gap-2 h-10 shadow-sm"
                        >
                            <Settings2 className="h-4 w-4" />
                            Настройка
                        </Button>
                        <Button
                            onClick={() => router.push('/drivers/stats')}
                            className="rounded-2xl font-bold bg-gray-900 text-white hover:bg-black h-10 px-6 shadow-lg shadow-gray-200"
                        >
                            <TrendingUp className="h-4 w-4 mr-2" />
                            Статистика
                        </Button>
                    </div>
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
            <div className="flex flex-col rounded-xl border bg-card shadow-sm">
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


                <Table wrapperClassName="!overflow-visible border rounded-lg bg-white shadow-sm">
                    <TableHeader className="bg-white border-b-2 border-muted/20">
                        <TableRow className="bg-white hover:bg-white border-b-0">
                            <TableHead className="py-1 px-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground bg-white sticky top-[64px] z-30 shadow-[0_1px_0_rgba(0,0,0,0.05)] w-[180px]">Водитель</TableHead>
                            <TableHead className="py-1 px-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground bg-white sticky top-[64px] z-30 shadow-[0_1px_0_rgba(0,0,0,0.05)] w-[110px]">Телефон</TableHead>
                            <TableHead className="py-1 px-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground bg-white sticky top-[64px] z-30 shadow-[0_1px_0_rgba(0,0,0,0.05)] w-[100px]">Сегмент</TableHead>
                            <TableHead className="py-1 px-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground bg-white sticky top-[64px] z-30 shadow-[0_1px_0_rgba(0,0,0,0.05)] w-[110px]">Посл. поездка</TableHead>
                            <TableHead className="py-1 px-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground bg-white sticky top-[64px] z-30 shadow-[0_1px_0_rgba(0,0,0,0.05)] w-[80px] text-center">Поездки</TableHead>
                            <TableHead className="py-1 px-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground bg-white sticky top-[64px] z-30 shadow-[0_1px_0_rgba(0,0,0,0.05)] min-w-[100px]">
                                <div className="flex flex-col gap-0 text-left">
                                    <span className="text-[9px] mb-0.5 ml-1">Активность</span>
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
                                                        "w-3 flex-shrink-0 text-center text-[7px] font-bold leading-none",
                                                        isWeekend ? 'text-red-500' : 'text-muted-foreground/30'
                                                    )}
                                                >
                                                    {day}
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            </TableHead>
                            <TableHead className="py-1 px-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground w-[60px] text-right bg-white sticky top-[64px] z-30 shadow-[0_1px_0_rgba(0,0,0,0.05)]">Действия</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {isLoading ? (
                            <TableRow>
                                <TableCell colSpan={7} className="h-24 text-center">
                                    <Spinner />
                                </TableCell>
                            </TableRow>
                        ) : initialDrivers.length === 0 ? (
                            <TableRow>
                                <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                                    Водители не найдены.
                                </TableCell>
                            </TableRow>
                        ) : (
                            initialDrivers.map((driver) => (
                                <TableRow
                                    key={driver.id}
                                    className="group cursor-pointer hover:bg-gray-50/80 transition-colors border-b last:border-0"
                                    onClick={() => router.push(`/drivers/${driver.id}`)}
                                >
                                    {/* Driver name */}
                                    <TableCell className="py-1.5 px-1.5 align-middle w-[180px]">
                                        <div className="flex items-center gap-2 min-w-0">
                                            <ScoringDot status={driver.computedStatus} />
                                            <span className="text-xs font-extrabold text-foreground truncate select-all">
                                                {driver.fullName}
                                            </span>
                                        </div>
                                    </TableCell>

                                    {/* Phone column */}
                                    <TableCell className="py-1.5 px-1.5 align-middle w-[110px]">
                                        <span className="text-[10px] font-bold text-muted-foreground whitespace-nowrap">
                                            {driver.phone || "—"}
                                        </span>
                                    </TableCell>

                                    {/* Segment badge */}
                                    <TableCell className="py-1.5 px-1.5 align-middle w-[100px]">
                                        <div className="flex items-center gap-1.5 bg-gray-50 border border-gray-100 rounded-lg px-2 py-0.5 w-fit whitespace-nowrap">
                                            <span className="text-[10px]">{getSegmentLabel(driver.segment).icon}</span>
                                            <span className="text-[9px] font-black uppercase text-gray-500 tracking-tight">
                                                {getSegmentLabel(driver.segment).label}
                                            </span>
                                        </div>
                                    </TableCell>

                                    {/* Last Trip */}
                                    <TableCell className="py-1.5 px-1.5 align-middle w-[110px]">
                                        <div className="flex items-center gap-1 text-[10px] font-bold text-gray-400 whitespace-nowrap">
                                            <Clock size={10} className="text-gray-300" />
                                            {formatRelativeTime(driver.lastOrderAt)}
                                        </div>
                                    </TableCell>

                                    {/* Trips */}
                                    <TableCell className="py-1.5 px-1.5 align-middle text-center w-[80px]">
                                        <div className="flex items-center justify-center gap-1.5">
                                            <span className="text-[11px] font-black text-foreground">
                                                {driver.periodTrips}
                                            </span>
                                            <span className="text-gray-300 text-[10px]">/</span>
                                            <span className="text-[11px] font-bold text-gray-400">
                                                {driver.filteredTrips}
                                            </span>
                                        </div>
                                    </TableCell>

                                    {/* Activity cells */}
                                    <TableCell className="py-0.5 px-1.5 align-middle">
                                        <ActivityGrid cells={driver.cells} />
                                    </TableCell>

                                    {/* Actions */}
                                    <TableCell className="py-0.5 px-1.5 align-middle text-right">
                                        <div className="relative group/actions inline-block">
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="h-8 w-8 rounded-full hover:bg-muted"
                                                onClick={(e) => e.stopPropagation()}
                                            >
                                                <MessageSquare size={16} className="text-muted-foreground" />
                                            </Button>
                                            
                                            <div className="absolute right-full top-0 h-full w-2 z-50 hidden group-hover/actions:block" />
                                            <div className="absolute right-full top-0 mr-1 hidden group-hover/actions:flex flex-col bg-white border rounded-lg shadow-xl z-[60] py-1 min-w-[140px] animate-in fade-in slide-in-from-right-2 duration-200">
                                                <button 
                                                    className="flex items-center gap-2 px-3 py-1.5 text-[11px] font-medium hover:bg-sky-50 text-sky-600 transition-colors"
                                                    onClick={(e) => {
                                                        e.stopPropagation()
                                                        setMessageTarget({ driver, channel: "telegram" })
                                                    }}
                                                >
                                                    <Send size={12} /> Telegram
                                                </button>
                                                
                                                <button 
                                                    className="flex items-center gap-2 px-3 py-1.5 text-[11px] font-medium hover:bg-indigo-50 text-indigo-600 transition-colors"
                                                    onClick={(e) => {
                                                        e.stopPropagation()
                                                        setMessageTarget({ driver, channel: "max" })
                                                    }}
                                                >
                                                    <MessageSquare size={12} /> MAX Messenger
                                                </button>
                                                
                                                {driver.phone && (
                                                    <a 
                                                        href={`https://wa.me/${driver.phone.replace(/\D/g, '')}`}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        className="flex items-center gap-2 px-3 py-1.5 text-[11px] font-medium hover:bg-green-50 text-green-600 transition-colors"
                                                        onClick={(e) => e.stopPropagation()}
                                                    >
                                                        <MessageSquare size={12} /> WhatsApp
                                                    </a>
                                                )}

                                                <button 
                                                    className="flex items-center gap-2 px-3 py-1.5 text-[11px] font-medium hover:bg-amber-50 text-amber-600 transition-colors"
                                                    onClick={(e) => {
                                                        e.stopPropagation()
                                                        window.open(`https://fleet.yandex.ru/drivers/${driver.id}`, '_blank')
                                                    }}
                                                >
                                                    <LayoutDashboard size={12} /> Яндекс Про
                                                </button>

                                                <div className="h-[1px] bg-muted my-1" />
                                                <button 
                                                    className="flex items-center gap-2 px-3 py-1.5 text-[11px] font-medium hover:bg-gray-100 text-foreground transition-colors"
                                                    onClick={(e) => handleCallClick(driver, e)}
                                                >
                                                    <Phone size={12} /> Отметить звонок
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
                <div className="flex items-center justify-between border-t bg-muted/20 px-4 py-3 sm:px-6">
                    <div className="text-sm text-muted-foreground">
                        Показаны {pageSize === -1 ? "все" : "с "}{" "}
                        {pageSize !== -1 && (
                            <>
                                <span className="font-medium text-foreground">
                                    {(currentPage - 1) * pageSize + 1}
                                </span>{" "}
                                по{" "}
                                <span className="font-medium text-foreground">
                                    {Math.min(currentPage * pageSize, total)}
                                </span>{" "}
                                из{" "}
                            </>
                        )}
                        <span className="font-medium text-foreground">{total}</span>
                    </div>
                    {pageSize !== -1 && totalPages > 1 && (
                        <div className="flex flex-1 justify-between sm:justify-end gap-2">
                            <Button
                                onClick={() => updateFilters({ page: currentPage - 1 })}
                                disabled={currentPage === 1 || isLoading}
                                variant="outline"
                                size="sm"
                                className="h-8 rounded-full px-4"
                            >
                                Назад
                            </Button>
                            <div className="flex items-center gap-1">
                                {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                                    let pageNum: number;
                                    if (totalPages <= 5) pageNum = i + 1;
                                    else if (currentPage <= 3) pageNum = i + 1;
                                    else if (currentPage >= totalPages - 2) pageNum = totalPages - 4 + i;
                                    else pageNum = currentPage - 2 + i;
                                    
                                    return (
                                        <Button
                                            key={pageNum}
                                            onClick={() => updateFilters({ page: pageNum })}
                                            variant={currentPage === pageNum ? "default" : "ghost"}
                                            size="sm"
                                            className={cn(
                                                "h-8 w-8 rounded-full p-0",
                                                currentPage === pageNum ? "bg-gray-900 text-white" : "text-muted-foreground"
                                            )}
                                        >
                                            {pageNum}
                                        </Button>
                                    )
                                })}
                            </div>
                            <Button
                                onClick={() => updateFilters({ page: currentPage + 1 })}
                                disabled={currentPage >= totalPages || isLoading}
                                variant="outline"
                                size="sm"
                                className="h-8 rounded-full px-4"
                            >
                                Вперед
                            </Button>
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
