"use client"

import { Search, Calendar, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
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
        
        // If same month, format as "2–7 мар."
        if (fromDate.getMonth() === toDate.getMonth()) {
            const month = fromDate.toLocaleDateString('ru-RU', { month: 'short' }).replace('.', '')
            return `${fromDate.getDate()}–${toDate.getDate()} ${month}.`
        }
        
        const startFormatted = fromDate.toLocaleDateString('ru-RU', options).replace('.', '')
        const endFormatted = toDate.toLocaleDateString('ru-RU', options).replace('.', '')
        return `${startFormatted} – ${endFormatted}`
    }

    return (
        <div className="flex flex-col border-b bg-white p-3">
            <div className="flex w-full items-center gap-2">
                {/* Search */}
                <div className="relative flex-1 max-w-[200px]">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
                    <Input
                        placeholder="Поиск..."
                        value={search}
                        onChange={(e) => onSearchChange(e.target.value)}
                        className="h-9 w-full rounded-full bg-gray-100/80 border-transparent pl-9 text-xs focus:bg-white transition-all"
                    />
                </div>

                {/* Segment */}
                <select
                    value={segment}
                    onChange={(e) => onSegmentChange(e.target.value)}
                    className="h-9 rounded-full bg-gray-100/80 px-4 text-xs font-medium focus:outline-none cursor-pointer border-transparent"
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
                    className="h-9 rounded-full bg-gray-100/80 px-4 text-xs font-medium focus:outline-none cursor-pointer border-transparent"
                >
                    <option value="all">Все статусы</option>
                    <option value="active">Активные</option>
                    <option value="risk">Риск</option>
                    <option value="gone">Ушли</option>
                </select>

                {/* Period */}
                <div className="relative flex items-center gap-2" ref={pickerRef}>
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
                        className="h-9 rounded-full bg-gray-100/80 px-4 text-xs font-medium focus:outline-none cursor-pointer border-transparent"
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
                        className={`
                            flex h-9 items-center gap-2 px-4 rounded-full border transition-all text-xs font-medium
                            ${dateRange === -1 || (fromDate && toDate)
                                ? 'bg-gray-100/80 border-gray-300 text-gray-900' 
                                : 'bg-gray-100/80 border-transparent text-gray-500 hover:bg-gray-200/80'}
                        `}
                    >
                        <Calendar size={14} />
                        <span className="whitespace-nowrap">
                            {fromDate && toDate ? formatDateRange(fromDate, toDate) : "Выбрать даты"}
                        </span>
                        {(dateRange === -1 || (fromDate && toDate)) && <RefreshCw size={12} className="opacity-40" />}
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
                    <span className="text-[10px] font-bold text-gray-400 uppercase tracking-tight">Показывать:</span>
                    <select
                        value={pageSize}
                        onChange={(e) => onPageSizeChange(Number(e.target.value))}
                        className="h-9 rounded-full bg-gray-100/80 px-4 text-xs font-medium focus:outline-none cursor-pointer border-transparent"
                    >
                        <option value={50}>50</option>
                        <option value={100}>100</option>
                        <option value={150}>150</option>
                        <option value={200}>200</option>
                        <option value={-1}>Все</option>
                    </select>
                </div>

                <Button 
                    onClick={onSubmit} 
                    className="h-9 w-9 p-0 rounded-full bg-gray-900 text-white hover:bg-black shadow-sm"
                    disabled={isLoading}
                >
                    <Search size={16} />
                </Button>

                {/* Exclude Inactive Toggle */}
                <div className="flex items-center gap-2">
                    <label className="flex items-center gap-2 cursor-pointer select-none">
                        <input
                            type="checkbox"
                            checked={excludeInactive}
                            onChange={(e) => onExcludeInactiveChange?.(e.target.checked)}
                            className="w-4 h-4 rounded border-gray-300 text-primary focus:ring-primary"
                        />
                        <span className="text-[10px] font-bold text-gray-500 whitespace-nowrap">
                            Только активные
                        </span>
                    </label>
                </div>
            </div>
        </div>
    )
}
