import { useMemo } from 'react'
import { useTasksStore } from './tasks-store'
import type { TaskDTO, TaskStatus, TaskFilters } from '@/lib/tasks/types'
import { getScenarioPresets } from '@/lib/tasks/scenario-config'
import type { ScenarioData } from '@/lib/tasks/scenario-config'

/**
 * Get all tasks as sorted array (applying current filters + sort from store).
 * This is the primary selector for TaskListView.
 */
export function useFilteredTasks(): TaskDTO[] {
    const tasksById = useTasksStore((s) => s.tasksById)
    const taskIds = useTasksStore((s) => s.taskIds)
    const filters = useTasksStore((s) => s.filters)
    const sort = useTasksStore((s) => s.sort)

    return useMemo(() => {
        let tasks = taskIds.map((id) => tasksById[id]).filter(Boolean) as TaskDTO[]

        // Apply filters
        if (filters.status && filters.status !== 'all') {
            tasks = tasks.filter((t) => t.status === filters.status)
        }
        if (filters.priority && filters.priority !== 'all') {
            tasks = tasks.filter((t) => t.priority === filters.priority)
        }
        if (filters.source && filters.source !== 'all') {
            tasks = tasks.filter((t) => t.source === filters.source)
        }
        if (filters.assigneeId) {
            tasks = tasks.filter((t) => t.assigneeId === filters.assigneeId)
        }
        if (filters.driverId) {
            tasks = tasks.filter((t) => t.driverId === filters.driverId)
        }
        if (filters.hasNewReply !== undefined) {
            tasks = tasks.filter((t) => t.hasNewReply === filters.hasNewReply)
        }
        if (filters.search) {
            const q = filters.search.toLowerCase()
            tasks = tasks.filter(
                (t) =>
                    t.title.toLowerCase().includes(q) ||
                    t.driverName.toLowerCase().includes(q)
            )
        }

        // Scenario filters
        if (filters.scenario !== undefined) {
            tasks = tasks.filter((t) => t.scenario === filters.scenario)
        }
        if (filters.stage) {
            tasks = tasks.filter((t) => t.stage === filters.stage)
        }

        // Extended filters
        if (filters.type) {
            tasks = tasks.filter((t) => t.type === filters.type)
        }
        if (filters.dateFrom) {
            const from = new Date(filters.dateFrom).getTime()
            tasks = tasks.filter((t) => new Date(t.createdAt).getTime() >= from)
        }
        if (filters.dateTo) {
            const to = new Date(filters.dateTo).getTime()
            tasks = tasks.filter((t) => new Date(t.createdAt).getTime() <= to)
        }

        // Wave 1: Preset filters
        if (filters.preset) {
            tasks = applyPreset(tasks, filters.preset, filters.scenario ?? undefined)
        }

        // Wave 1: Scenario field filters
        if (filters.scenarioFields && filters.scenarioFields.length > 0) {
            tasks = applyScenarioFieldFilters(tasks, filters.scenarioFields)
        }

        // Churn ext: source meta filter
        if (filters.scenarioSource) {
            tasks = tasks.filter(t => t.scenarioMeta?.sourceTypes?.includes(filters.scenarioSource!) ?? false)
        }

        // Churn ext: completeness filter
        if (filters.scenarioCompleteness) {
            tasks = tasks.filter(t => t.scenarioMeta?.completeness === filters.scenarioCompleteness)
        }

        // Apply sort
        tasks.sort((a, b) => {
            const dir = sort.direction === 'asc' ? 1 : -1
            const aVal = a[sort.field]
            const bVal = b[sort.field]

            if (sort.field === 'priority') {
                const order: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }
                const aPri = order[a.priority] ?? 2
                const bPri = order[b.priority] ?? 2
                if (aPri !== bPri) return (aPri - bPri) * dir

                // Within same priority: SLA breach / overdue first
                const now = Date.now()
                const aUrgent = (a.slaDeadline && new Date(a.slaDeadline).getTime() < now) || a.status === 'overdue'
                const bUrgent = (b.slaDeadline && new Date(b.slaDeadline).getTime() < now) || b.status === 'overdue'
                if (aUrgent && !bUrgent) return -1
                if (!aUrgent && bUrgent) return 1

                // Within same urgency: dueAt ASC
                const aDue = a.dueAt ? new Date(a.dueAt).getTime() : Infinity
                const bDue = b.dueAt ? new Date(b.dueAt).getTime() : Infinity
                return aDue - bDue
            }

            if (aVal == null && bVal == null) return 0
            if (aVal == null) return 1
            if (bVal == null) return -1

            return aVal < bVal ? -dir : aVal > bVal ? dir : 0
        })

        return tasks
    }, [tasksById, taskIds, filters, sort])
}

