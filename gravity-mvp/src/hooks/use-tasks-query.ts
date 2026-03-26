'use client'

import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { getTasks, getTaskDetails } from '@/app/tasks/actions'
import { useTasksStore } from '@/store/tasks-store'
import type { TaskFilters, TaskSort, TaskDetailDTO } from '@/lib/tasks/types'

/**
 * Main query hook for the active task scope.
 * Hydrates the Zustand store on success.
 */
export function useTasksQuery(filters: TaskFilters = {}, sort?: TaskSort) {
    const hydrateTasks = useTasksStore((s) => s.hydrateTasks)
    const storeFilters = useTasksStore((s) => s.filters)
    const storeSort = useTasksStore((s) => s.sort)

    const activeFilters = { ...storeFilters, ...filters }
    const activeSort = sort ?? storeSort

    const query = useQuery({
        queryKey: ['tasks', activeFilters, activeSort],
        queryFn: () => getTasks(activeFilters, activeSort),
        staleTime: 30_000,
        refetchOnWindowFocus: true,
        refetchInterval: 60000,
    })

    // Hydrate store when data arrives
    useEffect(() => {
        if (query.data?.tasks) {
            hydrateTasks(query.data.tasks)
        }
    }, [query.data, hydrateTasks])

    return query
}

/**
 * Detail query for TaskDetailsPane.
 * Protects against race conditions: only applies data if the task is still selected.
 */
export function useTaskDetailQuery(taskId: string | null) {
    const selectedTaskId = useTasksStore((s) => s.selectedTaskId)
    const requestedIdRef = useRef(taskId)

    // Track the ID we requested
    useEffect(() => {
        requestedIdRef.current = taskId
    }, [taskId])

    const query = useQuery<TaskDetailDTO | null>({
        queryKey: ['task-detail', taskId],
        queryFn: () => (taskId ? getTaskDetails(taskId) : Promise.resolve(null)),
        enabled: !!taskId,
        staleTime: 15_000,
        refetchInterval: 15000,
    })

    // Race condition guard: only return data if it matches current selection
    const isStale = query.data && query.data.id !== selectedTaskId
    
    return {
        ...query,
        data: isStale ? null : query.data,
        isStale,
    }
}
