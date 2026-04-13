'use client'

import type { TaskDTO } from '@/lib/tasks/types'
import { useTasksStore } from '@/store/tasks-store'
import { useResolveTask, useUpdateTask } from '@/hooks/use-task-mutations'
import { getScenario, getStage } from '@/lib/tasks/scenario-config'
import {
    Check,
    MessageSquare,
    Phone,
    Bot,
    FileText,
    Inbox,
    AlertCircle,
    Calendar,
    AlertTriangle,
    Plus,
    Zap,
    User,
    MousePointerClick
} from 'lucide-react'
import { useRouter } from 'next/navigation'

const PRIORITY_CONFIG: Record<string, { label: string; color: string }> = {
    critical: { label: 'Критичный', color: 'text-red-600 bg-red-50' },
    high: { label: 'Высокий', color: 'text-orange-600 bg-orange-50' },
    medium: { label: 'Обычный', color: 'text-blue-600 bg-blue-50' },
    low: { label: 'Низкий', color: 'text-gray-600 bg-gray-50' },
}

const SOURCE_LABELS: Record<string, string> = {
    auto: 'Автоматическая',
    manual: 'Ручная',
    chat: 'Из чата',
}

interface TaskCardProps {
    task: TaskDTO
    compact?: boolean // currently Board is always compact, this param is legacy but kept for reference
}

