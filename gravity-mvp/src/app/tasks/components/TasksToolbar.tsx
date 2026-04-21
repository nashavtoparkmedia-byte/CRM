'use client'

import { useTasksStore } from '@/store/tasks-store'
import { useTaskCounts } from '@/store/tasks-selectors'
import type { TaskView } from '@/lib/tasks/types'
import {
    List,
    Columns3,
    Calendar,
    Search,
    X,
    Bell,
    AlertTriangle,
    Plus,
    Users,
} from 'lucide-react'
import { useState, useEffect } from 'react'
import GlobalTaskCreateModal from './GlobalTaskCreateModal'
import BulkCareModal from './BulkCareModal'
import TaskListModeSwitcher from './TaskListModeSwitcher'
import TaskListColumnsSettings from './TaskListColumnsSettings'
import TaskListDensitySwitcher from './TaskListDensitySwitcher'
import TaskListExcelButtons from './TaskListExcelButtons'
import ChurnExtraFilters from './ChurnExtraFilters'
import { getSystemView, getDefaultViewId } from '@/lib/tasks/list-views'
import { useListViewStore } from '@/store/list-view-store'
import { recordUsage } from '@/lib/tasks/usage'
import { SCENARIOS, getAllScenarioOptions, getScenarioFilterableFields, getScenarioPresets } from '@/lib/tasks/scenario-config'
import type { ScenarioFieldDef } from '@/lib/tasks/scenario-config'
import { TASK_TYPES } from '@/lib/tasks/types'
import { getCrmUsers } from '@/app/tasks/actions'
import { Flame, PhoneOff, Clock, Bell as BellIcon, Settings } from 'lucide-react'

const VIEW_OPTIONS: { key: TaskView; label: string; icon: typeof List }[] = [
    { key: 'list', label: 'Список', icon: List },
    { key: 'board', label: 'Доска', icon: Columns3 },
    { key: 'timeline', label: 'Время', icon: Calendar },
]

const STATUS_OPTIONS = [
    { value: 'all', label: 'Все статусы' },
    { value: 'todo', label: 'К выполнению' },
    { value: 'in_progress', label: 'В работе' },
    { value: 'waiting_reply', label: 'Ждет ответа' },
    { value: 'overdue', label: 'Просрочено' },
    { value: 'done', label: 'Выполнено' },
]

const PRIORITY_OPTIONS = [
    { value: 'all', label: 'Все приоритеты' },
    { value: 'high', label: 'Высокий' },
    { value: 'medium', label: 'Обычный' },
]

const SOURCE_OPTIONS = [
    { value: 'all', label: 'Все источники' },
    { value: 'auto', label: 'Авто' },
    { value: 'manual', label: 'Ручная' },
    { value: 'chat', label: 'Из чата' },
]

function getDatePreset(preset: string): { dateFrom?: string; dateTo?: string } {
    const now = new Date()
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    if (preset === 'today') return { dateFrom: startOfDay.toISOString() }
    if (preset === 'week') {
        const weekAgo = new Date(startOfDay)
        weekAgo.setDate(weekAgo.getDate() - 7)
        return { dateFrom: weekAgo.toISOString() }
    }
    if (preset === 'month') {
        const monthAgo = new Date(startOfDay)
        monthAgo.setMonth(monthAgo.getMonth() - 1)
        return { dateFrom: monthAgo.toISOString() }
    }
    return { dateFrom: undefined, dateTo: undefined }
}