/**
 * Group tasks by status — used by TaskBoardView.
 */
export function useGroupedByStatus(): Record<string, TaskDTO[]> {
    const tasks = useFilteredTasks()

    return useMemo(() => {
        const groups: Record<string, TaskDTO[]> = {
            todo: [],
            in_progress: [],
            waiting_reply: [],
            overdue: [],
            done: [],
        }

        for (const task of tasks) {
            const key = task.status as string
            if (!groups[key]) groups[key] = []
            groups[key].push(task)
        }

        return groups
    }, [tasks])
}

/**
 * Get tasks within the current timeline range — used by TaskTimelineView.
 */
export function useTimelineTasks(): TaskDTO[] {
    const tasks = useFilteredTasks()
    const range = useTasksStore((s) => s.timelineRange)

    return useMemo(() => {
        const start = new Date(range.start).getTime()
        const end = new Date(range.end).getTime()

        return tasks.filter((t) => {
            if (!t.dueAt) return false
            const due = new Date(t.dueAt).getTime()
            return due >= start && due <= end
        })
    }, [tasks, range])
}

/**
 * Get the currently selected task from store.
 */
export function useSelectedTask(): TaskDTO | null {
    const selectedTaskId = useTasksStore((s) => s.selectedTaskId)
    const tasksById = useTasksStore((s) => s.tasksById)

    return selectedTaskId ? tasksById[selectedTaskId] ?? null : null
}

/**
 * Count tasks by status — used for toolbar badges.
 */
export function useTaskCounts(): Record<string, number> {
    const tasksById = useTasksStore((s) => s.tasksById)
    const taskIds = useTasksStore((s) => s.taskIds)

    return useMemo(() => {
        const counts: Record<string, number> = {
            total: 0,
            active: 0,
            overdue: 0,
            hasNewReply: 0,
        }

        const now = Date.now()

        for (const id of taskIds) {
            const task = tasksById[id]
            if (!task) continue
            counts.total++
            if (task.isActive) counts.active++
            if (task.isActive && task.dueAt && new Date(task.dueAt).getTime() < now) counts.overdue++
            if (task.hasNewReply) counts.hasNewReply++
        }

        return counts
    }, [tasksById, taskIds])
}

// ─── Wave 1: Preset filter logic ──────────────────────────────────

function applyPreset(
    tasks: TaskDTO[],
    preset: NonNullable<TaskFilters['preset']>,
    scenarioId?: string,
): TaskDTO[] {
    const now = Date.now()
    const twoHoursMs = 2 * 60 * 60 * 1000

    switch (preset) {
        case 'hot': {
            const threshold = scenarioId
                ? getScenarioPresets(scenarioId).hotInactiveDaysThreshold ?? 7
                : 7
            return tasks.filter(t => {
                if (t.priority === 'critical' || t.priority === 'high') return true
                if (t.slaDeadline && new Date(t.slaDeadline).getTime() < now + twoHoursMs) return true
                if (t.dueAt && new Date(t.dueAt).getTime() < now + twoHoursMs) return true
                // Check inactiveDays from scenario fields preview
                const inactiveDays = t.scenarioFieldsPreview?.find(f => f.fieldId === 'inactiveDays')
                if (inactiveDays && typeof inactiveDays.value === 'number' && inactiveDays.value >= threshold) return true
                return false
            })
        }
        case 'no_contact':
            return tasks.filter(t => t.touchCount === 0 || !t.lastContactAt)
        case 'sla_burning':
            return tasks.filter(t => {
                if (t.slaDeadline && new Date(t.slaDeadline).getTime() < now + twoHoursMs) return true
                if (t.dueAt && new Date(t.dueAt).getTime() < now) return true
                return false
            })
        case 'has_reply':
            return tasks.filter(t => t.hasNewReply)
        default:
            return tasks
    }
}

// ─── Wave 1: Scenario field filter logic ──────────────────────────

function applyScenarioFieldFilters(
    tasks: TaskDTO[],
    fieldFilters: NonNullable<TaskFilters['scenarioFields']>,
): TaskDTO[] {
    return tasks.filter(task => {
        if (!task.scenarioFieldsPreview) return false
        return fieldFilters.every(filter => {
            const field = task.scenarioFieldsPreview?.find(f => f.fieldId === filter.fieldId)
            if (!field) {
                return filter.operator === 'not_exists'
            }
            if (filter.operator === 'exists') return true
            if (filter.operator === 'eq') return field.value === filter.value
            if (filter.operator === 'gt' && typeof field.value === 'number' && typeof filter.value === 'number') {
                return field.value > filter.value
            }
            if (filter.operator === 'lt' && typeof field.value === 'number' && typeof filter.value === 'number') {
                return field.value < filter.value
            }
            return true
        })
    })
}
