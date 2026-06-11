"use client"

import { useEffect, useMemo, useState } from "react"
import {
    BarChart3, PhoneIncoming, PhoneOutgoing, PhoneMissed, Sparkles, AlertTriangle, Loader2, Phone,
} from "lucide-react"
import {
    ResponsiveContainer, LineChart, Line, ComposedChart, Bar,
    XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from "recharts"

export interface StatsPayload {
    range: { from: string; to: string }
    totals: {
        inbound: number
        outbound: number
        answered: number
        missed: number
        total: number
        avgDurationSec: number | null
        avgAiScore: number | null
    }
    byManager: Array<{
        managerId: string
        name: string
        count: number
        answered: number
        missed: number
        missedRate: number
        avgDuration: number | null
        avgAiScore: number | null
    }>
    byDay: Array<{ date: string; count: number; answered: number }>
    byHour: Array<{ hour: number; count: number; answered: number }>
    topRedFlags: Array<{ flag: string; count: number }>
    criterionAvg: {
        greeting: number | null
        needs: number | null
        presentation: number | null
        objections: number | null
        next_step: number | null
    }
    managers: Array<{ id: string; name: string; role: string }>
}

const PRIMARY = '#2AABEE'   // Telegram blue — design token from CLAUDE.md
const ACCENT  = '#059669'   // success / answered
const DESTRUCT = '#DC2626'  // missed

const CRITERIA: Array<{ key: keyof StatsPayload['criterionAvg']; label: string }> = [
    { key: 'greeting',     label: 'Приветствие' },
    { key: 'needs',        label: 'Выявление потребностей' },
    { key: 'presentation', label: 'Презентация условий' },
    { key: 'objections',   label: 'Работа с возражениями' },
    { key: 'next_step',    label: 'Следующий шаг' },
]

/**
 * Analytics dashboard for calls. Re-fetches on filter change with a small
 * debounce so date input typing doesn't fire 4 requests per keystroke.
 */
export default function CallsStatsClient({
    initial,
    error: initialError,
}: {
    initial: StatsPayload | null
    error: string | null
}) {
    const [data, setData] = useState<StatsPayload | null>(initial)
    const [error, setError] = useState<string | null>(initialError)
    const [loading, setLoading] = useState(false)

    // Filters seeded from the initial range
    const [from, setFrom] = useState<string>(() => initial ? initial.range.from.slice(0, 10) : defaultFrom())
    const [to, setTo] = useState<string>(() => initial ? initial.range.to.slice(0, 10) : defaultTo())
    const [managerId, setManagerId] = useState<string>('all')

    // Re-fetch on filter change (debounce 300 ms so date typing isn't chatty).
    useEffect(() => {
        const t = setTimeout(() => {
            reload()
        }, 300)
        return () => clearTimeout(t)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [from, to, managerId])

    async function reload() {
        setLoading(true)
        setError(null)
        try {
            const params = new URLSearchParams({ from, to })
            if (managerId !== 'all') params.set('managerId', managerId)
            const res = await fetch(`/api/calls/stats?${params.toString()}`)
            if (!res.ok) throw new Error(`status ${res.status}`)
            const fresh = await res.json()
            setData(fresh)
        } catch (err: any) {
            setError(err.message ?? 'ошибка загрузки')
        } finally {
            setLoading(false)
        }
    }

    if (!data && error) {
        return (
            <div className="mx-auto max-w-3xl p-6">
                <div className="rounded-md border border-destructive/30 bg-destructive/5 p-[4px] text-[14px] text-destructive">
                    Не удалось загрузить статистику: {error}
                </div>
            </div>
        )
    }
    if (!data) {
        return <div className="p-6 text-[13px] text-muted-foreground">Загрузка…</div>
    }

    return (
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6 animate-in fade-in duration-300">
            <Header
                from={from}
                to={to}
                managerId={managerId}
                managers={data.managers}
                onFromChange={setFrom}
                onToChange={setTo}
                onManagerChange={setManagerId}
                loading={loading}
            />

            <KpiRow totals={data.totals} />

            <Card title="Звонки по дням">
                <DailyChart data={data.byDay} />
            </Card>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                <Card title="Менеджеры">
                    {data.byManager.length === 0 ? (
                        <Empty hint="В выбранный период звонков на менеджеров не было." />
                    ) : (
                        <ManagersChart data={data.byManager} />
                    )}
                </Card>

                <Card title="Средняя оценка по критериям">
                    <CriteriaBars values={data.criterionAvg} />
                </Card>
            </div>

            <Card title="Топ проблемных моментов">
                {data.topRedFlags.length === 0 ? (
                    <Empty hint="AI не нашёл повторяющихся проблем в звонках за период — либо звонков мало, либо всё хорошо." />
                ) : (
                    <RedFlagsList items={data.topRedFlags} />
                )}
            </Card>

            {/*
                TODO ASK USER: byHour heatmap — пока не отрисовываем. Уточнить:
                - Простой ряд столбцов 0..23 (как байт-чарт)?
                - Или heatmap день-недели × час (нужно ещё одно поле в API)?
                Данные уже отдаются в data.byHour, дорисовать UI можно за 30 минут.
            */}
        </div>
    )
}

function Header({
    from, to, managerId, managers, onFromChange, onToChange, onManagerChange, loading,
}: {
    from: string
    to: string
    managerId: string
    managers: StatsPayload['managers']
    onFromChange: (v: string) => void
    onToChange: (v: string) => void
    onManagerChange: (v: string) => void
    loading: boolean
}) {
    return (
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/10">
                    <BarChart3 className="h-5 w-5" style={{ color: PRIMARY }} />
                </div>
                <div>
                    <h1 className="text-[20px] font-semibold leading-tight text-foreground">Аналитика звонков</h1>
                    <p className="text-[13px] text-muted-foreground">Метрики и оценки разговоров за выбранный период.</p>
                </div>
            </div>

            <div className="flex flex-wrap items-end gap-3">
                <FilterField label="С">
                    <input
                        type="date"
                        value={from}
                        onChange={(e) => onFromChange(e.target.value)}
                        className="h-11 rounded-md border border-border bg-background px-3 text-[15px] text-foreground outline-none focus:border-primary"
                    />
                </FilterField>
                <FilterField label="По">
                    <input
                        type="date"
                        value={to}
                        onChange={(e) => onToChange(e.target.value)}
                        className="h-11 rounded-md border border-border bg-background px-3 text-[15px] text-foreground outline-none focus:border-primary"
                    />
                </FilterField>
                <FilterField label="Менеджер">
                    <select
                        value={managerId}
                        onChange={(e) => onManagerChange(e.target.value)}
                        className="h-11 rounded-md border border-border bg-background px-3 text-[15px] text-foreground outline-none focus:border-primary"
                    >
                        <option value="all">Все</option>
                        {managers.map(m => (
                            <option key={m.id} value={m.id}>{m.name}</option>
                        ))}
                    </select>
                </FilterField>
                <div className="flex h-11 items-center text-[12px] text-muted-foreground">
                    {loading && <span className="inline-flex items-center gap-1"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Обновляю…</span>}
                </div>
            </div>
        </div>
    )
}

function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <label className="flex flex-col gap-1">
            <span className="text-[12px] font-medium text-muted-foreground">{label}</span>
            {children}
        </label>
    )
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <section className="flex flex-col gap-[4px] rounded-md border border-border bg-card p-6">
            <h2 className="text-[15px] font-semibold text-foreground">{title}</h2>
            {children}
        </section>
    )
}

