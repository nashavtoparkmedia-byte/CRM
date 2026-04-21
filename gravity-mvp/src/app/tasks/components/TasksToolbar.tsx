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
    Flame,
    PhoneOff,
    Clock,
    Bell as BellIcon,
    Settings,
} from 'lucide-react'
import { useState, useEffect } from 'react'
import GlobalTaskCreateModal from './GlobalTaskCreateModal'
import BulkCareModal from './BulkCareModal'
import TaskListModeSwitcher from './TaskListModeSwitcher'
import TaskListColumnsSettings from './TaskListColumnsSettings'
import TaskListDensitySwitcher from './TaskListDensitySwitcher'
import TaskListExcelButtons from './TaskListExcelButtons'
import TaskListFiltersPopover from './TaskListFiltersPopover'
import { getSystemView, getDefaultViewId } from '@/lib/tasks/list-views'
import { useListViewStore } from '@/store/list-view-store'
import { recordUsage } from '@/lib/tasks/usage'
import { SCENARIOS, getAllScenarioOptions } from '@/lib/tasks/scenario-config'
import { getCrmUsers } from '@/app/tasks/actions'

const VIEW_OPTIONS: { key: TaskView; label: string; icon: typeof List }[] = [
    { key: 'list', label: 'Список', icon: List },
    { key: 'board', label: 'Доска', icon: Columns3 },
    { key: 'timeline', label: 'Время', icon: Calendar },
]

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
    const isChurnList = activeScenario === 'churn' && currentView === 'list'

    const activeViewMap = useListViewStore(s => s.activeViewIdByScenario)
    const activeChurnViewId = activeViewMap['churn'] ?? getDefaultViewId('churn')
    const activeChurnView = getSystemView(activeChurnViewId) ?? getSystemView(getDefaultViewId('churn'))

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
        filters.dateTo ||
        filters.overdue ||
        filters.offerAllowed ||
        filters.park ||
        filters.assigneeId

    return (
        <div className="flex flex-col gap-3">
            {/* ── Row 1 ─ view switcher + mode + density  |  stats  |  search + excel + create ── */}
            <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-2 flex-wrap">
                    {/* View Switcher: Список / Доска / Время */}
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

                    {/* Churn-list-only controls — next to view switcher, as requested */}
                    {isChurnList && (
                        <>
                            <TaskListModeSwitcher scenario="churn" />
                            <TaskListDensitySwitcher scenario="churn" />
                        </>
                    )}

                    {/* Quick Stats */}
                    <div className="flex items-center gap-3 ml-2 text-[12px] text-[#9ca3af]">
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

                {/* Right side: Search, Excel (churn+list), Bulk, Create */}
                <div className="flex items-center gap-2 flex-wrap">
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

                    {/* Excel — right side of toolbar, per TЗ */}
                    {isChurnList && <TaskListExcelButtons />}

                    <button
                        onClick={() => setIsBulkCareOpen(true)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#e5e7eb] text-[#374151] text-[13px] font-medium hover:bg-[#f3f4f6] transition-colors"
                    >
                        <Users className="w-4 h-4 text-[#6b7280]" />
                        Массовая забота
                    </button>
                    <button
                        onClick={() => setIsCreateModalOpen(true)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#4f46e5] text-white text-[13px] font-semibold hover:bg-[#4338ca] transition-colors shadow-sm"
                    >
                        <Plus className="w-4 h-4" />
                        Создать задачу
                    </button>
                </div>
            </div>

            {/* ── Row 2 ─ scenario tabs + stage + column settings + scenario field settings link ── */}
            <div className="flex items-center gap-1 flex-wrap">
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

                {/* Stage select — only when a specific scenario is picked */}
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

                        {/* Column settings lives with stage / scenario tools, as it scopes to the active view */}
                        {isChurnList && activeChurnView && (
                            <TaskListColumnsSettings view={activeChurnView} />
                        )}

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

            {/* ── Row 3 ─ 4 visible presets + "Фильтры" popover + reset ── */}
            <div className="flex items-center gap-1.5 flex-wrap">
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

                <div className="h-5 w-px bg-[#E4ECFC] mx-1" />

                <TaskListFiltersPopover crmUsers={crmUsers} />

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
