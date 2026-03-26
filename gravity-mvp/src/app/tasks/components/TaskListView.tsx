'use client'

import { useFilteredTasks } from '@/store/tasks-selectors'
import { Inbox, Phone, MessageSquare, FileText, Bot, AlertCircle, Calendar, AlertTriangle } from 'lucide-react'
import { useMemo } from 'react'
import type { TaskDTO } from '@/lib/tasks/types'
import { useRouter } from 'next/navigation'
import { useTasksStore } from '@/store/tasks-store'

interface DriverGroup {
    driverId: string
    driverName: string
    driverPhone: string | null
    driverLastOrderAt: string | null
    tasks: TaskDTO[]
}

export default function TaskListView() {
    const tasks = useFilteredTasks()
    const router = useRouter()
    const selectedTaskId = useTasksStore(s => s.selectedTaskId)
    const setSelectedTask = useTasksStore(s => s.setSelectedTask)

    const groups = useMemo(() => {
        const map = new Map<string, DriverGroup>()
        for (const t of tasks) {
            if (!map.has(t.driverId)) {
                map.set(t.driverId, {
                    driverId: t.driverId,
                    driverName: t.driverName,
                    driverPhone: t.driverPhone,
                    driverLastOrderAt: t.driverLastOrderAt,
                    tasks: []
                })
            }
            map.get(t.driverId)!.tasks.push(t)
        }
        return Array.from(map.values()).sort((a,b) => b.tasks.length - a.tasks.length)
    }, [tasks])

    if (tasks.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center py-20 text-center">
                <div className="w-16 h-16 rounded-2xl bg-[#f3f4f6] flex items-center justify-center mb-4">
                    <Inbox className="w-7 h-7 text-[#9ca3af]" />
                </div>
                <p className="text-[15px] font-medium text-[#6b7280]">Нет задач</p>
                <p className="text-[13px] text-[#9ca3af] mt-1">
                    Попробуйте изменить фильтры или создайте новую задачу
                </p>
            </div>
        )
    }

    return (
        <div className="flex flex-col">
            {groups.map(g => (
                <DriverRow 
                    key={g.driverId} 
                    group={g} 
                    router={router}
                    selectedTaskId={selectedTaskId}
                    onSelectTask={setSelectedTask}
                />
            ))}
        </div>
    )
}

