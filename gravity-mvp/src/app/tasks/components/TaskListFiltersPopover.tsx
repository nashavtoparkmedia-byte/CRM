'use client'

// ═══════════════════════════════════════════════════════════════════
// TaskListFiltersPopover — a single entry point for "все остальные"
// filters: status/priority/source/type/period/assignee + churn-
// specific (overdue/offer/park/scenario fields) + meta (scenario
// source/completeness).
//
// Row 2.5 keeps only the 4 high-visibility presets (Горячие / Без
// контакта / SLA горит / Новый ответ). Everything else lives here.
// ═══════════════════════════════════════════════════════════════════

import { useState, useEffect, useMemo } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { SlidersHorizontal, RotateCcw } from 'lucide-react'
import { useTasksStore } from '@/store/tasks-store'
import { useTopParks } from '@/store/tasks-selectors'
import { getScenarioFilterableFields, SCENARIOS } from '@/lib/tasks/scenario-config'
import type { ScenarioFieldDef } from '@/lib/tasks/scenario-config'
import { TASK_TYPES, type TaskFilters } from '@/lib/tasks/types'
import { recordUsage } from '@/lib/tasks/usage'

// ─── Options ─────────────────────────────────────────────────────────

const STATUS_OPTIONS = [
    { value: 'all', label: 'Все' },
    { value: 'todo', label: 'К выполнению' },
    { value: 'in_progress', label: 'В работе' },
    { value: 'waiting_reply', label: 'Ждёт ответа' },
    { value: 'overdue', label: 'Просрочено' },
    { value: 'done', label: 'Выполнено' },
]

const PRIORITY_OPTIONS = [
    { value: 'all', label: 'Все' },
    { value: 'critical', label: 'Критический' },
    { value: 'high', label: 'Высокий' },
    { value: 'medium', label: 'Средний' },
    { value: 'low', label: 'Низкий' },
]

const SOURCE_OPTIONS = [
    { value: 'all', label: 'Все' },
    { value: 'auto', label: 'Авто' },
    { value: 'manual', label: 'Ручная' },
    { value: 'chat', label: 'Из чата' },
]

const PERIOD_OPTIONS = [
    { value: 'all', label: 'Все' },
    { value: 'today', label: 'Сегодня' },
    { value: 'week', label: 'Неделя' },
    { value: 'month', label: 'Месяц' },
]

function getDatePreset(preset: string): { dateFrom?: string; dateTo?: string } {
    const now = new Date()
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    if (preset === 'today') return { dateFrom: startOfDay.toISOString() }
    if (preset === 'week') {
        const weekAgo = new Date(startOfDay); weekAgo.setDate(weekAgo.getDate() - 7)
        return { dateFrom: weekAgo.toISOString() }
    }
    if (preset === 'month') {
        const monthAgo = new Date(startOfDay); monthAgo.setMonth(monthAgo.getMonth() - 1)
        return { dateFrom: monthAgo.toISOString() }
    }
    return { dateFrom: undefined, dateTo: undefined }
}

// ─── Component ───────────────────────────────────────────────────────

interface Props {
    crmUsers: { id: string; name: string; role: string }[]
}

