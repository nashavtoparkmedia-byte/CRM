'use client'

/**
 * DateTimePicker — Telegram-style compact date+time picker.
 *
 * Three stacked sections:
 *   1. Quick preset chips covering ~80 % of CRM scenarios
 *      («Через час», «Через 3 часа», «Завтра 09:00», «Послезавтра 09:00»).
 *      One click sets both date and time.
 *   2. Tiny calendar grid (popover, 7×N days of the current month + nav).
 *      Pure-CSS, no dep — ~60 lines of layout.
 *   3. Time stepper — two big tap targets per side (hours / minutes),
 *      ↑↓ buttons, click-and-hold accelerates. Reads in HH:MM mono.
 *
 * Value model: ISO string (datetime-local form, "YYYY-MM-DDTHH:mm"). Same
 * shape as the native <input type="datetime-local"> it replaces, so any
 * form using it as a drop-in works without serializer changes.
 */

import { useState, useEffect, useRef } from 'react'
import { ChevronLeft, ChevronRight, ChevronUp, ChevronDown, Calendar as CalendarIcon, Clock, X } from 'lucide-react'

interface Props {
    value: string  // "YYYY-MM-DDTHH:mm" or "" for unset
    onChange: (v: string) => void
    className?: string
}

const MS_HOUR = 3600_000
const DAYS_RU = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']
const MONTHS_RU = [
    'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
    'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
]

function pad(n: number) {
    return n.toString().padStart(2, '0')
}

/** Convert a Date to "YYYY-MM-DDTHH:mm" in the user's local TZ. */
function toLocalIso(d: Date): string {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Parse "YYYY-MM-DDTHH:mm" to Date in user's local TZ (no UTC shift). */
function fromLocalIso(s: string): Date | null {
    if (!s) return null
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/)
    if (!m) return null
    const [, y, mo, d, h, mi] = m
    return new Date(+y, +mo - 1, +d, +h, +mi)
}

function buildPresets(): { label: string; iso: string }[] {
    const now = new Date()
    const inHour = new Date(now.getTime() + MS_HOUR)
    const inThree = new Date(now.getTime() + 3 * MS_HOUR)
    const tomorrow9 = new Date(now); tomorrow9.setDate(now.getDate() + 1); tomorrow9.setHours(9, 0, 0, 0)
    const dayAfter9 = new Date(now); dayAfter9.setDate(now.getDate() + 2); dayAfter9.setHours(9, 0, 0, 0)
    return [
        { label: 'Через час', iso: toLocalIso(inHour) },
        { label: 'Через 3 часа', iso: toLocalIso(inThree) },
        { label: 'Завтра 09:00', iso: toLocalIso(tomorrow9) },
        { label: 'Послезавтра 09:00', iso: toLocalIso(dayAfter9) },
    ]
}

