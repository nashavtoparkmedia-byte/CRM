'use client'

/**
 * DateTimePicker — Telegram-style date+time picker tuned for "one tap"
 * operator workflows. Two layers:
 *
 *   • PRIMARY — four big preset tiles in a 2×2 grid covering ~90 % of
 *     CRM tasks: "Через час", "Через 3 часа", "Завтра 09:00",
 *     "Послезавтра 09:00". Active tile highlights. One click sets the
 *     full ISO value; operator never has to touch a calendar.
 *
 *   • SECONDARY — a "Своё время…" link that expands an inline row with
 *     a native <input type=date> (browser popup overflows the modal
 *     cleanly, no z-index battles) and a custom HH:MM stepper. Hidden
 *     by default to keep the modal lean.
 *
 * Value contract matches <input type=datetime-local>: "YYYY-MM-DDTHH:mm"
 * or "" for unset, so swapping in/out is a drop-in.
 */

import { useState, useEffect } from 'react'
import { ChevronUp, ChevronDown, Clock, Pencil, X } from 'lucide-react'

interface Props {
    value: string  // "YYYY-MM-DDTHH:mm" or "" for unset
    onChange: (v: string) => void
    className?: string
}

const MS_HOUR = 3600_000
const MONTHS_GENITIVE_RU = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
                             'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря']

const pad = (n: number) => n.toString().padStart(2, '0')