export default function TaskCard({ task }: TaskCardProps) {
    const setSelectedTask = useTasksStore((s) => s.setSelectedTask)
    const selectedTaskId = useTasksStore((s) => s.selectedTaskId)
    const resolveTask = useResolveTask()
    const updateTask = useUpdateTask()
    const router = useRouter()

    const isSelected = selectedTaskId === task.id
    const prio = PRIORITY_CONFIG[task.priority] ?? PRIORITY_CONFIG.medium

    // Calculate urgency / due logic
    let isOverdue = false
    let isToday = false
    let dueLabel = ''

    if (task.dueAt) {
        const d = new Date(task.dueAt)
        const now = new Date()
        const todayEnd = new Date()
        todayEnd.setHours(23, 59, 59, 999)
        const diffMs = d.getTime() - now.getTime()
        const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24))

        if (diffDays < 0) {
            isOverdue = true
            dueLabel = 'Просрочено'
        } else if (d <= todayEnd) {
            isToday = true
            dueLabel = 'Сегодня'
        } else if (diffDays === 1) {
            dueLabel = 'Завтра'
        } else {
            dueLabel = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
        }
    }

    const getIcon = () => {
        if (task.source === 'auto') return <Bot size={12} className="text-gray-500" />
        if (task.type === 'check_docs') return <FileText size={12} className="text-blue-500" />
        if (task.type === 'call_back') return <Phone size={12} className="text-green-500" />
        if (task.type === 'payment_issue') return <Calendar size={12} className="text-amber-500" />
        if (task.type === 'inactive_followup') return <AlertCircle size={12} className="text-red-500" />
        return <Inbox size={12} className="text-gray-500" />
    }

    const getSourceIcon = () => {
        if (task.source === 'auto') return <Zap size={14} className="text-blue-400 fill-blue-50" />
        if (task.source === 'chat') return <MessageSquare size={14} className="text-gray-400 fill-gray-50" />
        return <MousePointerClick size={15} className="text-gray-400" />
    }

    const handleResolve = (e: React.MouseEvent) => {
        e.stopPropagation()
        resolveTask.mutate({ id: task.id, resolution: 'done' })
    }

    const handleWrite = (e: React.MouseEvent) => {
        e.stopPropagation()
        router.push(`/messages?msg=new&phone=${task.driverPhone}&driver=${task.driverId}`)
    }
    const handleCall = (e: React.MouseEvent) => {
        e.stopPropagation()
        window.open(`tel:${task.driverPhone}`, '_self')
    }
    const handleChat = (e: React.MouseEvent) => {
        e.stopPropagation()
        router.push(`/messages?focusedDriver=${task.driverId}`)
    }

    // Color Bar Logic
    let barColor = 'bg-blue-500' // active
    if (task.status === 'done') barColor = 'bg-emerald-500'
    else if (isOverdue) barColor = 'bg-red-500'
    else if (isToday) barColor = 'bg-yellow-400'

    return (
        <div
            onClick={() => setSelectedTask(task.id)}
            className={`
                group relative flex flex-col justify-between pl-4 pr-3 py-2 w-full h-[76px] rounded-lg cursor-pointer
                transition-all duration-150 border overflow-hidden
                ${isSelected
                    ? 'bg-indigo-50/50 border-indigo-200 shadow-sm'
                    : 'bg-white border-gray-200 hover:border-gray-300'
                }
            `}
        >
            {/* Color Strip */}
            <div className={`absolute left-0 top-0 bottom-0 w-[4px] ${barColor}`} />

            {/* Top row: Name */}
            <div className="flex items-center justify-between w-full h-[18px]">
                <div className="text-[13px] font-bold text-gray-900 truncate pr-2">
                    {task.driverName}
                </div>
                {task.dueAt && (
                    <div className={`text-[10px] font-bold uppercase tracking-tight px-1 rounded ${isOverdue ? 'text-red-600' : isToday ? 'text-yellow-700' : 'text-gray-400'}`}>
                        {dueLabel}
                    </div>
                )}
            </div>

            {/* Middle row: Task details */}
            <div className="flex items-center gap-1.5 w-full h-[16px] text-[12px] text-gray-700 mt-0.5 min-w-0">
                {getIcon()}
                <span className="truncate font-semibold">{task.title}</span>
                {task.scenario && (
                    <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-indigo-50 text-indigo-600">
                        {getScenario(task.scenario)?.label}
                        {task.stage && <> · {getStage(task.scenario, task.stage)?.label}</>}
                    </span>
                )}
                
                <div className="flex items-center gap-1 ml-auto shrink-0 pr-1">
                    {/* Priority Icon with Dropdown */}
                    <div className="relative group/prio" onClick={(e) => e.stopPropagation()}>
                        {task.priority === 'high' ? (
                            <span title="Приоритет: Высокий">
                                <AlertTriangle size={16} className="text-orange-500 animate-in zoom-in-50 duration-200" />
                            </span>
                        ) : (
                            <div className="w-4 h-4 rounded flex items-center justify-center opacity-0 group-hover/prio:opacity-100 group-hover:bg-gray-100 transition-all">
                                <Plus size={12} className="text-gray-400" />
                            </div>
                        )}
                        <select
                            value={task.priority}
                            onChange={(e) => {
                                e.stopPropagation();
                                updateTask.mutate({ id: task.id, patch: { priority: e.target.value as any } });
                            }}
                            className="absolute inset-0 opacity-0 cursor-pointer w-full h-full appearance-none"
                        >
                            <option value="medium">Обычный</option>
                            <option value="high">Высокий</option>
                        </select>
                    </div>

                    {/* Source Icon with Dropdown */}
                    <div className="relative group/src" onClick={(e) => e.stopPropagation()}>
                        <span title={`Источник: ${SOURCE_LABELS[task.source] || task.source}`}>
                            {getSourceIcon()}
                        </span>
                        <select
                            value={task.source}
                            onChange={(e) => {
                                e.stopPropagation();
                                updateTask.mutate({ id: task.id, patch: { source: e.target.value as any } });
                            }}
                            className="absolute inset-0 opacity-0 cursor-pointer w-full h-full appearance-none"
                        >
                            {Object.entries(SOURCE_LABELS).map(([val, lbl]) => (
                                <option key={val} value={val}>{lbl}</option>
                            ))}
                        </select>
                    </div>

                    {/* Assignee Icon with Dropdown */}
                    <div className="relative group/assignee" onClick={(e) => e.stopPropagation()}>
                         <span title="Ответственный">
                             <User size={15} className={`${task.assigneeId ? 'text-indigo-500 fill-indigo-50' : 'text-gray-300'}`} />
                         </span>
                         <select
                             value={task.assigneeId || ''}
                             onChange={(e) => {
                                 e.stopPropagation();
                                 updateTask.mutate({ id: task.id, patch: { assigneeId: e.target.value || null } });
                             }}
                             className="absolute inset-0 opacity-0 cursor-pointer w-full h-full appearance-none"
                         >
                             <option value="">Не назначен</option>
                             {/* Note: Users list needed here for board dropdown */}
                         </select>
                     </div>
                </div>
            </div>

            {/* Bottom row: Default view / Hover view */}
            <div className="w-full h-[22px] flex items-center justify-between mt-1 pt-1 border-t border-gray-100/50 relative">
                {/* Default State: Touch count */}
                <div className="flex items-center gap-1.5 opacity-50 group-hover:opacity-0 transition-opacity">
                    <span className="text-[10px] text-gray-400 font-medium">Касаний: {task.attempts || 0}</span>
                </div>

                {/* Hover Quick Actions */}
                <div className="absolute inset-0 flex items-center justify-start gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-200 bg-white group-hover:bg-transparent">
                    <button 
                        onClick={handleWrite}
                        className="w-6 h-6 rounded flex items-center justify-center bg-gray-100 hover:bg-gray-200 text-gray-600 transition-colors"
                        title="Написать"
                    >
                        <MessageSquare size={12} />
                    </button>
                    <button 
                        onClick={handleCall}
                        className="w-6 h-6 rounded flex items-center justify-center bg-gray-100 hover:bg-gray-200 text-gray-600 transition-colors"
                        title="Позвонить"
                    >
                        <Phone size={12} />
                    </button>
                    <button 
                        onClick={handleChat}
                        className="w-6 h-6 rounded flex items-center justify-center bg-indigo-50 hover:bg-indigo-100 text-indigo-600 transition-colors"
                        title="Открыть чат"
                    >
                        <MessageSquare size={12} />
                    </button>
                    <button 
                        onClick={handleResolve}
                        className="w-6 h-6 rounded flex items-center justify-center bg-green-50 hover:bg-green-100 text-green-600 transition-colors ml-auto shadow-sm"
                        title="Завершить"
                    >
                        <Check size={12} strokeWidth={3} />
                    </button>
                </div>
            </div>
        </div>
    )
}
