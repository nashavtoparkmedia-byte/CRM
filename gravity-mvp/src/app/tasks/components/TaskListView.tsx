'use client'

import { useFilteredTasks } from '@/store/tasks-selectors'
import { Inbox } from 'lucide-react'
import { useTasksStore } from '@/store/tasks-store'
import { useListViewStore } from '@/store/list-view-store'
import TaskListRow from './TaskListRow'
import TaskCaseRow from './TaskCaseRow'
import TaskCaseListHeader from './TaskCaseListHeader'
import TaskControlChips from './TaskControlChips'
import { resolveLayout } from '@/lib/tasks/list-columns'
import { getDefaultViewId, getSystemView } from '@/lib/tasks/list-views'
import { getScenario } from '@/lib/tasks/scenario-config'
import {
    primarySignal,
    hasAnySignal,
    CONTROL_SIGNAL_LABELS,
    type ControlSignal,
} from '@/lib/tasks/control-signals'
import type { TaskDTO, TaskSortField, TaskSortDirection } from '@/lib/tasks/types'
import { useMemo, useState } from 'react'

export default function TaskListView() {
    const tasks = useFilteredTasks()
    const selectedTaskId = useTasksStore(s => s.selectedTaskId)
    const setSelectedTask = useTasksStore(s => s.setSelectedTask)
    const activeScenario = useTasksStore(s => s.filters.scenario)
    const isChurnActive = activeScenario === 'churn'

    // Active view + overrides for the churn scenario
    const activeViewMap = useListViewStore(s => s.activeViewIdByScenario)
    const overridesByViewId = useListViewStore(s => s.overridesByViewId)
    const controlSignalFilter = useListViewStore(s => s.controlSignalFilter)

    const activeChurnViewId = activeViewMap['churn'] ?? getDefaultViewId('churn')
    const activeChurnView = getSystemView(activeChurnViewId) ?? getSystemView(getDefaultViewId('churn'))
    const churnOverrides = activeChurnView ? overridesByViewId[activeChurnView.id] : undefined

    const churnLayout = useMemo(() => {
        if (!activeChurnView) return null
        return resolveLayout(activeChurnView, churnOverrides)
    }, [activeChurnView, churnOverrides])

    // Client-side sort state for table mode (overrides server sort)
    const [tableSortField, setTableSortField] = useState<TaskSortField | null>(null)
    const [tableSortDirection, setTableSortDirection] = useState<TaskSortDirection>('desc')

    const mode = activeChurnView?.mode ?? 'operational'
    const grouping = activeChurnView?.grouping ?? 'stage'

    // Apply mode-specific filters (control signals) and sort (table only)
    const pipelinedTasks = useMemo(() => {
        if (!isChurnActive || !activeChurnView) return tasks

        let list = tasks

        if (mode === 'control' && controlSignalFilter.length > 0) {
            list = list.filter(t => hasAnySignal(t, controlSignalFilter))
        }

        if (mode === 'table' && tableSortField) {
            list = sortTasksBy(list, tableSortField, tableSortDirection)
        }

        return list
    }, [isChurnActive, activeChurnView, mode, tasks, controlSignalFilter, tableSortField, tableSortDirection])

    const groups = useMemo(() => {
        if (!isChurnActive || !activeChurnView) return null
        return buildGroups(pipelinedTasks, grouping, activeScenario ?? null)
    }, [isChurnActive, activeChurnView, grouping, pipelinedTasks, activeScenario])

    const hideScenarioTag = typeof activeScenario === 'string'

    if (pipelinedTasks.length === 0) {
        return (
            <div className="flex flex-col gap-3">
                {isChurnActive && mode === 'control' && <TaskControlChips />}
                <div className="flex flex-col items-center justify-center py-20 text-center">
                    <div className="w-16 h-16 rounded-2xl bg-[#f3f4f6] flex items-center justify-center mb-4">
                        <Inbox className="w-7 h-7 text-[#9ca3af]" />
                    </div>
                    <p className="text-[15px] font-medium text-[#6b7280]">Нет задач</p>
                    <p className="text-[13px] text-[#9ca3af] mt-1">
                        {controlSignalFilter.length > 0
                            ? 'Под выбранные сигналы сейчас никто не попадает'
                            : 'Попробуйте изменить фильтры или создайте новую задачу'}
                    </p>
                </div>
            </div>
        )
    }

    // ─── CaseRow path (churn only) ───────────────────────────────────
    if (isChurnActive && churnLayout && activeChurnView) {
        const isTable = mode === 'table'

        return (
            <div className="flex flex-col gap-2">
                {mode === 'control' && <TaskControlChips />}

                <div className="flex flex-col overflow-x-auto border-t border-[#EEF2FF]">
                    {isTable && (
                        <TaskCaseListHeader
                            layout={churnLayout}
                            sortField={tableSortField}
                            sortDirection={tableSortDirection}
                            onSortChange={(f, d) => {
                                setTableSortField(f)
                                setTableSortDirection(d)
                            }}
                        />
                    )}

                    {groups && groups.length > 0 ? (
                        groups.map(group => (
                            <div key={group.key}>
                                {group.showHeader && (
                                    <GroupHeader label={group.label} count={group.tasks.length} />
                                )}
                                {group.tasks.map(task => (
                                    <TaskCaseRow
                                        key={task.id}
                                        task={task}
                                        layout={churnLayout}
                                        isSelected={task.id === selectedTaskId}
                                        onSelect={() => setSelectedTask(task.id === selectedTaskId ? null : task.id)}
                                    />
                                ))}
                            </div>
                        ))
                    ) : (
                        pipelinedTasks.map(task => (
                            <TaskCaseRow
                                key={task.id}
                                task={task}
                                layout={churnLayout}
                                isSelected={task.id === selectedTaskId}
                                onSelect={() => setSelectedTask(task.id === selectedTaskId ? null : task.id)}
                            />
                        ))
                    )}
                </div>
            </div>
        )
    }

    // ─── Legacy path for non-churn scenarios ─────────────────────────
    return (
        <div className="flex flex-col">
            {pipelinedTasks.map(task => (
                <TaskListRow
                    key={task.id}
                    task={task}
                    isSelected={task.id === selectedTaskId}
                    onSelect={() => setSelectedTask(task.id === selectedTaskId ? null : task.id)}
                    hideScenarioTag={hideScenarioTag}
                />
            ))}
        </div>
    )
}