const toLocalIso = (d: Date) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`

const fromLocalIso = (s: string): Date | null => {
    if (!s) return null
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/)
    if (!m) return null
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])
}

/** Build the 4 preset options keyed off "now". */
function buildPresets() {
    const now = new Date()
    const inHour = new Date(now.getTime() + MS_HOUR)
    const inThree = new Date(now.getTime() + 3 * MS_HOUR)
    const tomorrow9 = new Date(now); tomorrow9.setDate(now.getDate() + 1); tomorrow9.setHours(9, 0, 0, 0)
    const dayAfter9 = new Date(now); dayAfter9.setDate(now.getDate() + 2); dayAfter9.setHours(9, 0, 0, 0)
    return [
        { label: 'Через час', sub: timeLabel(inHour), iso: toLocalIso(inHour) },
        { label: 'Через 3 часа', sub: timeLabel(inThree), iso: toLocalIso(inThree) },
        { label: 'Завтра в 9:00', sub: dateLabel(tomorrow9), iso: toLocalIso(tomorrow9) },
        { label: 'Послезавтра в 9:00', sub: dateLabel(dayAfter9), iso: toLocalIso(dayAfter9) },
    ]
}

function timeLabel(d: Date) {
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function dateLabel(d: Date) {
    return `${d.getDate()} ${MONTHS_GENITIVE_RU[d.getMonth()]}`
}

/** Human-readable "выбранное" line: «сегодня в 18:00», «завтра в 9:00»,
    «16 мая в 18:00». Days-from-now relative wording for ≤2 days, otherwise
    absolute date. */
function humanLabel(d: Date): string {
    const today = new Date(); today.setHours(0, 0, 0, 0)
    const target = new Date(d); target.setHours(0, 0, 0, 0)
    const days = Math.round((target.getTime() - today.getTime()) / 86_400_000)
    const timeStr = timeLabel(d)
    if (days === 0) return `сегодня в ${timeStr}`
    if (days === 1) return `завтра в ${timeStr}`
    if (days === 2) return `послезавтра в ${timeStr}`
    return `${dateLabel(d)} в ${timeStr}`
}

export default function DateTimePicker({ value, onChange, className = '' }: Props) {
    const parsed = fromLocalIso(value)
    const [showManual, setShowManual] = useState(false)
    const [presets, setPresets] = useState(buildPresets)

    // Keep presets "alive" — the «Через час» label is relative to current
    // time, so it must follow the clock. Cheaper to rebuild on a 60s tick
    // than to schedule a forwarded timer. (Modal is short-lived anyway.)
    useEffect(() => {
        const id = setInterval(() => setPresets(buildPresets()), 60_000)
        return () => clearInterval(id)
    }, [])

    const activePresetIso = presets.find(p => p.iso === value)?.iso ?? null

    // Stepper handlers — Shift+click for bigger jumps, same as before.
    const bump = (kind: 'h' | 'm', delta: number) => {
        const base = parsed ?? (() => {
            const t = new Date(); t.setHours(10, 0, 0, 0); return t
        })()
        const next = new Date(base)
        if (kind === 'h') next.setHours(next.getHours() + delta)
        else next.setMinutes(next.getMinutes() + delta)
        onChange(toLocalIso(next))
    }
    const hourClick = (e: React.MouseEvent, sign: 1 | -1) => bump('h', sign * (e.shiftKey ? 3 : 1))
    const minClick = (e: React.MouseEvent, sign: 1 | -1) => bump('m', sign * (e.shiftKey ? 15 : 5))

    // Native date input value is "YYYY-MM-DD" (no time).
    const dateOnly = parsed ? `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}` : ''
    const handleDateChange = (s: string) => {
        if (!s) {
            onChange('')
            return
        }
        const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
        if (!m) return
        const cur = parsed ?? (() => {
            const t = new Date(); t.setHours(10, 0, 0, 0); return t
        })()
        const next = new Date(+m[1], +m[2] - 1, +m[3], cur.getHours(), cur.getMinutes())
        onChange(toLocalIso(next))
    }

    return (
        <div className={`space-y-2 ${className}`}>
            {/* Preset tiles — 2×2 grid for big tap targets. Each tile shows
                a primary label («Через час») and a smaller secondary line
                with the resolved absolute time («18:35» or «17 мая»). */}
            <div className="grid grid-cols-2 gap-1.5">
                {presets.map(p => {
                    const active = activePresetIso === p.iso
                    return (
                        <button
                            key={p.label}
                            type="button"
                            onClick={() => onChange(p.iso)}
                            className={`flex flex-col items-start justify-center px-3 py-2 rounded-lg border text-left transition-colors ${
                                active
                                    ? 'bg-[#4f46e5] border-[#4f46e5] text-white'
                                    : 'bg-white border-[#e5e7eb] text-[#374151] hover:bg-[#f9fafb] hover:border-[#d1d5db]'
                            }`}
                        >
                            <span className="text-[13px] font-semibold leading-tight">{p.label}</span>
                            <span className={`text-[11px] mt-0.5 leading-tight ${active ? 'text-white/80' : 'text-[#9ca3af]'}`}>
                                {p.sub}
                            </span>
                        </button>
                    )
                })}
            </div>

            {/* Selected display + edit affordance. Shows what's set in plain
                Russian; click pencil to reveal manual date/time editor. */}
            <div className="flex items-center gap-2 text-[12px] text-[#6b7280] px-1">
                {parsed ? (
                    <>
                        <span>Выбрано:</span>
                        <span className="font-semibold text-[#111827]">{humanLabel(parsed)}</span>
                    </>
                ) : (
                    <span className="text-[#9ca3af]">Не выбрано — нажмите кнопку выше</span>
                )}
                <button
                    type="button"
                    onClick={() => setShowManual(s => !s)}
                    className="ml-auto inline-flex items-center gap-1 px-2 h-[24px] rounded-md text-[11px] font-medium text-[#4f46e5] hover:bg-[#eef2ff]"
                >
                    <Pencil className="w-3 h-3" />
                    {showManual ? 'Скрыть' : 'Своё время'}
                </button>
                {parsed && !activePresetIso && (
                    <button
                        type="button"
                        onClick={() => onChange('')}
                        title="Очистить"
                        className="inline-flex items-center justify-center w-[24px] h-[24px] rounded-md text-[#9ca3af] hover:text-[#374151] hover:bg-[#f3f4f6]"
                    >
                        <X className="w-3.5 h-3.5" />
                    </button>
                )}
            </div>

            {/* Manual editor — collapsed by default. Native date input opens
                the browser's date popup outside the modal's DOM so we don't
                fight z-index or overflow. Time uses our stepper. */}
            {showManual && (
                <div className="flex items-stretch gap-2 pt-1">
                    <input
                        type="date"
                        value={dateOnly}
                        onChange={e => handleDateChange(e.target.value)}
                        className="flex-1 h-[42px] bg-[#f9fafb] border border-[#d1d5db] rounded-lg px-3 text-[14px] font-medium text-[#111827] outline-none focus:border-[#4f46e5]"
                    />
                    <div className="flex items-center gap-1 h-[42px] px-2.5 bg-[#f9fafb] border border-[#d1d5db] rounded-lg">
                        <Clock className="w-3.5 h-3.5 text-[#6b7280] shrink-0" />
                        <Stepper
                            value={parsed ? pad(parsed.getHours()) : '--'}
                            onUp={e => hourClick(e, 1)}
                            onDown={e => hourClick(e, -1)}
                        />
                        <span className="text-[15px] font-bold text-[#9ca3af]">:</span>
                        <Stepper
                            value={parsed ? pad(parsed.getMinutes()) : '--'}
                            onUp={e => minClick(e, 1)}
                            onDown={e => minClick(e, -1)}
                        />
                    </div>
                </div>
            )}
        </div>
    )
}

/** Two-row stepper: ↑ above value, ↓ below. */
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
                className="w-6 h-[13px] flex items-center justify-center text-[#6b7280] hover:text-[#4f46e5] rounded"
                tabIndex={-1}
            >
                <ChevronUp className="w-3.5 h-3.5" strokeWidth={2.5} />
            </button>
            <span className="font-mono font-bold text-[14px] tabular-nums text-[#111827] leading-none my-[1px]">
                {value}
            </span>
            <button
                type="button"
                onClick={onDown}
                className="w-6 h-[13px] flex items-center justify-center text-[#6b7280] hover:text-[#4f46e5] rounded"
                tabIndex={-1}
            >
                <ChevronDown className="w-3.5 h-3.5" strokeWidth={2.5} />
            </button>
        </div>
    )
}