function KpiRow({ totals }: { totals: StatsPayload['totals'] }) {
    const answeredRate = totals.total > 0 ? totals.answered / totals.total : 0
    const missedRate = totals.total > 0 ? totals.missed / totals.total : 0

    return (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Kpi
                label="Всего звонков"
                value={totals.total.toLocaleString('ru-RU')}
                hint={`${totals.inbound} вх · ${totals.outbound} исх`}
                icon={Phone}
                color={PRIMARY}
            />
            <Kpi
                label="Отвечено"
                value={totals.answered.toLocaleString('ru-RU')}
                hint={`${Math.round(answeredRate * 100)}% от всех`}
                icon={PhoneIncoming}
                color={ACCENT}
            />
            <Kpi
                label="Пропущено"
                value={totals.missed.toLocaleString('ru-RU')}
                hint={`${Math.round(missedRate * 100)}% от всех`}
                icon={PhoneMissed}
                color={DESTRUCT}
            />
            <Kpi
                label="AI-оценка"
                value={totals.avgAiScore !== null ? totals.avgAiScore.toFixed(1) : '—'}
                hint={totals.avgDurationSec !== null ? `Ср. длит. ${formatDuration(totals.avgDurationSec)}` : ''}
                icon={Sparkles}
                color={PRIMARY}
            />
        </div>
    )
}