export default function DateTimePicker({ value, onChange, className = '' }: Props) {
    const parsed = fromLocalIso(value)
    const today = new Date()
    const [showCalendar, setShowCalendar] = useState(false)
    // Visible month/year on the calendar; defaults to selected date's month
    // (or current month when no value yet).
    const [viewYear, setViewYear] = useState((parsed ?? today).getFullYear())
    const [viewMonth, setViewMonth] = useState((parsed ?? today).getMonth())
    const calRef = useRef<HTMLDivElement>(null)
    const presets = buildPresets()

    // Re-sync calendar view when the parent flips us to a different date.
    useEffect(() => {
        const d = fromLocalIso(value)
        if (d) {
            setViewYear(d.getFullYear())
            setViewMonth(d.getMonth())
        }
    }, [value])

    // Close calendar on outside click
    useEffect(() => {
        if (!showCalendar) return
        const handler = (e: MouseEvent) => {
            if (calRef.current && !calRef.current.contains(e.target as Node)) {
                setShowCalendar(false)
            }
        }
        document.addEventListener('mousedown', handler)
        return () => document.removeEventListener('mousedown', handler)
    }, [showCalendar])

    /** Set just the date portion, keep the time (defaulting to 10:00 if blank). */
    const pickDate = (d: Date) => {
        const cur = parsed ?? new Date()
        const h = parsed ? cur.getHours() : 10
        const m = parsed ? cur.getMinutes() : 0
        const next = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m)
        onChange(toLocalIso(next))
        setShowCalendar(false)
    }

    /** Bump the hour or minute by +/-N. Wraps within 0..59 (minutes) and
        rolls the day forward/back when hours overflow. */
    const bumpTime = (kind: 'h' | 'm', delta: number) => {
        const base = parsed ?? new Date(today.getFullYear(), today.getMonth(), today.getDate(), 10, 0)
        const next = new Date(base)
        if (kind === 'h') next.setHours(next.getHours() + delta)
        else next.setMinutes(next.getMinutes() + delta)
        onChange(toLocalIso(next))
    }

    // Hours: ±1 normal click, ±3 shift-click. Minutes: ±5 normal, ±15 shift.
    const hourClick = (e: React.MouseEvent, sign: 1 | -1) => bumpTime('h', sign * (e.shiftKey ? 3 : 1))
    const minClick = (e: React.MouseEvent, sign: 1 | -1) => bumpTime('m', sign * (e.shiftKey ? 15 : 5))

    // Build calendar grid for the visible month.
    // First day of week is Monday (Russian convention).
    const firstOfMonth = new Date(viewYear, viewMonth, 1)
    const startWeekday = (firstOfMonth.getDay() + 6) % 7 // 0=Mon
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate()
    const cells: (Date | null)[] = []
    for (let i = 0; i < startWeekday; i++) cells.push(null)
    for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(viewYear, viewMonth, d))
    while (cells.length % 7 !== 0) cells.push(null)

    const isSameDay = (a: Date | null, b: Date | null) =>
        !!a && !!b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

    const displayDate = parsed ? `${pad(parsed.getDate())}.${pad(parsed.getMonth() + 1)}.${parsed.getFullYear()}` : 'Не выбрано'
    const displayHour = parsed ? pad(parsed.getHours()) : '--'
    const displayMin = parsed ? pad(parsed.getMinutes()) : '--'

    return (
        <div className={`space-y-2.5 ${className}`}>
            {/* Quick presets — one click sets a sensible date+time pair. */}
            <div className="flex flex-wrap gap-1.5">
                {presets.map(p => (
                    <button
                        key={p.label}
                        type="button"
                        onClick={() => onChange(p.iso)}
                        className={`h-[28px] px-2.5 rounded-full text-[12px] font-medium border transition-colors ${
                            value === p.iso
                                ? 'bg-[#4f46e5] border-[#4f46e5] text-white'
                                : 'bg-white border-[#e5e7eb] text-[#374151] hover:bg-[#f9fafb]'
                        }`}
                    >
                        {p.label}
                    </button>
                ))}
                {value && (
                    <button
                        type="button"
                        onClick={() => onChange('')}
                        className="h-[28px] px-2 rounded-full text-[12px] font-medium border border-transparent text-[#9ca3af] hover:bg-[#f3f4f6]"
                        title="Очистить"
                    >
                        <X className="w-3.5 h-3.5" />
                    </button>
                )}
            </div>

            {/* Date + time row. Date opens a popover calendar; time is two
                steppers (hour | minute) with ↑↓ buttons. */}
            <div className="flex items-stretch gap-2">
                {/* Date field */}
                <div ref={calRef} className="relative flex-1 min-w-0">
                    <button
                        type="button"
                        onClick={() => setShowCalendar(s => !s)}
                        className="w-full h-[44px] flex items-center gap-2 px-3 bg-[#f9fafb] border border-[#d1d5db] rounded-lg text-[14px] hover:bg-[#f3f4f6] transition-colors"
                    >
                        <CalendarIcon className="w-4 h-4 text-[#6b7280]" />
                        <span className={parsed ? 'text-[#111827] font-medium' : 'text-[#9ca3af]'}>
                            {displayDate}
                        </span>
                    </button>
                    {showCalendar && (
                        <div className="absolute z-50 top-[48px] left-0 w-[280px] bg-white rounded-xl border border-[#e5e7eb] shadow-lg p-3 animate-in fade-in zoom-in-95 duration-150">
                            {/* Month nav */}
                            <div className="flex items-center justify-between mb-2">
                                <button
                                    type="button"
                                    onClick={() => {
                                        if (viewMonth === 0) { setViewMonth(11); setViewYear(viewYear - 1) }
                                        else setViewMonth(viewMonth - 1)
                                    }}
                                    className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-[#f3f4f6]"
                                >
                                    <ChevronLeft className="w-4 h-4 text-[#6b7280]" />
                                </button>
                                <span className="text-[13px] font-semibold text-[#111827]">
                                    {MONTHS_RU[viewMonth]} {viewYear}
                                </span>
                                <button
                                    type="button"
                                    onClick={() => {
                                        if (viewMonth === 11) { setViewMonth(0); setViewYear(viewYear + 1) }
                                        else setViewMonth(viewMonth + 1)
                                    }}
                                    className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-[#f3f4f6]"
                                >
                                    <ChevronRight className="w-4 h-4 text-[#6b7280]" />
                                </button>
                            </div>
                            {/* Weekday header */}
                            <div className="grid grid-cols-7 gap-1 mb-1">
                                {DAYS_RU.map(d => (
                                    <div key={d} className="h-7 flex items-center justify-center text-[11px] font-semibold text-[#9ca3af]">
                                        {d}
                                    </div>
                                ))}
                            </div>
                            {/* Day grid */}
                            <div className="grid grid-cols-7 gap-1">
                                {cells.map((d, i) => {
                                    if (!d) return <div key={i} />
                                    const isPast = d < new Date(today.getFullYear(), today.getMonth(), today.getDate())
                                    const isToday = isSameDay(d, today)
                                    const isSelected = isSameDay(d, parsed)
                                    return (
                                        <button
                                            key={i}
                                            type="button"
                                            disabled={isPast}
                                            onClick={() => pickDate(d)}
                                            className={`h-8 rounded-md text-[12px] font-medium transition-colors ${
                                                isSelected
                                                    ? 'bg-[#4f46e5] text-white'
                                                    : isPast
                                                        ? 'text-[#d1d5db] cursor-not-allowed'
                                                        : isToday
                                                            ? 'bg-[#eef2ff] text-[#4f46e5] hover:bg-[#e0e7ff]'
                                                            : 'text-[#374151] hover:bg-[#f3f4f6]'
                                            }`}
                                        >
                                            {d.getDate()}
                                        </button>
                                    )
                                })}
                            </div>
                            {/* Footer shortcut */}
                            <div className="mt-2 flex justify-between items-center pt-2 border-t border-[#f3f4f6]">
                                <button
                                    type="button"
                                    onClick={() => pickDate(today)}
                                    className="text-[12px] font-medium text-[#4f46e5] hover:underline"
                                >
                                    Сегодня
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setShowCalendar(false)}
                                    className="text-[12px] text-[#9ca3af] hover:text-[#374151]"
                                >
                                    Закрыть
                                </button>
                            </div>
                        </div>
                    )}
                </div>

                {/* Time stepper. Two columns: hours | minutes, each with up/down
                    chevrons. Shift-click for bigger increments. */}
                <div className="flex items-center gap-1 h-[44px] px-2 bg-[#f9fafb] border border-[#d1d5db] rounded-lg">
                    <Clock className="w-4 h-4 text-[#6b7280] shrink-0" />
                    <Stepper
                        value={displayHour}
                        onUp={(e) => hourClick(e, 1)}
                        onDown={(e) => hourClick(e, -1)}
                    />
                    <span className="text-[16px] font-semibold text-[#6b7280]">:</span>
                    <Stepper
                        value={displayMin}
                        onUp={(e) => minClick(e, 1)}
                        onDown={(e) => minClick(e, -1)}
                    />
                </div>
            </div>
        </div>
    )
}

/** Two-row stepper: ↑ above value, ↓ below. Click increments via callback. */
function Stepper({
    value,
    onUp,
    onDown,
}: {
    value: string
    onUp: (e: React.MouseEvent) => void
    onDown: (e: React.MouseEvent) => void
}) {
    return (
        <div className="flex flex-col items-center justify-center select-none">
            <button
                type="button"
                onClick={onUp}
                className="w-7 h-[14px] flex items-center justify-center text-[#6b7280] hover:text-[#4f46e5] rounded"
                tabIndex={-1}
            >
                <ChevronUp className="w-3.5 h-3.5" strokeWidth={2.5} />
            </button>
            <span className="font-mono font-bold text-[15px] tabular-nums text-[#111827] leading-none my-0.5">
                {value}
            </span>
            <button
                type="button"
                onClick={onDown}
                className="w-7 h-[14px] flex items-center justify-center text-[#6b7280] hover:text-[#4f46e5] rounded"
                tabIndex={-1}
            >
                <ChevronDown className="w-3.5 h-3.5" strokeWidth={2.5} />
            </button>
        </div>
    )
}