export default function TasksToolbar() {
    const currentView = useTasksStore((s) => s.currentView)
    const setView = useTasksStore((s) => s.setView)
    const filters = useTasksStore((s) => s.filters)
    const setFilters = useTasksStore((s) => s.setFilters)
    const resetFilters = useTasksStore((s) => s.resetFilters)
    const counts = useTaskCounts()
    const [searchOpen, setSearchOpen] = useState(false)
    const [searchValue, setSearchValue] = useState('')
    const [isCreateModalOpen, setIsCreateModalOpen] = useState(false)
    const [isBulkCareOpen, setIsBulkCareOpen] = useState(false)
    const [crmUsers, setCrmUsers] = useState<{ id: string; name: string; role: string }[]>([])
    const [periodPreset, setPeriodPreset] = useState('all')

    useEffect(() => {
        getCrmUsers().then(setCrmUsers).catch(() => {})
    }, [])

    const handleSearch = (value: string) => {
        setSearchValue(value)
        setFilters({ search: value || undefined })
    }

    const scenarioOptions = getAllScenarioOptions()
    const activeScenario = filters.scenario
    const activeScenarioConfig = activeScenario ? SCENARIOS[activeScenario] : null

    const hasActiveFilters =
        (filters.status && filters.status !== 'all') ||
        (filters.priority && filters.priority !== 'all') ||
        (filters.source && filters.source !== 'all') ||
        filters.search ||
        filters.scenario !== undefined ||
        filters.stage ||
        filters.type ||
        filters.preset ||
        filters.scenarioSource ||
        filters.scenarioCompleteness ||
        (filters.scenarioFields && filters.scenarioFields.length > 0) ||
        filters.dateFrom ||
        filters.dateTo

    return (
        <div className="flex flex-col gap-3">
            {/* Row 1: View Switcher + Quick Stats + Search */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    {/* View Switcher */}
                    <div className="flex items-center bg-[#f3f4f6] rounded-lg p-0.5">
                        {VIEW_OPTIONS.map((opt) => (
                            <button
                                key={opt.key}
                                onClick={() => setView(opt.key)}
                                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[13px] font-medium transition-all ${
                                    currentView === opt.key
                                        ? 'bg-white text-[#4f46e5] shadow-sm'
                                        : 'text-[#6b7280] hover:text-[#374151]'
                                }`}
                            >
                                <opt.icon className="w-3.5 h-3.5" />
                                {opt.label}
                            </button>
                        ))}
                    </div>

                    {/* Quick Stats */}
                    <div className="flex items-center gap-3 ml-4 text-[12px] text-[#9ca3af]">
                        <span className="flex items-center gap-1">
                            <span className="font-semibold text-[#374151]">{counts.active}</span>
                            активных
                        </span>
                        {counts.overdue > 0 && (
                            <span className="flex items-center gap-1 text-red-500">
                                <AlertTriangle className="w-3 h-3" />
                                <span className="font-semibold">{counts.overdue}</span>
                                просрочено
                            </span>
                        )}
                        {counts.hasNewReply > 0 && (
                            <span className="flex items-center gap-1 text-blue-500">
                                <Bell className="w-3 h-3" />
                                <span className="font-semibold">{counts.hasNewReply}</span>
                                с ответом
                            </span>
                        )}
                    </div>
                </div>

                {/* Search */}
                <div className="flex items-center gap-2">
                    {searchOpen ? (
                        <div className="flex items-center bg-[#f3f4f6] rounded-lg overflow-hidden">
                            <Search className="w-4 h-4 text-[#9ca3af] ml-3" />
                            <input
                                autoFocus
                                value={searchValue}
                                onChange={(e) => handleSearch(e.target.value)}
                                placeholder="Поиск по задачам..."
                                className="bg-transparent border-none outline-none text-sm px-2 py-1.5 w-[220px]"
                            />
                            <button
                                onClick={() => {
                                    setSearchOpen(false)
                                    handleSearch('')
                                }}
                                className="p-1.5 hover:bg-[#e5e7eb] rounded-md mr-1 transition-colors"
                            >
                                <X className="w-3.5 h-3.5 text-[#9ca3af]" />
                            </button>
                        </div>
                    ) : (
                        <button
                            onClick={() => setSearchOpen(true)}
                            className="p-2 rounded-lg hover:bg-[#f3f4f6] transition-colors text-[#6b7280]"
                        >
                            <Search className="w-4 h-4" />
                        </button>
                    )}
                    
                    <button
                        onClick={() => setIsBulkCareOpen(true)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#e5e7eb] text-[#374151] text-[13px] font-medium hover:bg-[#f3f4f6] transition-colors ml-2"
                    >
                        <Users className="w-4 h-4 text-[#6b7280]" />
                        Массовая забота
                    </button>
                    <button
                        onClick={() => setIsCreateModalOpen(true)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#4f46e5] text-white text-[13px] font-semibold hover:bg-[#4338ca] transition-colors ml-2 shadow-sm"
                    >
                        <Plus className="w-4 h-4" />
                        Создать задачу
                    </button>
                </div>
            </div>

            {/* Row 2: Scenario Tabs */}
            <div className="flex items-center gap-1">
                <button
                    onClick={() => {
                        setFilters({ scenario: undefined, stage: undefined })
                        void recordUsage('filter_change', { key: 'scenario', value: 'all' })
                    }}
                    className={`px-3 py-1.5 rounded-lg text-[13px] font-medium transition-all ${
                        filters.scenario === undefined
                            ? 'bg-[#4f46e5] text-white shadow-sm'
                            : 'text-[#6b7280] hover:bg-[#f3f4f6]'
                    }`}
                >
                    Все
                </button>
                {scenarioOptions.map((s) => (
                    <button
                        key={s.value}
                        onClick={() => {
                            setFilters({ scenario: s.value, stage: undefined })
                            void recordUsage('filter_change', { key: 'scenario', value: s.value })
                        }}
                        className={`px-3 py-1.5 rounded-lg text-[13px] font-medium transition-all ${
                            filters.scenario === s.value
                                ? 'bg-[#4f46e5] text-white shadow-sm'
                                : 'text-[#6b7280] hover:bg-[#f3f4f6]'
                        }`}
                    >
                        {s.label}
                    </button>
                ))}
                <button
                    onClick={() => setFilters({ scenario: null, stage: undefined })}
                    className={`px-3 py-1.5 rounded-lg text-[13px] font-medium transition-all ${
                        filters.scenario === null
                            ? 'bg-[#4f46e5] text-white shadow-sm'
                            : 'text-[#6b7280] hover:bg-[#f3f4f6]'
                    }`}
                >
                    Без сценария
                </button>

                {/* Stage filter — only when a specific scenario is selected */}
                {activeScenarioConfig && (
                    <>
                        <select
                            value={filters.stage ?? ''}
                            onChange={(e) => setFilters({ stage: e.target.value || undefined })}
                            className="ml-2 text-[13px] bg-[#f9fafb] border border-[#e5e7eb] rounded-lg px-3 py-1.5 text-[#374151] outline-none focus:border-[#4f46e5] transition-colors cursor-pointer"
                        >
                            <option value="">Все этапы</option>
                            {activeScenarioConfig.stages.map((st) => (
                                <option key={st.id} value={st.id}>{st.label}</option>
                            ))}
                        </select>
                        <a
                            href={`/settings/scenarios/${activeScenarioConfig.id}/fields`}
                            className="ml-auto flex items-center gap-1 text-[12px] text-[#4f46e5] hover:text-[#4338ca] transition-colors"
                            title="Настроить отображение полей"
                        >
                            <Settings className="w-3.5 h-3.5" />
                            Настройки полей
                        </a>
                    </>
                )}
            </div>

            {/* Row 2.25: List View controls (churn only on MVP) */}
            {activeScenario === 'churn' && currentView === 'list' && (
                <ChurnListControls />
            )}

            {/* Row 2.5: Presets */}
            <div className="flex items-center gap-1.5">
                <PresetButton
                    label="Горячие"
                    icon={<Flame className="w-3.5 h-3.5" />}
                    active={filters.preset === 'hot'}
                    onClick={() => setFilters({ preset: filters.preset === 'hot' ? undefined : 'hot' })}
                    color="red"
                />
                <PresetButton
                    label="Без контакта"
                    icon={<PhoneOff className="w-3.5 h-3.5" />}
                    active={filters.preset === 'no_contact'}
                    onClick={() => setFilters({ preset: filters.preset === 'no_contact' ? undefined : 'no_contact' })}
                    color="orange"
                />
                <PresetButton
                    label="SLA горит"
                    icon={<Clock className="w-3.5 h-3.5" />}
                    active={filters.preset === 'sla_burning'}
                    onClick={() => setFilters({ preset: filters.preset === 'sla_burning' ? undefined : 'sla_burning' })}
                    color="red"
                />
                <PresetButton
                    label="Новый ответ"
                    icon={<BellIcon className="w-3.5 h-3.5" />}
                    active={filters.preset === 'has_reply'}
                    onClick={() => setFilters({ preset: filters.preset === 'has_reply' ? undefined : 'has_reply' })}
                    color="blue"
                />

                {/* Dynamic scenario field filters */}
                {activeScenarioConfig && (
                    <DynamicScenarioFilters
                        scenarioId={activeScenarioConfig.id}
                        currentFilters={filters.scenarioFields ?? []}
                        onChange={(sf) => setFilters({ scenarioFields: sf.length > 0 ? sf : undefined })}
                    />
                )}
            </div>

            {/* Row 3: Filters */}
            <div className="flex items-center gap-2">
                <select
                    value={(filters.status as string) ?? 'all'}
                    onChange={(e) => setFilters({ status: e.target.value as any })}
                    className="text-[13px] bg-[#f9fafb] border border-[#e5e7eb] rounded-lg px-3 py-1.5 text-[#374151] outline-none focus:border-[#4f46e5] transition-colors cursor-pointer"
                >
                    {STATUS_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                </select>

                <select
                    value={(filters.priority as string) ?? 'all'}
                    onChange={(e) => setFilters({ priority: e.target.value as any })}
                    className="text-[13px] bg-[#f9fafb] border border-[#e5e7eb] rounded-lg px-3 py-1.5 text-[#374151] outline-none focus:border-[#4f46e5] transition-colors cursor-pointer"
                >
                    {PRIORITY_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                </select>

                <select
                    value={(filters.source as string) ?? 'all'}
                    onChange={(e) => setFilters({ source: e.target.value as any })}
                    className="text-[13px] bg-[#f9fafb] border border-[#e5e7eb] rounded-lg px-3 py-1.5 text-[#374151] outline-none focus:border-[#4f46e5] transition-colors cursor-pointer"
                >
                    {SOURCE_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                </select>

                {/* Type filter */}
                <select
                    value={filters.type ?? ''}
                    onChange={(e) => setFilters({ type: e.target.value || undefined })}
                    className="text-[13px] bg-[#f9fafb] border border-[#e5e7eb] rounded-lg px-3 py-1.5 text-[#374151] outline-none focus:border-[#4f46e5] transition-colors cursor-pointer"
                >
                    <option value="">Все типы</option>
                    {TASK_TYPES.map((t) => (
                        <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                </select>

                {/* Period filter */}
                <select
                    value={periodPreset}
                    onChange={(e) => {
                        setPeriodPreset(e.target.value)
                        setFilters(getDatePreset(e.target.value))
                    }}
                    className="text-[13px] bg-[#f9fafb] border border-[#e5e7eb] rounded-lg px-3 py-1.5 text-[#374151] outline-none focus:border-[#4f46e5] transition-colors cursor-pointer"
                >
                    <option value="all">Все даты</option>
                    <option value="today">Сегодня</option>
                    <option value="week">Неделя</option>
                    <option value="month">Месяц</option>
                </select>

                {/* Assignee filter */}
                {crmUsers.length > 0 && (
                    <select
                        value={filters.assigneeId ?? ''}
                        onChange={(e) => setFilters({ assigneeId: e.target.value || undefined })}
                        className="text-[13px] bg-[#f9fafb] border border-[#e5e7eb] rounded-lg px-3 py-1.5 text-[#374151] outline-none focus:border-[#4f46e5] transition-colors cursor-pointer"
                    >
                        <option value="">Все менеджеры</option>
                        {crmUsers.map((u) => (
                            <option key={u.id} value={u.id}>{u.name}</option>
                        ))}
                    </select>
                )}

                {/* Churn: filter by source of scenario data */}
                <select
                    value={filters.scenarioSource ?? ''}
                    onChange={(e) => setFilters({ scenarioSource: (e.target.value || undefined) as any })}
                    className="text-[13px] bg-[#f9fafb] border border-[#e5e7eb] rounded-lg px-3 py-1.5 text-[#374151] outline-none focus:border-[#4f46e5] transition-colors cursor-pointer"
                >
                    <option value="">Источник: все</option>
                    <option value="auto">Есть данные [API Яндекс]</option>
                    <option value="manual">Есть данные [Вручную]</option>
                    <option value="derived">Есть данные [Рассчитано]</option>
                </select>

                {/* Churn: filter by completeness of card */}
                <select
                    value={filters.scenarioCompleteness ?? ''}
                    onChange={(e) => setFilters({ scenarioCompleteness: (e.target.value || undefined) as any })}
                    className="text-[13px] bg-[#f9fafb] border border-[#e5e7eb] rounded-lg px-3 py-1.5 text-[#374151] outline-none focus:border-[#4f46e5] transition-colors cursor-pointer"
                >
                    <option value="">Заполненность: все</option>
                    <option value="full">Полностью заполнена</option>
                    <option value="partial">Частично заполнена</option>
                    <option value="empty">Пустая</option>
                </select>

                {hasActiveFilters && (
                    <button
                        onClick={resetFilters}
                        className="flex items-center gap-1 text-[12px] text-[#6b7280] hover:text-[#ef4444] transition-colors ml-1"
                    >
                        <X className="w-3 h-3" />
                        Сбросить
                    </button>
                )}
            </div>

            {isCreateModalOpen && (
                <GlobalTaskCreateModal onClose={() => setIsCreateModalOpen(false)} />
            )}
            {isBulkCareOpen && (
                <BulkCareModal onClose={() => setIsBulkCareOpen(false)} />
            )}
        </div>
    )
}

// ─── Churn List Controls (mode switcher + columns settings) ─────

function ChurnListControls() {
    const activeViewMap = useListViewStore(s => s.activeViewIdByScenario)
    const activeChurnViewId = activeViewMap['churn'] ?? getDefaultViewId('churn')
    const activeView = getSystemView(activeChurnViewId) ?? getSystemView(getDefaultViewId('churn'))
    if (!activeView) return null

    return (
        <div className="flex items-center gap-3 flex-wrap">
            <TaskListModeSwitcher scenario="churn" />
            <TaskListDensitySwitcher scenario="churn" />
            <TaskListColumnsSettings view={activeView} />
            <TaskListExcelButtons />
            <div className="h-6 w-px bg-[#E4ECFC]" />
            <ChurnExtraFilters />
        </div>
    )
}

// ─── Preset Button ────────────────────────────────────────────────

function PresetButton({
    label,
    icon,
    active,
    onClick,
    color,
}: {
    label: string
    icon: React.ReactNode
    active: boolean
    onClick: () => void
    color: 'red' | 'orange' | 'blue'
}) {
    const colors = {
        red: active ? 'bg-red-100 text-red-700 border-red-300' : 'bg-white text-gray-600 border-gray-200 hover:bg-red-50',
        orange: active ? 'bg-orange-100 text-orange-700 border-orange-300' : 'bg-white text-gray-600 border-gray-200 hover:bg-orange-50',
        blue: active ? 'bg-blue-100 text-blue-700 border-blue-300' : 'bg-white text-gray-600 border-gray-200 hover:bg-blue-50',
    }

    return (
        <button
            onClick={onClick}
            className={`flex items-center gap-1 px-2.5 py-1 rounded-full border text-[12px] font-medium transition-all ${colors[color]}`}
        >
            {icon}
            {label}
        </button>
    )
}

// ─── Dynamic Scenario Filters ─────────────────────────────────────

function DynamicScenarioFilters({
    scenarioId,
    currentFilters,
    onChange,
}: {
    scenarioId: string
    currentFilters: NonNullable<import('@/lib/tasks/types').TaskFilters['scenarioFields']>
    onChange: (filters: NonNullable<import('@/lib/tasks/types').TaskFilters['scenarioFields']>) => void
}) {
    const fields = getScenarioFilterableFields(scenarioId)
    if (fields.length === 0) return null

    const updateField = (fieldId: string, operator: string, value: unknown) => {
        const rest = currentFilters.filter(f => f.fieldId !== fieldId)
        if (value === undefined || value === '' || value === 'all') {
            onChange(rest)
        } else {
            onChange([...rest, { fieldId, operator: operator as any, value }])
        }
    }

    const getValue = (fieldId: string) => {
        return currentFilters.find(f => f.fieldId === fieldId)?.value
    }

    return (
        <div className="flex items-center gap-1.5 ml-2 pl-2 border-l border-gray-200">
            {fields.map(field => (
                <ScenarioFieldFilter
                    key={field.id}
                    field={field}
                    value={getValue(field.id)}
                    onChange={(val) => updateField(field.id, field.type === 'number' ? 'gt' : 'eq', val)}
                />
            ))}
        </div>
    )
}

function ScenarioFieldFilter({
    field,
    value,
    onChange,
}: {
    field: ScenarioFieldDef
    value: unknown
    onChange: (val: unknown) => void
}) {
    if (field.type === 'boolean') {
        const current = value as boolean | undefined
        return (
            <select
                value={current === undefined ? 'all' : current ? 'yes' : 'no'}
                onChange={(e) => {
                    if (e.target.value === 'all') onChange(undefined)
                    else onChange(e.target.value === 'yes')
                }}
                className="text-[12px] bg-[#f9fafb] border border-[#e5e7eb] rounded-lg px-2 py-1 text-[#374151] outline-none focus:border-[#4f46e5] cursor-pointer"
            >
                <option value="all">{field.label}: все</option>
                <option value="yes">{field.label}: да</option>
                <option value="no">{field.label}: нет</option>
            </select>
        )
    }

    if (field.type === 'enum' && field.enumOptions) {
        return (
            <select
                value={(value as string) ?? 'all'}
                onChange={(e) => onChange(e.target.value === 'all' ? undefined : e.target.value)}
                className="text-[12px] bg-[#f9fafb] border border-[#e5e7eb] rounded-lg px-2 py-1 text-[#374151] outline-none focus:border-[#4f46e5] cursor-pointer"
            >
                <option value="all">{field.label}: все</option>
                {field.enumOptions.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                ))}
            </select>
        )
    }

    if (field.type === 'number') {
        return (
            <div className="flex items-center gap-1">
                <span className="text-[12px] text-gray-500">{field.label} &gt;</span>
                <input
                    type="number"
                    value={(value as number) ?? ''}
                    onChange={(e) => onChange(e.target.value ? Number(e.target.value) : undefined)}
                    placeholder="0"
                    className="w-[50px] text-[12px] bg-[#f9fafb] border border-[#e5e7eb] rounded-lg px-2 py-1 text-[#374151] outline-none focus:border-[#4f46e5]"
                />
            </div>
        )
    }

    return null
}
