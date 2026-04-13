import { useMemo } from 'react'
import { useTasksStore } from './tasks-store'
import type { TaskDTO, TaskStatus } from '@/lib/tasks/types'

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

        // Apply sort
        tasks.sort((a, b) => {
            const dir = sort.direction === 'asc' ? 1 : -1
            const aVal = a[sort.field]
            const bVal = b[sort.field]

            if (aVal == null && bVal == null) return 0
            if (aVal == null) return 1
            if (bVal == null) return -1

            if (sort.field === 'priority') {
                const order = { critical: 0, high: 1, medium: 2, low: 3 }
                return (order[aVal as keyof typeof order] - order[bVal as keyof typeof order]) * dir
            }

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
