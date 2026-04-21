'use client'

import { useEffect } from 'react'
import { useTasksQuery } from '@/hooks/use-tasks-query'
import { useTasksStore } from '@/store/tasks-store'
import TasksToolbar from './components/TasksToolbar'
import TaskListView from './components/TaskListView'
import TaskBoardView from './components/TaskBoardView'
import TaskTimelineView from './components/TaskTimelineView'
import TaskDetailsPane from './components/TaskDetailsPane'
import TaskToastContainer from './components/TaskToastContainer'
import { recordUsage } from '@/lib/tasks/usage'
import { Loader2 } from 'lucide-react'

export default function TasksPage() {
    const { isLoading, isError, error } = useTasksQuery({ isActive: true })
    const currentView = useTasksStore((s) => s.currentView)
    const selectedTaskId = useTasksStore((s) => s.selectedTaskId)

    // Rollout observation: one event per page mount
    useEffect(() => {
        void recordUsage('tasks_list_opened')
    }, [])

    return (
        <div className="flex flex-col min-h-[calc(100vh-theme(spacing.16))] p-6">
            {/* Page Header */}
            <div className="mb-5">
                <h1 className="text-[22px] font-bold text-[#1f2937] tracking-tight">
                    Задачи
                </h1>
                <p className="text-[13px] text-[#9ca3af] mt-0.5">
                    Проактивное управление водителями
                </p>
            </div>

            {/* Toolbar */}
            <TasksToolbar />

            {/* Main Content Area */}
            <div className="flex flex-1 mt-5 overflow-visible rounded-2xl border border-[#e5e7eb] bg-white">
                {/* View Area */}
                <div className="flex-1 overflow-visible p-4 custom-scrollbar">
                    {isLoading ? (
                        <div className="flex items-center justify-center h-full">
                            <div className="flex flex-col items-center gap-3">
                                <Loader2 className="w-6 h-6 text-[#4f46e5] animate-spin" />
                                <span className="text-[13px] text-[#9ca3af]">Загрузка задач...</span>
                            </div>
                        </div>
                    ) : isError ? (
                        <div className="flex items-center justify-center h-full">
                            <div className="text-center">
                                <p className="text-[15px] font-medium text-red-500">Ошибка загрузки</p>
                                <p className="text-[13px] text-[#9ca3af] mt-1">
                                    {(error as Error)?.message ?? 'Попробуйте обновить страницу'}
                                </p>
                            </div>
                        </div>
                    ) : (
                        <>
                            {currentView === 'list' && <TaskListView />}
                            {currentView === 'board' && <TaskBoardView />}
                            {currentView === 'timeline' && <TaskTimelineView />}
                        </>
                    )}
                </div>

                {/* Details Pane (conditional) */}
                {selectedTaskId && <TaskDetailsPane />}
            </div>

            {/* Inline-action feedback toasts */}
            <TaskToastContainer />
        </div>
    )
}