function DriverRow({ 
    group, 
    router, 
    selectedTaskId,
    onSelectTask
}: { 
    group: DriverGroup; 
    router: any;
    selectedTaskId: string | null;
    onSelectTask: (id: string | null) => void;
}) {
    const isSelected = group.tasks.some(t => t.id === selectedTaskId)

    const handleWrite = (e: React.MouseEvent) => {
        e.stopPropagation()
        router.push(`/messages?msg=new&phone=${group.driverPhone}&driver=${group.driverId}`)
    }
    const handleCall = (e: React.MouseEvent) => {
        e.stopPropagation()
        window.open(`tel:${group.driverPhone}`, '_self')
    }
    const handleChat = (e: React.MouseEvent) => {
        e.stopPropagation()
        router.push(`/messages?focusedDriver=${group.driverId}`)
    }

    // Calculate short status
    let shortStatus = 'Нет активности'
    if (group.driverLastOrderAt) {
        const diffMs = Date.now() - new Date(group.driverLastOrderAt).getTime()
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
        if (diffDays === 0) shortStatus = 'Последний заказ: сегодня'
        else if (diffDays === 1) shortStatus = 'Последний заказ: вчера'
        else shortStatus = `Последний заказ: ${diffDays} дн. назад`
    }

    return (
        <div 
            className={`flex items-center w-full h-[56px] px-4 border-b border-[#f3f4f6] transition-colors ${
                isSelected ? 'bg-indigo-50/50' : 'bg-white hover:bg-gray-50'
            }`}
        >
            {/* Left: Avatar + Info */}
            <div className="flex items-center gap-3 w-[260px] shrink-0 overflow-hidden pr-4">
                <div className="w-9 h-9 shrink-0 bg-indigo-100 text-indigo-600 rounded-full flex items-center justify-center font-bold text-[13px]">
                    {group.driverName.charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0 flex flex-col justify-center">
                    <div className="text-[14px] font-semibold text-gray-900 truncate leading-tight">
                        {group.driverName}
                    </div>
                    <div className="text-[12px] text-gray-500 truncate leading-tight mt-0.5">
                        {shortStatus}
                    </div>
                </div>
            </div>

            {/* Middle: Tasks Row */}
            <div className="flex-1 flex items-center gap-2 overflow-x-auto custom-scrollbar no-scrollbar py-2">
                {group.tasks.map(task => (
                    <TaskPill 
                        key={task.id} 
                        task={task} 
                        isSelected={task.id === selectedTaskId}
                        onClick={() => onSelectTask(task.id === selectedTaskId ? null : task.id)}
                    />
                ))}
            </div>

            {/* Right: Quick Actions */}
            <div className="flex items-center gap-1.5 shrink-0 pl-4">
                <button 
                    onClick={handleWrite}
                    className="flex items-center justify-center gap-1.5 h-[32px] px-2.5 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg text-[13px] font-semibold transition-colors"
                >
                    <MessageSquare size={14} />
                    <span className="hidden md:inline">Написать</span>
                </button>
                <button 
                    onClick={handleCall}
                    className="flex items-center justify-center gap-1.5 h-[32px] px-2.5 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg text-[13px] font-semibold transition-colors"
                >
                    <Phone size={14} />
                    <span className="hidden md:inline">Позвонить</span>
                </button>
                <button 
                    onClick={handleChat}
                    className="flex items-center justify-center gap-1.5 h-[32px] px-2.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-600 rounded-lg text-[13px] font-semibold transition-colors"
                >
                    <MessageSquare size={14} />
                    <span className="hidden md:inline">Чат</span>
                </button>
            </div>
        </div>
    )
}

function TaskPill({ task, isSelected, onClick }: { task: TaskDTO, isSelected: boolean, onClick: () => void }) {
    // Colors - Strict 4-color standard
    let colorClass = 'bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100' // active
    
    if (task.status === 'done') {
        colorClass = 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100' // green
    } else if (task.isActive) {
        if (task.dueAt) {
            const due = new Date(task.dueAt)
            const now = new Date()
            const todayEnd = new Date()
            todayEnd.setHours(23, 59, 59, 999)
            const todayStart = new Date()
            todayStart.setHours(0,0,0,0)

            if (due < now) {
                colorClass = 'bg-red-50 text-red-700 border-red-200 hover:bg-red-100' // red
            } else if (due >= todayStart && due <= todayEnd) {
                colorClass = 'bg-yellow-50 text-yellow-700 border-yellow-200 hover:bg-yellow-100' // yellow
            }
        }
    } else {
        colorClass = 'bg-gray-50 text-gray-500 border-gray-200 hover:bg-gray-100' // archive/cancelled
    }

    // Selected ring
    const ringClass = isSelected ? 'ring-2 ring-indigo-500 border-transparent' : 'border'

    // Icon generator
    const getIcon = () => {
        if (task.source === 'auto') return <Bot size={14} />
        if (task.type === 'check_docs') return <FileText size={14} />
        if (task.type === 'call_back') return <Phone size={14} />
        if (task.type === 'payment_issue') return <Calendar size={14} /> // Money not in lucid?
        if (task.type === 'inactive_followup') return <AlertCircle size={14} />
        return <Inbox size={14} /> // default
    }

    // Label formatting
    const getLabel = () => {
        if (!task.dueAt) return task.title.substring(0, 15) + (task.title.length > 15 ? '...' : '')
        const due = new Date(task.dueAt)
        const diffMs = due.getTime() - Date.now()
        const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24))
        
        if (diffDays < 0) return 'Просрочено'
        if (diffDays === 0) return 'Сегодня'
        if (diffDays === 1) return 'Завтра'
        
        return due.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
    }

    return (
        <button 
            onClick={onClick}
            className={`flex items-center gap-1.5 h-[28px] px-2.5 rounded-full text-[12px] font-semibold whitespace-nowrap transition-all ${colorClass} ${ringClass}`}
            title={task.title}
        >
            {getIcon()}
            {getLabel()}
            {task.priority === 'high' && <AlertTriangle size={12} className="text-orange-500 ml-0.5" />}
        </button>
    )
}