function Kpi({ label, value, hint, icon: Icon, color }: {
    label: string
    value: string
    hint: string
    icon: typeof Phone
    color: string
}) {
    return (
        <div className="flex flex-col gap-1 rounded-md border border-border bg-card p-[4px]">
            <div className="flex items-center justify-between">
                <span className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
                <Icon className="h-[4px] w-[4px]" style={{ color }} />
            </div>
            <div className="text-[24px] font-semibold tabular-nums text-foreground" style={{ lineHeight: 1.2 }}>{value}</div>
            <div className="text-[12px] text-muted-foreground">{hint || ' '}</div>
        </div>
    )
}

function DailyChart({ data }: { data: StatsPayload['byDay'] }) {
    // Compact date label so x-axis isn't wall-of-text on 30-day ranges.
    const chartData = useMemo(
        () => data.map(d => ({ ...d, label: formatShortDate(d.date) })),
        [data]
    )

    return (
        <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke="#E4ECFC" strokeDasharray="3 3" />
                    <XAxis dataKey="label" stroke="#64748B" tick={{ fontSize: 11 }} />
                    <YAxis stroke="#64748B" tick={{ fontSize: 11 }} allowDecimals={false} />
                    <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: '#0F172A', fontWeight: 600 }} />
                    <Legend iconType="plainline" wrapperStyle={{ fontSize: 12 }} />
                    <Line
                        name="Всего"
                        type="monotone"
                        dataKey="count"
                        stroke={PRIMARY}
                        strokeWidth={2}
                        dot={false}
                        activeDot={{ r: 4 }}
                    />
                    <Line
                        name="Отвечено"
                        type="monotone"
                        dataKey="answered"
                        stroke={ACCENT}
                        strokeWidth={2}
                        dot={false}
                        activeDot={{ r: 4 }}
                    />
                </LineChart>
            </ResponsiveContainer>
        </div>
    )
}