export default function TaskListFiltersPopover({ crmUsers }: Props) {
    const [open, setOpen] = useState(false)
    const filters = useTasksStore(s => s.filters)
    const setFilters = useTasksStore(s => s.setFilters)
    const resetFilters = useTasksStore(s => s.resetFilters)

    const [periodPreset, setPeriodPreset] = useState('all')

    // Keep local period in sync with store (e.g. after reset)
    useEffect(() => {
        if (!filters.dateFrom && !filters.dateTo) setPeriodPreset('all')
    }, [filters.dateFrom, filters.dateTo])

    const activeCount = useMemo(() => countActiveFilters(filters), [filters])

    const parks = useTopParks(20)
    const activeScenario = filters.scenario
    const scenarioConfig = typeof activeScenario === 'string' ? SCENARIOS[activeScenario] : null

    const track = (key: string, value: unknown) => {
        void recordUsage('filter_change', { key, value: value as TaskFilters[keyof TaskFilters] ?? null, via: 'popover' })
    }

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                <button
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#E4ECFC] text-[#334155] text-[13px] font-medium hover:bg-[#F1F5FD] transition-colors relative"
                >
                    <SlidersHorizontal className="w-3.5 h-3.5" />
                    Фильтры
                    {activeCount > 0 && (
                        <span className="ml-1 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-[#1E40AF] text-white text-[11px] font-semibold">
                            {activeCount}
                        </span>
                    )}
                </button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>Фильтры</DialogTitle>
                </DialogHeader>

                <div className="flex items-center justify-between text-[12px] text-[#64748B] mb-2">
                    <span>Активных фильтров: {activeCount}</span>
                    {activeCount > 0 && (
                        <button
                            onClick={() => { resetFilters(); setPeriodPreset('all') }}
                            className="flex items-center gap-1 text-[#DC2626] hover:text-[#B91C1C] transition-colors"
                        >
                            <RotateCcw className="w-3 h-3" /> Сбросить всё
                        </button>
                    )}
                </div>

                {/* Управление кейсом */}
                <FilterGroup title="Управление кейсом">
                    <SelectField
                        label="Статус"
                        value={(filters.status as string) ?? 'all'}
                        options={STATUS_OPTIONS}
                        onChange={(v) => { setFilters({ status: v as TaskFilters['status'] }); track('status', v) }}
                    />
                    <SelectField
                        label="Приоритет"
                        value={(filters.priority as string) ?? 'all'}
                        options={PRIORITY_OPTIONS}
                        onChange={(v) => { setFilters({ priority: v as TaskFilters['priority'] }); track('priority', v) }}
                    />
                    <ToggleField
                        label="Только просроченные"
                        checked={!!filters.overdue}
                        onChange={(v) => { setFilters({ overdue: v ? true : undefined }); track('overdue', v) }}
                    />
                </FilterGroup>

                {/* Контекст водителя — scenario fields (enum/number) */}
                {scenarioConfig && (
                    <FilterGroup title="Контекст водителя">
                        {getScenarioFilterableFields(scenarioConfig.id).map(field => (
                            <ScenarioFieldControl
                                key={field.id}
                                field={field}
                                current={filters.scenarioFields ?? []}
                                onChange={(next) => {
                                    setFilters({ scenarioFields: next.length > 0 ? next : undefined })
                                    track('scenarioField:' + field.id, next.find(f => f.fieldId === field.id)?.value ?? null)
                                }}
                            />
                        ))}
                        <SelectField
                            label="Какой парк"
                            value={filters.park ?? ''}
                            options={[{ value: '', label: 'Все' }, ...parks.map(p => ({ value: p.value, label: `${p.value} (${p.count})` }))]}
                            disabled={parks.length === 0}
                            onChange={(v) => { setFilters({ park: v || undefined }); track('park', v) }}
                        />
                    </FilterGroup>
                )}

                {/* Управление возвратом */}
                {activeScenario === 'churn' && (
                    <FilterGroup title="Управление возвратом">
                        <SelectField
                            label="Можно давать акцию?"
                            value={filters.offerAllowed ?? ''}
                            options={[
                                { value: '', label: 'Все' },
                                { value: 'yes', label: 'Да' },
                                { value: 'no', label: 'Нет' },
                                { value: 'maybe', label: 'Согласовать' },
                            ]}
                            onChange={(v) => { setFilters({ offerAllowed: (v || undefined) as TaskFilters['offerAllowed'] }); track('offerAllowed', v) }}
                        />
                    </FilterGroup>
                )}

                {/* Общие */}
                <FilterGroup title="Общие">
                    <SelectField
                        label="Источник"
                        value={(filters.source as string) ?? 'all'}
                        options={SOURCE_OPTIONS}
                        onChange={(v) => { setFilters({ source: v as TaskFilters['source'] }); track('source', v) }}
                    />
                    <SelectField
                        label="Тип"
                        value={filters.type ?? ''}
                        options={[{ value: '', label: 'Все' }, ...TASK_TYPES.map(t => ({ value: t.value, label: t.label }))]}
                        onChange={(v) => { setFilters({ type: v || undefined }); track('type', v) }}
                    />
                    <SelectField
                        label="Период"
                        value={periodPreset}
                        options={PERIOD_OPTIONS}
                        onChange={(v) => {
                            setPeriodPreset(v)
                            setFilters(getDatePreset(v))
                            track('period', v)
                        }}
                    />
                    {crmUsers.length > 0 && (
                        <SelectField
                            label="Менеджер"
                            value={filters.assigneeId ?? ''}
                            options={[{ value: '', label: 'Все' }, ...crmUsers.map(u => ({ value: u.id, label: u.name }))]}
                            onChange={(v) => { setFilters({ assigneeId: v || undefined }); track('assignee', v) }}
                        />
                    )}
                </FilterGroup>

                {/* Мета */}
                {activeScenario === 'churn' && (
                    <FilterGroup title="Данные карточки">
                        <SelectField
                            label="Источник данных"
                            value={filters.scenarioSource ?? ''}
                            options={[
                                { value: '', label: 'Все' },
                                { value: 'auto', label: 'API Яндекс' },
                                { value: 'manual', label: 'Вручную' },
                                { value: 'derived', label: 'Рассчитано' },
                            ]}
                            onChange={(v) => { setFilters({ scenarioSource: (v || undefined) as TaskFilters['scenarioSource'] }); track('scenarioSource', v) }}
                        />
                        <SelectField
                            label="Заполненность"
                            value={filters.scenarioCompleteness ?? ''}
                            options={[
                                { value: '', label: 'Все' },
                                { value: 'full', label: 'Полностью' },
                                { value: 'partial', label: 'Частично' },
                                { value: 'empty', label: 'Пустая' },
                            ]}
                            onChange={(v) => { setFilters({ scenarioCompleteness: (v || undefined) as TaskFilters['scenarioCompleteness'] }); track('scenarioCompleteness', v) }}
                        />
                    </FilterGroup>
                )}
            </DialogContent>
        </Dialog>
    )
}