// ─── Helpers ─────────────────────────────────────────────────────────

function GroupHeader({ label, count }: { label: string; count: number }) {
    return (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-[#F8FAFC] border-b border-[#EEF2FF] text-[11px] uppercase tracking-wide font-semibold text-[#64748B]">
            <span>{label}</span>
            <span className="text-[#CBD5E1] font-normal">· {count}</span>
        </div>
    )
}

interface RowGroup {
    key: string
    label: string
    tasks: TaskDTO[]
    showHeader: boolean
}

function buildGroups(
    tasks: TaskDTO[],
    grouping: 'stage' | 'control_signal' | 'none',
    scenarioId: string | null,
): RowGroup[] {
    if (grouping === 'none') {
        return [{ key: '_all', label: '', tasks, showHeader: false }]
    }

    const groupsMap = new Map<string, TaskDTO[]>()
    const order: string[] = []

    if (grouping === 'stage' && scenarioId) {
        const scenario = getScenario(scenarioId)
        const stages = scenario?.stages ?? []
        for (const s of stages) order.push(s.id)
        order.push('_no_stage')

        for (const t of tasks) {
            const key = t.stage ?? '_no_stage'
            if (!groupsMap.has(key)) groupsMap.set(key, [])
            groupsMap.get(key)!.push(t)
        }

        return order
            .filter(k => groupsMap.has(k))
            .map(k => ({
                key: k,
                label: k === '_no_stage'
                    ? 'Без этапа'
                    : scenario?.stages.find(s => s.id === k)?.label ?? k,
                tasks: groupsMap.get(k)!,
                showHeader: true,
            }))
    }

    if (grouping === 'control_signal') {
        // Health-first order: keep problems on top
        const signalOrder: (ControlSignal | '_healthy')[] = ['overdue', 'has_reply', 'no_next_action', 'stale', '_healthy']

        for (const t of tasks) {
            const s = primarySignal(t)
            const key = s ?? '_healthy'
            if (!groupsMap.has(key)) groupsMap.set(key, [])
            groupsMap.get(key)!.push(t)
        }

        return signalOrder
            .filter(k => groupsMap.has(k))
            .map(k => ({
                key: k,
                label: k === '_healthy' ? 'Без проблем' : CONTROL_SIGNAL_LABELS[k as ControlSignal],
                tasks: groupsMap.get(k)!,
                showHeader: true,
            }))
    }

    return [{ key: '_all', label: '', tasks, showHeader: false }]
}

function sortTasksBy(tasks: TaskDTO[], field: TaskSortField, dir: TaskSortDirection): TaskDTO[] {
    const mul = dir === 'asc' ? 1 : -1
    const PRI: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }

    return [...tasks].sort((a, b) => {
        let va: string | number | null
        let vb: string | number | null
        switch (field) {
            case 'fullName':
                va = a.driverName ?? ''
                vb = b.driverName ?? ''
                break
            case 'stage':
                va = a.stage ?? ''
                vb = b.stage ?? ''
                break
            case 'priority':
                va = PRI[a.priority] ?? 99
                vb = PRI[b.priority] ?? 99
                break
            case 'lastContactAt':
                va = a.lastContactAt ? new Date(a.lastContactAt).getTime() : null
                vb = b.lastContactAt ? new Date(b.lastContactAt).getTime() : null
                break
            case 'nextActionAt':
                va = a.nextActionAt ? new Date(a.nextActionAt).getTime() : null
                vb = b.nextActionAt ? new Date(b.nextActionAt).getTime() : null
                break
            default:
                return 0
        }
        // nulls last
        if (va === null && vb === null) return 0
        if (va === null) return 1
        if (vb === null) return -1
        if (va < vb) return -1 * mul
        if (va > vb) return 1 * mul
        return 0
    })
}

