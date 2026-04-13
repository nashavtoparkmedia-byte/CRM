'use client'

import { useTimelineTasks } from '@/store/tasks-selectors'
import { useTasksStore } from '@/store/tasks-store'
import { ChevronLeft, ChevronRight, Calendar, Phone, MessageSquare, FileText, AlertCircle, Bot, Inbox } from 'lucide-react'
import { useMemo } from 'react'
import type { TaskDTO } from '@/lib/tasks/types'
import { useRouter } from 'next/navigation'

interface DriverTimelineGroup {
    driverId: string
    driverName: string
    driverPhone: string | null
    overdueTasks: TaskDTO[]
    dayTasks: Record<string, TaskDTO[]> // key = 'YYYY-MM-DD'
}

export default function TaskTimelineView() {
    const tasks = useTimelineTasks()
    const setTimelineRange = useTasksStore((s) => s.setTimelineRange)
    const range = useTasksStore((s) => s.timelineRange)
    const router = useRouter()

    const todayStr = new Date().toISOString().split('T')[0]
    
    // Generate day columns from Today + 6 days
    const days = useMemo(() => {
        const result: Date[] = []
        const current = new Date()
        current.setHours(0, 0, 0, 0)
        
        for (let i = 0; i < 7; i++) {
            result.push(new Date(current))
            current.setDate(current.getDate() + 1)
        }
        return result
    }, [])
    
    // Define the valid date keys for our 7 columns
    const dayKeys = days.map(d => d.toISOString().split('T')[0])

    const groupedDrivers = useMemo(() => {
        const map = new Map<string, DriverTimelineGroup>()
        
        for (const t of tasks) {
            if (!t.isActive) continue
            
            if (!map.has(t.driverId)) {
                map.set(t.driverId, { 
                    driverId: t.driverId, 
                    driverName: t.driverName, 
                    driverPhone: t.driverPhone,
                    overdueTasks: [], 
                    dayTasks: Object.fromEntries(dayKeys.map(k => [k, []]))
                })
            }
            const group = map.get(t.driverId)!
            
            if (t.dueAt) {
                const dueDt = new Date(t.dueAt)
                const dueKey = dueDt.toISOString().split('T')[0]
                const now = new Date()
                
                if (dueDt < now && dueKey !== todayStr) {
                    group.overdueTasks.push(t)
                } else if (group.dayTasks[dueKey]) {
                    group.dayTasks[dueKey].push(t)
                }
            }
        }
        return Array.from(map.values()).sort((a,b) => b.overdueTasks.length - a.overdueTasks.length || a.driverName.localeCompare(b.driverName))
    }, [tasks, dayKeys, todayStr])

    const formatDayHeader = (d: Date, idx: number) => {
        if (idx === 0) return 'Сегодня'
        if (idx === 1) return 'Завтра'
        const dayNames = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб']
        return dayNames[d.getDay()]
    }

    const formatDaySub = (d: Date) => {
        return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
    }

    return (
        <div className="flex flex-col h-full bg-white rounded-xl border border-gray-200 overflow-hidden relative">
            <div className="flex-1 overflow-auto custom-scrollbar bg-white">
                <div className="min-w-[1000px] flex flex-col min-h-full pb-4">
                    {/* Table Header */}
                    <div className="flex sticky top-0 z-10 border-b border-gray-200 bg-gray-50 shadow-sm">
                        <div className="w-[260px] shrink-0 p-3 flex items-center border-r border-gray-200 bg-gray-50">
                            <span className="text-[12px] font-semibold text-gray-500 uppercase tracking-wider">Водитель</span>
                        </div>
                        
                        <div className="w-[100px] shrink-0 p-3 flex flex-col items-center justify-center border-r border-red-100 bg-red-50/90">
                            <span className="text-[13px] font-semibold text-red-600">Проср.</span>
                        </div>

                        {days.map((d, i) => (
                            <div key={i} className={`flex-1 min-w-[80px] p-2 flex flex-col items-center justify-center border-r border-gray-200 last:border-r-0 ${i === 0 ? 'bg-indigo-50/90' : 'bg-gray-50'}`}>
                                <span className={`text-[13px] font-semibold ${i === 0 ? 'text-indigo-600' : 'text-gray-700'}`}>
                                    {formatDayHeader(d, i)}
                                </span>
                                <span className="text-[11px] text-gray-400 font-medium">
                                    {formatDaySub(d)}
                                </span>
                            </div>
                        ))}
                    </div>

                    {/* Table Body */}
                    <div className="flex-1">
                        {groupedDrivers.map(group => (
                            <div key={group.driverId} className="flex border-b border-gray-100 hover:bg-gray-50/50 transition-colors group/row">
                                {/* Driver Info */}
                                <div className="w-[260px] shrink-0 h-[56px] px-3 flex items-center gap-2 border-r border-gray-200 bg-white group-hover/row:bg-transparent">
                                    <div className="w-8 h-8 rounded-full bg-indigo-100 text-indigo-600 font-bold text-[12px] flex items-center justify-center shrink-0">
                                        {group.driverName.charAt(0)}
                                    </div>
                                    <div className="flex-1 min-w-0 pr-2">
                                        <div className="text-[13px] font-semibold text-gray-900 truncate">
                                            {group.driverName}
                                        </div>
                                    </div>
                {/* Hover Quick Actions */}
                <div className="flex items-center gap-1 opacity-0 group-hover/row:opacity-100 transition-opacity">
                    <button 
                        onClick={() => router.push(`/drivers/${group.driverId}`)}
                        className="flex items-center justify-center gap-1.5 h-[32px] px-2.5 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg text-[12px] font-semibold"
                        title="Написать"
                    >
                        <MessageSquare size={14} />
                        <span className="hidden lg:inline">Написать</span>
                    </button>
                    <button 
                        onClick={() => window.open(`tel:${group.driverPhone}`, '_self')}
                        className="flex items-center justify-center gap-1.5 h-[32px] px-2.5 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg text-[12px] font-semibold"
                        title="Позвонить"
                    >
                        <Phone size={14} />
                        <span className="hidden lg:inline">Позвонить</span>
                    </button>
                </div>
            </div>

            {/* Overdue */}
            <div className="w-[100px] shrink-0 flex items-center justify-center border-r border-red-50 bg-red-50/10 group-hover/row:bg-red-50/20">
                <TimelineCell tasks={group.overdueTasks} isOverdue={true} />
            </div>

            {/* Days */}
            {dayKeys.map((key, i) => (
                <div key={key} className={`flex-1 min-w-[80px] flex items-center justify-center border-r border-gray-100 last:border-r-0 ${i === 0 ? 'bg-indigo-50/10 group-hover/row:bg-indigo-50/20' : ''}`}>
                    <TimelineCell tasks={group.dayTasks[key]} isToday={i === 0} />
                </div>
            ))}
        </div>
    ))}

    {groupedDrivers.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 text-gray-400">
            <Inbox size={32} className="mb-2 opacity-50" />
            <span className="text-[13px]">Нет активных задач в этом периоде</span>
        </div>
    )}
</div>
</div>
</div>
</div>
)
}

