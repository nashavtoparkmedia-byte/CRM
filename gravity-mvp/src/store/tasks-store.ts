import { create } from 'zustand'
import type { TaskDTO, TaskFilters, TaskSort, TaskView } from '@/lib/tasks/types'

// ─── Store State ───────────────────────────────────────────────────────────

interface TasksState {
    // Normalized data
    tasksById: Record<string, TaskDTO>
    taskIds: string[]

    // UI state
    currentView: TaskView
    filters: TaskFilters
    sort: TaskSort
    selectedTaskId: string | null
    selectedDriverId: string | null
    timelineRange: { start: string; end: string }

    // Loading
    isHydrated: boolean
}

// ─── Store Actions ─────────────────────────────────────────────────────────

interface TasksActions {
    // Data hydration
    hydrateTasks: (tasks: TaskDTO[]) => void
    upsertTask: (task: TaskDTO) => void
    upsertTasks: (tasks: TaskDTO[]) => void
    removeTask: (taskId: string) => void

    // UI state
    setView: (view: TaskView) => void
    setFilters: (filters: Partial<TaskFilters>) => void
    setSort: (sort: TaskSort) => void
    setSelectedTask: (taskId: string | null) => void
    setSelectedDriver: (driverId: string | null) => void
    setTimelineRange: (range: { start: string; end: string }) => void

    // Helpers
    resetFilters: () => void
}

// ─── Default values ────────────────────────────────────────────────────────

const DEFAULT_FILTERS: TaskFilters = {
    isActive: true,
}

const DEFAULT_SORT: TaskSort = {
    field: 'createdAt',
    direction: 'desc',
}

const today = new Date()
const weekLater = new Date(today)
weekLater.setDate(weekLater.getDate() + 7)

// ─── Store ─────────────────────────────────────────────────────────────────

export const useTasksStore = create<TasksState & TasksActions>((set, get) => ({
    // Initial state
    tasksById: {},
    taskIds: [],
    currentView: 'list',
    filters: DEFAULT_FILTERS,
    sort: DEFAULT_SORT,
    selectedTaskId: null,
    selectedDriverId: null,
    timelineRange: {
        start: today.toISOString(),
        end: weekLater.toISOString(),
    },
    isHydrated: false,

    // ─── Data Hydration ────────────────────────────────────────────────

    hydrateTasks: (tasks) => {
        const tasksById: Record<string, TaskDTO> = {}
        const taskIds: string[] = []
        for (const task of tasks) {
            tasksById[task.id] = task
            taskIds.push(task.id)
        }
        set({ tasksById, taskIds, isHydrated: true })
    },

    upsertTask: (task) => {
        set((state) => {
            const tasksById = { ...state.tasksById, [task.id]: task }
            const taskIds = state.taskIds.includes(task.id)
                ? state.taskIds
                : [...state.taskIds, task.id]
            return { tasksById, taskIds }
        })
    },

    upsertTasks: (tasks) => {
        set((state) => {
            const tasksById = { ...state.tasksById }
            const taskIds = [...state.taskIds]
            for (const task of tasks) {
                tasksById[task.id] = task
                if (!taskIds.includes(task.id)) {
                    taskIds.push(task.id)
                }
            }
            return { tasksById, taskIds }
        })
    },

    removeTask: (taskId) => {
        set((state) => {
            const tasksById = { ...state.tasksById }
            delete tasksById[taskId]
            const taskIds = state.taskIds.filter((id) => id !== taskId)
            const selectedTaskId = state.selectedTaskId === taskId ? null : state.selectedTaskId
            return { tasksById, taskIds, selectedTaskId }
        })
    },

    // ─── UI State ──────────────────────────────────────────────────────

    setView: (view) => set({ currentView: view }),

    setFilters: (filters) =>
        set((state) => ({ filters: { ...state.filters, ...filters } })),

    setSort: (sort) => set({ sort }),

    setSelectedTask: (taskId) => set({ selectedTaskId: taskId }),

    setSelectedDriver: (driverId) => set({ selectedDriverId: driverId }),

    setTimelineRange: (range) => set({ timelineRange: range }),

    resetFilters: () => set({ filters: DEFAULT_FILTERS }),
}))
