"use client"

import { useState, useEffect, useMemo } from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"

interface CustomDateRangePickerProps {
    from?: string | Date
    to?: string | Date
    onSelect: (from: string, to: string) => void
    onClose: () => void
    maxDays?: number
}

export function CustomDateRangePicker({
    from,
    to,
    onSelect,
    onClose,
    maxDays = 45
}: CustomDateRangePickerProps) {
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    const [currentMonth, setCurrentMonth] = useState(new Date(today.getFullYear(), today.getMonth(), 1))
    
    // Internal state for selection
    const [startDate, setStartDate] = useState<Date | null>(from ? new Date(from) : null)
    const [endDate, setEndDate] = useState<Date | null>(to ? new Date(to) : null)
    const [hoverDate, setHoverDate] = useState<Date | null>(null)

    // Calendar generation
    const daysInMonth = useMemo(() => {
        const year = currentMonth.getFullYear()
        const month = currentMonth.getMonth()
        const firstDay = new Date(year, month, 1)
        const lastDay = new Date(year, month + 1, 0)
        
        const days = []
        const startPadding = (firstDay.getDay() + 6) % 7
        for (let i = 0; i < startPadding; i++) days.push(null)
        for (let i = 1; i <= lastDay.getDate(); i++) days.push(new Date(year, month, i))
        return days
    }, [currentMonth])

    const isSameDay = (d1: Date | null, d2: Date | null) => {
        if (!d1 || !d2) return false
        return d1.getFullYear() === d2.getFullYear() &&
               d1.getMonth() === d2.getMonth() &&
               d1.getDate() === d2.getDate()
    }

    const isBetween = (date: Date, start: Date, end: Date) => {
        const d = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
        const s = new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime()
        const e = new Date(end.getFullYear(), end.getMonth(), end.getDate()).getTime()
        const [low, high] = s < e ? [s, e] : [e, s]
        return d >= low && d <= high
    }

    const isInRange = (date: Date) => {
        if (!date || !startDate) return false
        const target = endDate || hoverDate
        if (!target) return isSameDay(date, startDate)
        return isBetween(date, startDate, target)
    }

    const formatDateLocal = (date: Date) => {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    const handleDateClick = (date: Date) => {
        if (!date) return
        const normalizedDate = new Date(date.getFullYear(), date.getMonth(), date.getDate())

        if (!startDate || (startDate && endDate)) {
            // First click or restart
            setStartDate(normalizedDate)
            setEndDate(null)
        } else {
            // Second click - complete range
            let start = new Date(startDate)
            let end = normalizedDate
            
            if (start > end) [start, end] = [end, start]

            // Strict enforcement of maxDays
            const diffTime = Math.abs(end.getTime() - start.getTime())
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1 // +1 because inclusive
            
            if (diffDays > maxDays) {
                // Adjust end date to exactly maxDays from start
                end = new Date(start)
                end.setDate(start.getDate() + maxDays - 1)
            }

            setStartDate(start)
            setEndDate(end)
            onSelect(formatDateLocal(start), formatDateLocal(end))
            // Auto close on second selection
            setTimeout(onClose, 300)
        }
    }

    // Force limit on hover too
    const displayInRange = (date: Date) => {
        if (!date || !startDate) return false
        if (endDate) return isBetween(date, startDate, endDate)
        if (!hoverDate) return isSameDay(date, startDate)
        
        let startD = new Date(startDate)
        let endD = new Date(hoverDate)
        if (startD > endD) [startD, endD] = [endD, startD]
        
        const diffTime = Math.abs(endD.getTime() - startD.getTime())
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1
        
        if (diffDays > maxDays) {
            // Cap visual range
            const cappedEnd = new Date(startD)
            cappedEnd.setDate(startD.getDate() + maxDays - 1)
            return isBetween(date, startD, cappedEnd)
        }
        
        return isBetween(date, startDate, hoverDate)
    }

    const nextMonth = () => setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1))
    const prevMonth = () => setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1))

    const monthNames = [
        "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
        "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"
    ]

    return (
        <div className="absolute top-full left-0 mt-1 z-[9999] w-[240px] rounded-[24px] bg-white p-3 shadow-2xl border border-gray-100 animate-in fade-in zoom-in-95 duration-200 select-none">
            {/* FORCE YELLOW CSS OVERRIDE */}
            <style dangerouslySetInnerHTML={{ __html: `
                .force-yandex-yellow {
                    background-color: #FFD700 !important;
                }
            ` }} />

            <div className="mb-4 flex items-center justify-between px-1">
                <button onClick={prevMonth} className="p-1 hover:bg-gray-50 rounded-full transition-colors">
                    <ChevronLeft className="h-4 w-4 text-gray-400" />
                </button>
                <div className="flex items-center gap-1 text-[11px] font-bold text-gray-900">
                    <span>{monthNames[currentMonth.getMonth()]}</span>
                    <span>{currentMonth.getFullYear()}</span>
                    <ChevronRight className="h-3 w-3 text-gray-400" />
                </div>
                <button onClick={nextMonth} className="p-1 hover:bg-gray-50 rounded-full transition-colors">
                    <ChevronRight className="h-4 w-4 text-gray-400" />
                </button>
            </div>

            <div className="mb-2 grid grid-cols-7 text-center">
                {["П", "В", "С", "Ч", "П", "С", "В"].map((d, i) => (
                    <span key={i} className="text-[9px] font-bold text-gray-300 uppercase tracking-widest">
                        {d}
                    </span>
                ))}
            </div>

            <div className="grid grid-cols-7 gap-y-0.5">
                {daysInMonth.map((date, i) => {
                    if (!date) return <div key={`empty-${i}`} className="h-8" />
                    
                    const inRange = displayInRange(date)
                    const isToday = isSameDay(date, today)
                    const isStart = startDate && isSameDay(date, startDate)
                    const isEnd = endDate && isSameDay(date, endDate)

                    return (
                        <div
                            key={date.toISOString()}
                            className="relative flex items-center justify-center h-8 cursor-pointer"
                            onMouseEnter={() => !endDate && setHoverDate(date)}
                            onMouseLeave={() => setHoverDate(null)}
                            onClick={() => handleDateClick(date)}
                        >
                            {/* Selection Background - Discrete Cells */}
                            {inRange && (
                                <div className={`
                                    force-yandex-yellow absolute inset-[2px] rounded-lg z-10
                                    ${(isStart || isEnd) ? 'ring-2 ring-gray-900 ring-offset-0' : ''}
                                `} />
                            )}
                            
                            {/* Date Number */}
                            <div className={`
                                relative z-30 flex items-center justify-center h-7 w-7 rounded-lg text-[11px] font-bold transition-all
                                ${inRange ? 'text-gray-900' : 'text-gray-900 hover:bg-gray-50'}
                                ${isToday && !inRange ? 'text-blue-500 font-extrabold underline' : ''}
                            `}>
                                {date.getDate()}
                            </div>
                        </div>
                    )
                })}
            </div>
        </div>
    )
}