function ManagersChart({ data }: { data: StatsPayload['byManager'] }) {
    // Dual-axis: bars for call count (left axis), bar for AI score 0-10 (right).
    // Recharts doesn't render multi-axis bars cleanly side-by-side automatically;
    // we use one bar per axis with explicit yAxisId binding.
    const chartData = data.map(m => ({
        name: shortName(m.name),
        count: m.count,
        aiScore: m.avgAiScore !== null ? Number(m.avgAiScore.toFixed(1)) : 0,
        missedRate: Math.round(m.missedRate * 100),
    }))

    return (
        <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke="#E4ECFC" strokeDasharray="3 3" />
                    <XAxis dataKey="name" stroke="#64748B" tick={{ fontSize: 11 }} />
                    <YAxis
                        yAxisId="left"
                        stroke="#64748B"
                        tick={{ fontSize: 11 }}
                        allowDecimals={false}
                        label={{ value: 'звонков', angle: -90, position: 'insideLeft', style: { fontSize: 11, fill: '#64748B' } }}
                    />
                    <YAxis
                        yAxisId="right"
                        orientation="right"
                        stroke="#64748B"
                        tick={{ fontSize: 11 }}
                        domain={[0, 10]}
                        label={{ value: 'AI-оценка', angle: 90, position: 'insideRight', style: { fontSize: 11, fill: '#64748B' } }}
                    />
                    <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: '#0F172A', fontWeight: 600 }} />
                    <Legend iconType="square" wrapperStyle={{ fontSize: 12 }} />
                    <Bar yAxisId="left" dataKey="count" name="Звонков" fill={PRIMARY} radius={[4, 4, 0, 0]} />
                    <Bar yAxisId="right" dataKey="aiScore" name="AI-оценка" fill={ACCENT} radius={[4, 4, 0, 0]} />
                </ComposedChart>
            </ResponsiveContainer>
        </div>
    )
}

function CriteriaBars({ values }: { values: StatsPayload['criterionAvg'] }) {
    return (
        <div className="flex flex-col gap-3">
            {CRITERIA.map(c => {
                const v = values[c.key]
                return (
                    <div key={c.key} className="flex flex-col gap-1">
                        <div className="flex items-baseline justify-between">
                            <span className="text-[14px] text-foreground">{c.label}</span>
                            <span className="text-[13px] tabular-nums text-muted-foreground">
                                {v !== null ? `${v.toFixed(1)}/10` : '—'}
                            </span>
                        </div>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface">
                            <div
                                className="h-full rounded-full"
                                style={{
                                    width: `${v !== null ? Math.max(0, Math.min(100, v * 10)) : 0}%`,
                                    background: v === null ? '#E4ECFC' : v >= 8 ? ACCENT : v >= 5 ? PRIMARY : DESTRUCT,
                                }}
                            />
                        </div>
                    </div>
                )
            })}
        </div>
    )
}

function RedFlagsList({ items }: { items: StatsPayload['topRedFlags'] }) {
    return (
        <ul className="divide-y divide-border">
            {items.map((f, i) => (
                <li
                    key={`${f.flag}-${i}`}
                    className="flex items-center gap-3 py-3"
                    style={{ minHeight: 56 }}
                >
                    <AlertTriangle className="h-[4px] w-[4px] flex-shrink-0 text-destructive" />
                    <div className="min-w-0 flex-1 text-[14px] text-foreground">{f.flag}</div>
                    <div className="text-[13px] tabular-nums text-muted-foreground">{f.count}</div>
                </li>
            ))}
        </ul>
    )
}

function Empty({ hint }: { hint: string }) {
    return (
        <div className="py-[8px] text-center text-[13px] text-muted-foreground">{hint}</div>
    )
}

// ── utils ───────────────────────────────────────────────────────────────────

const tooltipStyle = {
    background: '#FFFFFF',
    border: '1px solid #E4ECFC',
    borderRadius: 8,
    fontSize: 12,
} as const

function formatDuration(sec: number): string {
    const m = Math.floor(sec / 60).toString().padStart(2, '0')
    const s = Math.round(sec % 60).toString().padStart(2, '0')
    return `${m}:${s}`
}

function formatShortDate(iso: string): string {
    // 2026-05-14 → "14.05"
    const [, mm, dd] = iso.split('-')
    return `${dd}.${mm}`
}

function shortName(full: string): string {
    // "Мария Иванова" → "М. Иванова"
    const parts = full.split(/\s+/)
    if (parts.length < 2) return full
    return `${parts[0][0]}. ${parts.slice(1).join(' ')}`
}

function defaultFrom(): string {
    const d = new Date()
    d.setUTCDate(d.getUTCDate() - 29)
    return d.toISOString().slice(0, 10)
}
function defaultTo(): string {
    return new Date().toISOString().slice(0, 10)
}
