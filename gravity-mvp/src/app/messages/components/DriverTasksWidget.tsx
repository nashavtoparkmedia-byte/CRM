'use client'

import { useEffect, useState } from 'react'
import { getDriverActiveTasks } from '@/app/tasks/actions'
import type { TaskDTO } from '@/lib/tasks/types'
import {
    CheckSquare,
    AlertTriangle,
    Clock,
    ChevronRight,
    Loader2,
} from 'lucide-react'
import Link from 'next/link'
import TaskCard from '@/app/tasks/components/TaskCard'

export default function DriverTasksWidget({ driverId }: { driverId: string }) {
    const [tasks, setTasks] = useState<TaskDTO[]>([])
    const [counts, setCounts] = useState({ active: 0, overdue: 0 })
    const [isLoading, setIsLoading] = useState(true)

    // Using simple fetch here instead of React Query to keep the widget lightweight and decoupled
    // from the main Tasks query scope, though RQ could be used here too.
    useEffect(() => {
        let isMounted = true

        async function fetchTasks() {
            try {
                setIsLoading(true)
                const res = await getDriverActiveTasks(driverId)
                if (isMounted) {
                    setTasks(res.tasks)
                    setCounts(res.counts)
                }
            } catch (err) {
                console.error('Failed to load tasks for widget', err)
            } finally {
                if (isMounted) setIsLoading(false)
            }
        }

        fetchTasks()

        return () => {
            isMounted = false
        }
    }, [driverId])

    if (isLoading) {
        return (
            <div className="flex flex-col gap-3 p-4">
                <div className="flex items-center gap-2 mb-2">
                    <CheckSquare className="w-4 h-4 text-[#9ca3af]" />
                    <span className="text-[14px] font-semibold text-[#374151]">Задачи</span>
                </div>
                {[1, 2].map((i) => (
                    <div key={i} className="h-16 bg-[#f3f4f6] rounded-xl animate-pulse" />
                ))}
            </div>
        )
    }

    return (
        <div className="flex flex-col">
            <div className="flex items-center justify-between px-4 py-3">
                <div className="flex items-center gap-2">
                    <CheckSquare className="w-4 h-4 text-[#4f46e5]" />
                    <span className="text-[14px] font-semibold text-[#1f2937]">Задачи</span>
                    {counts.active > 0 && (
                        <span className="text-[11px] bg-[#eef2ff] text-[#4f46e5] px-1.5 py-0.5 rounded-md font-bold">
                            {counts.active}
                        </span>
                    )}
                </div>

                {counts.overdue > 0 && (
                    <span className="flex items-center gap-1 text-[11px] text-red-500 font-bold bg-red-50 px-1.5 py-0.5 rounded-md">
                        <AlertTriangle className="w-3 h-3" />
                        {counts.overdue}
                    </span>
                )}
            </div>

            <div className="px-3 pb-3 space-y-1.5">
                {tasks.length > 0 ? (
                    <>
                        {tasks.map((task) => (
                            <TaskCard key={task.id} task={task} compact />
                        ))}

                        {counts.active > tasks.length && (
                            <Link
                                href={`/tasks?driverId=${driverId}`}
                                className="flex items-center justify-center gap-1 mt-2 text-[12px] font-medium text-[#4f46e5] hover:bg-[#eef2ff] py-1.5 rounded-lg transition-colors"
                            >
                                Посмотреть все ({counts.active})
                                <ChevronRight className="w-3.5 h-3.5" />
                            </Link>
                        )}
                    </>
                ) : (
                    <div className="flex flex-col items-center justify-center py-4 bg-[#f9fafb] rounded-xl border border-dashed border-[#e5e7eb]">
                        <CheckSquare className="w-5 h-5 text-[#d1d5db] mb-1" />
                        <span className="text-[12px] text-[#9ca3af]">Нет активных задач</span>
                    </div>
                )}
            </div>
        </div>
    )
}
