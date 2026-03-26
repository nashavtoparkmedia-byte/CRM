'use client'

import { useGroupedByStatus } from '@/store/tasks-selectors'
import { useUpdateTask } from '@/hooks/use-task-mutations'
import TaskCard from './TaskCard'
import type { TaskStatus } from '@/lib/tasks/types'
import { useState } from 'react'

const BOARD_COLUMNS: { key: TaskStatus; label: string; color: string }[] = [
    { key: 'todo', label: 'К выполнению', color: '#3b82f6' },
    { key: 'in_progress', label: 'В работе', color: '#6366f1' },
    { key: 'waiting_reply', label: 'Ждет ответа', color: '#f59e0b' },
    { key: 'done', label: 'Выполнено', color: '#22c55e' },
]

export default function TaskBoardView() {
    const grouped = useGroupedByStatus()
    const updateTask = useUpdateTask()
    const [dragOverColumn, setDragOverColumn] = useState<string | null>(null)

    const handleDragStart = (e: React.DragEvent, taskId: string) => {
        e.dataTransfer.setData('taskId', taskId)
        e.dataTransfer.effectAllowed = 'move'
    }

    const handleDragOver = (e: React.DragEvent, column: string) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setDragOverColumn(column)
    }

    const handleDragLeave = () => {
        setDragOverColumn(null)
    }

    const handleDrop = (e: React.DragEvent, newStatus: TaskStatus) => {
        e.preventDefault()
        setDragOverColumn(null)
        const taskId = e.dataTransfer.getData('taskId')
        if (taskId) {
            updateTask.mutate({ id: taskId, patch: { status: newStatus } })
        }
    }

    return (
        <div className="flex gap-2 h-full overflow-x-auto pb-4 custom-scrollbar">
            {BOARD_COLUMNS.map((col) => {
                const tasks = grouped[col.key] ?? []
                const isDragOver = dragOverColumn === col.key

                return (
                    <div
                        key={col.key}
                        className="flex flex-col min-w-[300px] w-[300px] shrink-0"
                        onDragOver={(e) => handleDragOver(e, col.key)}
                        onDragLeave={handleDragLeave}
                        onDrop={(e) => handleDrop(e, col.key)}
                    >
                        {/* Column header */}
                        <div className="flex items-center gap-2 px-3 py-2 mb-1">
                            <div
                                className="w-2.5 h-2.5 rounded-full"
                                style={{ backgroundColor: col.color }}
                            />
                            <span className="text-[14px] font-bold text-gray-700">
                                {col.label}
                            </span>
                            <span className="text-[11px] text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded font-bold">
                                {tasks.length}
                            </span>
                        </div>

                        {/* Column body */}
                        <div
                            className={`
                                flex-1 space-y-2 rounded-lg p-1.5 transition-colors min-h-[120px]
                                ${isDragOver
                                    ? 'bg-indigo-50 border-2 border-dashed border-indigo-200'
                                    : 'bg-gray-50/50 border border-transparent'
                                }
                            `}
                        >
                            {tasks.map((task) => (
                                <div
                                    key={task.id}
                                    draggable
                                    onDragStart={(e) => handleDragStart(e, task.id)}
                                    className="cursor-grab active:cursor-grabbing"
                                >
                                    <TaskCard task={task} />
                                </div>
                            ))}

                            {tasks.length === 0 && !isDragOver && (
                                <div className="flex items-center justify-center h-full text-[12px] text-[#d1d5db] py-8">
                                    Пусто
                                </div>
                            )}
                        </div>
                    </div>
                )
            })}
        </div>
    )
}