// ─── Helpers ─────────────────────────────────────────────────────────

function FilterGroup({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <div className="mb-4">
            <div className="text-[11px] uppercase tracking-wide text-[#94A3B8] font-semibold mb-2">
                {title}
            </div>
            <div className="grid grid-cols-2 gap-2">
                {children}
            </div>
        </div>
    )
}

function SelectField({
    label, value, options, onChange, disabled,
}: {
    label: string
    value: string
    options: { value: string; label: string }[]
    onChange: (v: string) => void
    disabled?: boolean
}) {
    return (
        <label className="flex flex-col gap-1">
            <span className="text-[12px] text-[#64748B]">{label}</span>
            <select
                value={value}
                disabled={disabled}
                onChange={(e) => onChange(e.target.value)}
                className="bg-white border border-[#E4ECFC] rounded-lg px-2 py-1.5 text-[13px] text-[#0F172A] outline-none focus:border-[#1E40AF] cursor-pointer disabled:opacity-50"
            >
                {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
        </label>
    )
}

function ToggleField({
    label, checked, onChange,
}: {
    label: string
    checked: boolean
    onChange: (v: boolean) => void
}) {
    return (
        <label className="flex items-center gap-2 text-[13px] text-[#0F172A] cursor-pointer px-2 py-1.5 rounded-lg hover:bg-[#F8FAFC]">
            <input
                type="checkbox"
                checked={checked}
                onChange={(e) => onChange(e.target.checked)}
                className="w-4 h-4 rounded border-[#CBD5E1]"
            />
            <span>{label}</span>
        </label>
    )
}

function ScenarioFieldControl({
    field, current, onChange,
}: {
    field: ScenarioFieldDef
    current: NonNullable<TaskFilters['scenarioFields']>
    onChange: (next: NonNullable<TaskFilters['scenarioFields']>) => void
}) {
    const existing = current.find(f => f.fieldId === field.id)

    const apply = (operator: 'eq' | 'gt', value: unknown) => {
        const rest = current.filter(f => f.fieldId !== field.id)
        if (value === undefined || value === '' || value === 'all') {
            onChange(rest)
        } else {
            onChange([...rest, { fieldId: field.id, operator, value }])
        }
    }

    if (field.type === 'boolean') {
        const val = existing?.value as boolean | undefined
        return (
            <SelectField
                label={field.label}
                value={val === undefined ? 'all' : val ? 'yes' : 'no'}
                options={[
                    { value: 'all', label: 'Все' },
                    { value: 'yes', label: 'Да' },
                    { value: 'no', label: 'Нет' },
                ]}
                onChange={(v) => apply('eq', v === 'all' ? undefined : v === 'yes')}
            />
        )
    }

    if (field.type === 'enum' && field.enumOptions) {
        return (
            <SelectField
                label={field.label}
                value={(existing?.value as string) ?? 'all'}
                options={[{ value: 'all', label: 'Все' }, ...field.enumOptions]}
                onChange={(v) => apply('eq', v === 'all' ? undefined : v)}
            />
        )
    }

    if (field.type === 'number') {
        return (
            <label className="flex flex-col gap-1">
                <span className="text-[12px] text-[#64748B]">{field.label} &gt;</span>
                <input
                    type="number"
                    value={(existing?.value as number) ?? ''}
                    onChange={(e) => apply('gt', e.target.value ? Number(e.target.value) : undefined)}
                    placeholder="0"
                    className="bg-white border border-[#E4ECFC] rounded-lg px-2 py-1.5 text-[13px] text-[#0F172A] outline-none focus:border-[#1E40AF]"
                />
            </label>
        )
    }

    return null
}

function countActiveFilters(f: TaskFilters): number {
    let n = 0
    if (f.status && f.status !== 'all') n++
    if (f.priority && f.priority !== 'all') n++
    if (f.source && f.source !== 'all') n++
    if (f.type) n++
    if (f.dateFrom || f.dateTo) n++
    if (f.assigneeId) n++
    if (f.overdue) n++
    if (f.offerAllowed) n++
    if (f.park) n++
    if (f.scenarioSource) n++
    if (f.scenarioCompleteness) n++
    if (f.scenarioFields && f.scenarioFields.length > 0) n += f.scenarioFields.length
    return n
}
