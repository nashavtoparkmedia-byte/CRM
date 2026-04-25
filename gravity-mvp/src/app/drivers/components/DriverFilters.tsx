"use client"

import { Search, Calendar, RefreshCw } from "lucide-react"
import { useState, useEffect, useRef } from "react"
import { CustomDateRangePicker } from "./CustomDateRangePicker"

interface DriverFiltersProps {
    search: string
    segment: string
    status: string
    dateRange: number
    fromDate?: string
    toDate?: string
    pageSize: number
    onSearchChange: (value: string) => void
    onSegmentChange: (value: string) => void
    onStatusChange: (value: string) => void
    onDateRangeChange: (value: number) => void
    onPageSizeChange: (value: number) => void
    onCustomDateChange?: (from: string, to: string) => void
    onSubmit: () => void
    isLoading: boolean
    excludeGone?: boolean
    excludeInactive?: boolean
    onExcludeInactiveChange?: (value: boolean) => void
    segmentCounts?: {
        profitable: number
        medium: number
        small: number
        dropped: number
    }
}

const SELECT_CLASS = "h-[32px] rounded-lg bg-[#F4F5F7] hover:bg-[#EBEDF0] px-3 text-[13px] font-medium text-[#111] focus:outline-none focus:ring-2 focus:ring-[#3390EC]/40 cursor-pointer border-0 transition-colors"

