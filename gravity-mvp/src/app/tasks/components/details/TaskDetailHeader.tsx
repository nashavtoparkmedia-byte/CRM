'use client'

import {
    X,
    User,
    MessageSquare,
    AlertTriangle,
    Bot,
    Plus,
    MousePointerClick,
} from 'lucide-react'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'
import type { TaskDTO, TaskSource, TaskPriority } from '@/lib/tasks/types'

const SOURCE_LABELS: Record<string, string> = {
    auto: 'Автоматическая',
    manual: 'Ручная',
    chat: 'Из чата',
}

interface TaskDetailHeaderProps {
    task: TaskDTO
    isOverdue: boolean
    statusIndicator: { color: string; label: string }
    users: { id: string; firstName?: string; lastName?: string }[]
    getInitials: (firstName?: string, lastName?: string) => string
    getUserColor: (id: string) => string
    onUpdateAssignee: (assigneeId: string | null) => void
    onUpdateSource: (source: TaskSource) => void
    onUpdatePriority: (priority: TaskPriority) => void
    onClose: () => void
}

export default function TaskDetailHeader({
    task,
    isOverdue,
    statusIndicator,
    users,
    getInitials,
    getUserColor,
    onUpdateAssignee,
    onUpdateSource,
    onUpdatePriority,
    onClose,
}: TaskDetailHeaderProps) {
    return (
        <div className={`flex items-center px-4 py-3 border-b ${isOverdue ? 'border-red-100 bg-red-50/30' : 'border-gray-100 bg-indigo-50/10'}`}>
            <div className="flex items-center flex-1 min-w-0 pr-4 gap-2">
                <h3 className="text-card-title truncate shrink">
                    {task.title}
                </h3>
                <TooltipProvider>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <div className={`w-[7px] h-[7px] rounded-full shrink-0 ${statusIndicator.color} shadow-sm cursor-help transition-colors duration-300`} />
                        </TooltipTrigger>
                        <TooltipContent side="bottom" className="bg-slate-800 border-none text-white text-[11px] font-bold px-2.5 py-1">
                            Статус: {statusIndicator.label}
                        </TooltipContent>
                    </Tooltip>
                </TooltipProvider>
            </div>

            <div className="flex items-center gap-2 px-2 py-1 bg-gray-50/50 border border-gray-100/50 rounded-xl group/metadata">
                {/* Assignee Toggle Icon */}
                <div className="relative shrink-0 flex items-center group/assignee">
                    <TooltipProvider>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <div className="cursor-pointer hover:scale-105 transition-transform">
                                    {task.assigneeId ? (
                                        (() => {
                                            const u = users.find(u => u.id === task.assigneeId);
                                            return (
                                                <div
                                                    className="w-[18px] h-[18px] rounded flex items-center justify-center text-white font-bold text-[8px] shadow-sm ring-1 ring-white"
                                                    style={{ backgroundColor: getUserColor(task.assigneeId) }}
                                                >
                                                    {getInitials(u?.firstName, u?.lastName)}
                                                </div>
                                            );
                                        })()
                                    ) : (
                                        <div className="w-[18px] h-[18px] rounded border border-dashed border-gray-300 flex items-center justify-center text-gray-400">
                                            <User className="w-[12px] h-[12px]" />
                                        </div>
                                    )}
                                </div>
                            </TooltipTrigger>
                            <TooltipContent className="bg-slate-800 border-none text-white text-[11px] font-bold">
                                Ответственный: {users.find(u => u.id === task.assigneeId)?.firstName || 'Не назначен'}
                            </TooltipContent>
                        </Tooltip>
                    </TooltipProvider>

                    {/* Custom Assignee Dropdown */}
                    <div className="absolute top-full right-0 pt-2 w-[200px] opacity-0 invisible group-hover/assignee:opacity-100 group-hover/assignee:visible transition-all z-50">
                        <div className="bg-white rounded-xl shadow-2xl border border-gray-100 py-1.5 max-h-[250px] overflow-y-auto">
                            <button
                                onClick={(e) => { e.stopPropagation(); onUpdateAssignee(null) }}
                                className={`w-full text-left px-3 py-2 text-[12px] hover:bg-gray-50 flex items-center gap-3 ${!task.assigneeId ? 'font-bold bg-indigo-50/50 text-indigo-700' : 'text-gray-700'}`}
                            >
                                <User className="w-4 h-4" /> Не назначен
                            </button>
                            {users.map((u: any) => (
                                <button
                                    key={u.id}
                                    onClick={(e) => { e.stopPropagation(); onUpdateAssignee(u.id) }}
                                    className={`w-full text-left px-3 py-2 text-[12px] hover:bg-gray-50 flex items-center gap-3 ${task.assigneeId === u.id ? 'font-bold bg-indigo-50/50 text-indigo-700' : 'text-gray-700'}`}
                                >
                                    <div
                                        className="w-6 h-6 rounded-md flex items-center justify-center text-white font-bold text-[9px] shrink-0"
                                        style={{ backgroundColor: getUserColor(u.id) }}
                                    >
                                        {getInitials(u.firstName, u.lastName)}
                                    </div>
                                    <span className="truncate">{u.firstName} {u.lastName}</span>
                                </button>
                            ))}
                        </div>
                    </div>
                </div>

                {/* Source Toggle Icon */}
                <div className="relative shrink-0 flex items-center group/src">
                    <TooltipProvider>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <div className="cursor-pointer hover:scale-110 transition-transform w-[18px] h-[18px] flex items-center justify-center">
                                    {task.source === 'auto' ? <Bot className="w-[14px] h-[14px] text-blue-500 fill-blue-50" /> :
                                     task.source === 'chat' ? <MessageSquare className="w-[14px] h-[14px] text-emerald-500 fill-emerald-50" /> :
                                     <MousePointerClick className="w-[14px] h-[14px] text-slate-400" />}
                                </div>
                            </TooltipTrigger>
                            <TooltipContent className="bg-slate-800 border-none text-white text-[11px] font-bold">
                                Источник: {SOURCE_LABELS[task.source] || task.source}
                            </TooltipContent>
                        </Tooltip>
                    </TooltipProvider>

                    {/* Custom Source Dropdown */}
                    <div className="absolute top-full right-0 pt-2 w-[160px] opacity-0 invisible group-hover/src:opacity-100 group-hover/src:visible transition-all z-50">
                        <div className="bg-white rounded-xl shadow-2xl border border-gray-100 py-1.5">
                            <button onClick={(e) => { e.stopPropagation(); onUpdateSource('auto') }} className={`w-full px-3 py-2 text-[12px] hover:bg-gray-50 flex items-center gap-3 ${task.source === 'auto' ? 'bg-blue-50/50 font-bold text-blue-700' : 'text-gray-700'}`}>
                                <Bot className="w-4 h-4 text-blue-500" /> {SOURCE_LABELS['auto']}
                            </button>
                            <button onClick={(e) => { e.stopPropagation(); onUpdateSource('manual') }} className={`w-full px-3 py-2 text-[12px] hover:bg-gray-50 flex items-center gap-3 ${task.source === 'manual' ? 'bg-slate-50 font-bold text-slate-700' : 'text-gray-700'}`}>
                                <MousePointerClick className="w-4 h-4 text-slate-400" /> {SOURCE_LABELS['manual']}
                            </button>
                            <button onClick={(e) => { e.stopPropagation(); onUpdateSource('chat') }} className={`w-full px-3 py-2 text-[12px] hover:bg-gray-50 flex items-center gap-3 ${task.source === 'chat' ? 'bg-emerald-50/50 font-bold text-emerald-700' : 'text-gray-700'}`}>
                                <MessageSquare className="w-4 h-4 text-emerald-500" /> {SOURCE_LABELS['chat']}
                            </button>
                        </div>
                    </div>
                </div>

                {/* Priority Toggle Icon */}
                <div className="relative shrink-0 flex items-center group/prio">
                    <TooltipProvider>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <div className="cursor-pointer hover:scale-110 transition-transform">
                                    {task.priority === 'high' ? (
                                        <div className="w-[18px] h-[18px] flex items-center justify-center hover:bg-orange-50 rounded">
                                            <AlertTriangle className="w-[14px] h-[14px] text-orange-500 animate-in zoom-in-50 duration-200" />
                                        </div>
                                    ) : (
                                        <div className="w-[18px] h-[18px] flex items-center justify-center hover:bg-gray-100 rounded overflow-hidden translate-x-1 group-hover/metadata:translate-x-0 group-hover/metadata:opacity-100 opacity-0 transition-all">
                                            <Plus size={13} className="text-slate-400" />
                                        </div>
                                    )}
                                </div>
                            </TooltipTrigger>
                            <TooltipContent className="bg-slate-800 border-none text-white text-[11px] font-bold">
                                Приоритет: {task.priority === 'high' ? 'Высокий' : 'Обычный'}
                            </TooltipContent>
                        </Tooltip>
                    </TooltipProvider>

                    {/* Custom Priority Dropdown */}
                    <div className="absolute top-full right-0 pt-2 w-[140px] opacity-0 invisible group-hover/prio:opacity-100 group-hover/prio:visible transition-all z-50">
                        <div className="bg-white rounded-xl shadow-2xl border border-gray-100 py-1.5">
                            <button onClick={(e) => { e.stopPropagation(); onUpdatePriority('medium') }} className={`w-full px-3 py-2 text-[12px] hover:bg-gray-50 flex items-center gap-3 ${task.priority === 'medium' ? 'bg-gray-50 font-bold text-gray-700' : 'text-gray-700'}`}>
                                <Plus className="w-4 h-4 text-gray-400" /> Обычный
                            </button>
                            <button onClick={(e) => { e.stopPropagation(); onUpdatePriority('high') }} className={`w-full px-3 py-2 text-[12px] hover:bg-gray-50 flex items-center gap-3 ${task.priority === 'high' ? 'bg-orange-50 font-bold text-orange-700' : 'text-gray-700'}`}>
                                <AlertTriangle className="w-4 h-4 text-orange-500" /> Высокий
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <div className="w-[1px] h-4 bg-gray-200 ml-3 mr-0.5 shrink-0" />

            <button
                onClick={onClose}
                className="p-1 px-1.5 rounded-lg hover:bg-gray-100 transition-colors text-gray-400 hover:text-gray-600 shrink-0 ml-1"
            >
                <X className="w-5 h-5" />
            </button>
        </div>
    )
}