function TimelineCell({ tasks, isOverdue = false, isToday = false }: { tasks: TaskDTO[], isOverdue?: boolean, isToday?: boolean }) {
if (!tasks || tasks.length === 0) return null

const primaryTask = tasks[0]

const getIcon = (task: TaskDTO) => {
if (task.source === 'auto') return <Bot size={14} />
if (task.type === 'check_docs') return <FileText size={14} />
if (task.type === 'call_back') return <Phone size={14} />
if (task.type === 'payment_issue') return <Calendar size={14} />
if (task.type === 'inactive_followup') return <AlertCircle size={14} />
return <Inbox size={14} />
}

let baseColor = 'text-blue-700 bg-blue-100 hover:bg-blue-200' // blue - active
if (isOverdue) baseColor = 'text-white bg-red-500 hover:bg-red-600 shadow-[0_0_0_2px_rgba(254,226,226,1)]' 
else if (isToday) baseColor = 'text-yellow-800 bg-yellow-200 hover:bg-yellow-300' // yellow - today
else if (primaryTask.status === 'done') baseColor = 'text-emerald-800 bg-emerald-100 hover:bg-emerald-200' // green - done

return (
<div 
className={`flex items-center justify-center h-[28px] px-2 rounded-md font-bold text-[12px] transition-colors cursor-pointer ${baseColor}`}
title={tasks.map(t => t.title).join('\n')}
>
<div className="flex items-center gap-1">
    {getIcon(primaryTask)}
    {tasks.length > 1 && <span>+{tasks.length - 1}</span>}
</div>
</div>
)
}