export function DriverFilters({
    search,
    segment,
    status,
    dateRange,
    fromDate,
    toDate,
    pageSize,
    onSearchChange,
    onSegmentChange,
    onStatusChange,
    onDateRangeChange,
    onPageSizeChange,
    onCustomDateChange,
    onSubmit,
    isLoading,
    excludeInactive,
    onExcludeInactiveChange,
    segmentCounts,
}: DriverFiltersProps) {
    const [isPickerOpen, setIsPickerOpen] = useState(false)
    const pickerRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        function handleClickOutside(event: MouseEvent) {
            if (pickerRef.current && !pickerRef.current.contains(event.target as Node)) {
                setIsPickerOpen(false)
            }
        }
        document.addEventListener("mousedown", handleClickOutside)
        return () => document.removeEventListener("mousedown", handleClickOutside)
    }, [])

    const formatDateRange = (fromStr?: string, toStr?: string) => {
        if (!fromStr || !toStr) return "Выбрать даты"

        const parseDateSafe = (s: string) => {
            const [y, m, d] = s.split('-').map(Number)
            return new Date(y, m - 1, d)
        }

        const fromDate = parseDateSafe(fromStr)
        const toDate = parseDateSafe(toStr)

        const options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }

        if (fromDate.getMonth() === toDate.getMonth()) {
            const month = fromDate.toLocaleDateString('ru-RU', { month: 'short' }).replace('.', '')
            return `${fromDate.getDate()}–${toDate.getDate()} ${month}.`
        }

        const startFormatted = fromDate.toLocaleDateString('ru-RU', options).replace('.', '')
        const endFormatted = toDate.toLocaleDateString('ru-RU', options).replace('.', '')
        return `${startFormatted} – ${endFormatted}`
    }

    const hasCustomRange = dateRange === -1 || (fromDate && toDate)

    return (
        <div className="flex flex-col border-b border-[#E8E8E8] bg-white px-3 py-2">
            <div className="flex w-full items-center gap-2 flex-wrap">
                {/* Search */}
                <div className="relative flex-1 min-w-[180px] max-w-[240px]">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-[#8A9099]" size={14} />
                    <input
                        placeholder="Поиск..."
                        value={search}
                        onChange={(e) => onSearchChange(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') onSubmit() }}
                        className="w-full h-[32px] bg-[#F4F5F7] hover:bg-[#EBEDF0] focus:bg-white rounded-lg pl-9 pr-3 text-[13px] outline-none placeholder:text-[#8A9099] font-medium text-[#111] transition-colors focus:ring-2 focus:ring-[#3390EC]/40 border-0"
                    />
                </div>

                {/* Segment */}
                <select
                    value={segment}
                    onChange={(e) => onSegmentChange(e.target.value)}
                    className={SELECT_CLASS}
                >
                    <option value="all">Все ({ (segmentCounts?.profitable || 0) + (segmentCounts?.medium || 0) + (segmentCounts?.small || 0) + (segmentCounts?.dropped || 0) })</option>
                    <option value="profitable">Прибыльные ({segmentCounts?.profitable || 0})</option>
                    <option value="medium">Средние ({segmentCounts?.medium || 0})</option>
                    <option value="small">Малые ({segmentCounts?.small || 0})</option>
                    <option value="dropped">Выпал ({segmentCounts?.dropped || 0})</option>
                </select>

                {/* Status */}
                <select
                    value={status}
                    onChange={(e) => onStatusChange(e.target.value)}
                    className={SELECT_CLASS}
                >
                    <option value="all">Все статусы</option>
                    <option value="active">Активные</option>
                    <option value="risk">Риск</option>
                    <option value="gone">Ушли</option>
                </select>

                {/* Period */}
                <div className="relative flex items-center gap-1.5" ref={pickerRef}>
                    <select
                        value={dateRange === -1 ? -1 : dateRange}
                        onChange={(e) => {
                            const val = Number(e.target.value)
                            if (val !== -1) {
                                setIsPickerOpen(false)
                                onDateRangeChange(val)
                            } else {
                                setIsPickerOpen(true)
                            }
                        }}
                        className={SELECT_CLASS}
                    >
                        <option value={7}>7 дней</option>
                        <option value={14}>14 дней</option>
                        <option value={30}>30 дней</option>
                        <option value={45}>45 дней</option>
                        <option value={-1}>Свой период</option>
                    </select>

                    <button
                        type="button"
                        onClick={() => setIsPickerOpen(!isPickerOpen)}
                        className={cn_btn(hasCustomRange)}
                    >
                        <Calendar size={14} />
                        <span className="whitespace-nowrap">
                            {fromDate && toDate ? formatDateRange(fromDate, toDate) : "Выбрать даты"}
                        </span>
                        {hasCustomRange && <RefreshCw size={12} className="opacity-50" />}
                    </button>

                    {isPickerOpen && (
                        <CustomDateRangePicker
                            from={fromDate}
                            to={toDate}
                            onSelect={(from, to) => onCustomDateChange?.(from, to)}
                            onClose={() => setIsPickerOpen(false)}
                            maxDays={45}
                        />
                    )}
                </div>

                {/* Page Size */}
                <div className="flex items-center gap-2 ml-auto">
                    <span className="text-[11px] font-semibold text-[#8A9099] whitespace-nowrap">Показывать:</span>
                    <select
                        value={pageSize}
                        onChange={(e) => onPageSizeChange(Number(e.target.value))}
                        className={SELECT_CLASS}
                    >
                        <option value={50}>50</option>
                        <option value={100}>100</option>
                        <option value={150}>150</option>
                        <option value={200}>200</option>
                        <option value={-1}>Все</option>
                    </select>
                </div>

                <button
                    onClick={onSubmit}
                    disabled={isLoading}
                    className="h-[32px] w-[32px] p-0 rounded-lg bg-[#3390EC] text-white hover:bg-[#2B7FD0] disabled:opacity-50 flex items-center justify-center transition-colors"
                    title="Обновить"
                >
                    {isLoading ? (
                        <svg xmlns="http://www.w3.org/2000/svg" width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="animate-spin">
                            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                        </svg>
                    ) : (
                        <Search size={14} />
                    )}
                </button>

                {/* Exclude Inactive Toggle */}
                <label className="flex items-center gap-2 cursor-pointer select-none h-[32px] px-2 rounded-lg hover:bg-[#F4F5F7] transition-colors">
                    <input
                        type="checkbox"
                        checked={excludeInactive}
                        onChange={(e) => onExcludeInactiveChange?.(e.target.checked)}
                        className="w-[14px] h-[14px] rounded border-[#B0B5BA] text-[#3390EC] focus:ring-[#3390EC]/40 accent-[#3390EC]"
                    />
                    <span className="text-[12px] font-medium text-[#8A9099] whitespace-nowrap">
                        Только активные
                    </span>
                </label>
            </div>
        </div>
    )
}

function cn_btn(active: boolean) {
    return [
        "flex h-[32px] items-center gap-2 px-3 rounded-lg text-[13px] font-medium transition-colors",
        active
            ? "bg-[#3390EC]/10 text-[#3390EC] hover:bg-[#3390EC]/15"
            : "bg-[#F4F5F7] hover:bg-[#EBEDF0] text-[#8A9099]",
    ].join(" ")
}
