'use client'

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createTask, updateTask, resolveTask, resolveEscalation } from '@/app/tasks/actions'
import { useTasksStore } from '@/store/tasks-store'
import type { CreateTaskInput, UpdateTaskInput, TaskDTO } from '@/lib/tasks/types'

/**
 * Create task mutation with optimistic store update.
 */
export function useCreateTask() {
    const queryClient = useQueryClient()
    const upsertTask = useTasksStore((s) => s.upsertTask)

    return useMutation({
        mutationFn: (input: CreateTaskInput) => createTask(input),
        onSuccess: (task) => {
            // Server truth: update store with the real entity
            upsertTask(task)
            queryClient.invalidateQueries({ queryKey: ['tasks'] })
        },
    })
}

/**
 * Update task mutation with optimistic update.
 */
export function useUpdateTask() {
    const queryClient = useQueryClient()
    const upsertTask = useTasksStore((s) => s.upsertTask)
    const tasksById = useTasksStore((s) => s.tasksById)

    return useMutation({
        mutationFn: ({ id, patch }: { id: string; patch: UpdateTaskInput }) =>
            updateTask(id, patch),

        onMutate: async ({ id, patch }) => {
            // Optimistic update: apply patch to local store immediately
            const previous = tasksById[id]
            if (previous) {
                const optimistic: TaskDTO = {
                    ...previous,
                    ...patch,
                    updatedAt: new Date().toISOString(),
                } as TaskDTO

                // Optimistic Sync
                if (patch.dueAt !== undefined) {
                    const nextDue = patch.dueAt ? new Date(patch.dueAt) : null
                    const now = new Date()
                    const currentStatus = patch.status || previous.status
                    const isTerminal = ['done', 'cancelled', 'archived'].includes(currentStatus)
                    if (nextDue && !isTerminal) {
                        if (nextDue > now && currentStatus === 'overdue') {
                            optimistic.status = 'in_progress'
                        } else if (nextDue < now && currentStatus !== 'overdue') {
                            optimistic.status = 'overdue'
                        }
                    }
                }

                upsertTask(optimistic)
            }
            return { previous }
        },

        onSuccess: (serverTask) => {
            // Server truth: replace optimistic with real state
            upsertTask(serverTask)
            queryClient.invalidateQueries({ queryKey: ['task-detail', serverTask.id] })
        },

        onError: (_err, { id }, context) => {
            // Rollback on error
            if (context?.previous) {
                upsertTask(context.previous)
            }
        },
    })
}

/**
 * Resolve (done/cancelled) mutation.
 */
export function useResolveTask() {
    const queryClient = useQueryClient()
    const upsertTask = useTasksStore((s) => s.upsertTask)
    const removeTask = useTasksStore((s) => s.removeTask)
    const tasksById = useTasksStore((s) => s.tasksById)

    return useMutation({
        mutationFn: ({ id, resolution }: { id: string; resolution: 'done' | 'cancelled' }) =>
            resolveTask(id, resolution),

        onMutate: async ({ id, resolution }) => {
            const previous = tasksById[id]
            if (previous) {
                // Optimistic: remove from active view
                removeTask(id)
            }
            return { previous }
        },

        onSuccess: (serverTask) => {
            // Server truth: re-add with final state (won't appear in active filter)
            upsertTask(serverTask)
            queryClient.invalidateQueries({ queryKey: ['tasks'] })
        },

        onError: (_err, { id }, context) => {
            if (context?.previous) {
                upsertTask(context.previous)
            }
        },
    })
}

/**
 * Resolve escalation mutation with optimistic update.
 */
export function useResolveEscalation() {
    const queryClient = useQueryClient()
    const upsertTask = useTasksStore((s) => s.upsertTask)
    const tasksById = useTasksStore((s) => s.tasksById)

    return useMutation({
        mutationFn: ({ taskId, resolutionType }: { taskId: string; resolutionType: 'contacted' | 'reassigned' | 'closed' }) =>
            resolveEscalation(taskId, resolutionType),

        onMutate: async ({ taskId }) => {
            const previous = tasksById[taskId]
            if (previous) {
                upsertTask({ ...previous, escalated: false, updatedAt: new Date().toISOString() })
            }
            return { previous }
        },

        onSuccess: (_result, { taskId }) => {
            queryClient.invalidateQueries({ queryKey: ['tasks'] })
            queryClient.invalidateQueries({ queryKey: ['task-detail', taskId] })
        },

        onError: (_err, _vars, context) => {
            if (context?.previous) {
                upsertTask(context.previous)
            }
        },
    })
}
