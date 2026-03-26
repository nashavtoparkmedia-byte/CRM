'use client'

import { useState, useEffect } from 'react'
import { useTasksStore } from '@/store/tasks-store'
import { getDictionaries } from '@/lib/dictionaries/dictionary-service'
import { useRouter } from 'next/navigation'
import { getUsers } from '@/lib/users/user-service'
import { useSelectedTask } from '@/store/tasks-selectors'
import { useTaskDetailQuery } from '@/hooks/use-tasks-query'
import { useUpdateTask, useResolveTask } from '@/hooks/use-task-mutations'
import { addTaskAction, correctTaskAction } from '@/app/tasks/actions'
import {
    X,
    Check,
    XCircle,
    Clock,
    User,
    MessageSquare,
    ArrowUpRight,
    Bell,
    AlertTriangle,
    Inbox,
    Bot,
    Zap,
    Plus,
    MousePointerClick,
    FileText,
    ChevronRight,
    Tag,
    HelpCircle,
    Phone,
} from 'lucide-react'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'
import Link from 'next/link'
import { TASK_TYPES } from '@/lib/tasks/types'

const STATUS_LABELS: Record<string, string> = {
    todo: 'К выполнению',
    in_progress: 'В работе',
    waiting_reply: 'Ждет ответа',
    overdue: 'Просрочено',
    snoozed: 'Отложена',
    done: 'Выполнено',
    cancelled: 'Отменена',
    archived: 'Архив',
}

const PRIORITY_LABELS: Record<string, { label: string; color: string }> = {
    high: { label: 'Высокий', color: 'text-orange-600 bg-orange-50' },
    medium: { label: 'Обычный', color: 'text-gray-500 bg-gray-50' },
}

const SOURCE_LABELS: Record<string, string> = {
    auto: 'Автоматическая',
    manual: 'Ручная',
    chat: 'Из чата',
}

const SCENARIO_LABELS: Record<string, string> = {
    connection: 'Подключение',
    contact: 'Контакт',
    churn: 'Отток',
    promo: 'Акция',
}

const EVENT_LABELS: Record<string, string> = {
    created: 'Создана задача',
    status_changed: 'Смена статуса',
    message_sent: 'Сообщение отправлено',
    reply_received: 'Получен ответ',
    priority_changed: 'Смена приоритета',
    assigned: 'Назначена',
    reopened: 'Переоткрыта',
    postponed: 'Перенес срок',
    called: 'Позвонил',
    wrote: 'Написал',
    contact_corrected: 'Обновлено',
}

export default function TaskDetailsPane() {
    const selectedTaskId = useTasksStore((s) => s.selectedTaskId)
    const setSelectedTask = useTasksStore((s) => s.setSelectedTask)
    const task = useSelectedTask()
    const { data: details, isLoading } = useTaskDetailQuery(selectedTaskId)
    const lastContact = details?.events?.find((e: any) => 
        ['called', 'wrote', 'message_sent', 'contacted', 'contact_corrected'].includes(e.eventType)
    )
    const updateTask = useUpdateTask()
    const resolveTask = useResolveTask()
    const router = useRouter()
    const [dicts, setDicts] = useState<any>(null)
    const [isHistoryExpanded, setIsHistoryExpanded] = useState(false)
    const [historyMode, setHistoryMode] = useState<'actions' | 'all'>('actions')
    const [expandedPostponed, setExpandedPostponed] = useState<Set<string>>(new Set())
    const [isCommentExpanded, setIsCommentExpanded] = useState(false)
    const [users, setUsers] = useState<any[]>([])
    
    // Результат контакта
    const [contactAction, setContactAction] = useState<'called' | 'wrote' | null>(null)
    const [resultId, setResultId] = useState('')
    const [comment, setComment] = useState('')
    const [isSaving, setIsSaving] = useState(false)
    const [editingEventId, setEditingEventId] = useState<string | null>(null)
    const [lastActionTime, setLastActionTime] = useState(0)

    useEffect(() => {
        getDictionaries().then(setDicts)
        getUsers().then(setUsers)
    }, [])

    if (!task) return null

    const scenario = task.scenario || 'contact'
    
    // События зависят от сценария
    const availableEvents = dicts?.events?.filter((e: any) => 
        !e.metadata?.scenario || e.metadata.scenario === scenario
    ) || []

    const prio = PRIORITY_LABELS[task.priority] ?? PRIORITY_LABELS.medium
    const isOverdue = task.dueAt && new Date(task.dueAt) < new Date() && task.isActive

    const getInitials = (firstName?: string, lastName?: string) => {
        const first = firstName?.[0] || '';
        const last = lastName?.[0] || '';
        return (first + last).toUpperCase() || '?';
    };

    const getUserColor = (id: string) => {
        // Simple deterministic hash for color
        let hash = 0;
        for (let i = 0; i < id.length; i++) {
            hash = id.charCodeAt(i) + ((hash << 5) - hash);
        }
        const h = Math.abs(hash % 360);
        return `hsl(${h}, 45%, 55%)`; // Muted but distinct colors
    };

    const handleMarkNewReplyRead = () => {
        if (task.hasNewReply) {
            updateTask.mutate({ id: task.id, patch: { hasNewReply: false } })
        }
    }

    const handleSaveContactResult = async () => {
        if (!contactAction || !resultId) return
        setIsSaving(true)
        try {
            if (editingEventId) {
                await correctTaskAction(task.id, editingEventId, resultId, comment)
            } else {
                await addTaskAction(task.id, contactAction, resultId, comment)
                localStorage.setItem('crm_last_contact_result', resultId)
            }
            setLastActionTime(Date.now())
            updateTask.mutate({ id: task.id, patch: {} }) // Trigger refetch
            setContactAction(null)
            setResultId('')
            setComment('')
            setEditingEventId(null)
        } finally {
            setIsSaving(false)
        }
    }

    const handleEditLastContact = (event: any) => {
        setContactAction(event.eventType === 'contact_corrected' ? 'called' : event.eventType as any)
        setResultId((event.payload as any).newResultId || (event.payload as any).resultId || '')
        setComment((event.payload as any).comment || '')
        setEditingEventId(event.id)
    }

    const handleQuickResult = async (resId: string) => {
        // Double-click protection (2s)
        const now = Date.now()
        if (now - lastActionTime < 2000) return
        
        // Duplicate protection (30s, same result)
        if (lastContact && 
            ['called', 'wrote', 'contact_corrected'].includes(lastContact.eventType) && 
            ((lastContact.payload as any).newResultId || (lastContact.payload as any).resultId) === resId &&
            now - new Date(lastContact.createdAt).getTime() < 30000) {
            alert('Действие уже зафиксировано')
            return
        }

        setLastActionTime(now)
        setIsSaving(true)
        try {
            await addTaskAction(task.id, 'called', resId)
            localStorage.setItem('crm_last_contact_result', resId)
            updateTask.mutate({ id: task.id, patch: {} })
        } finally {
            setIsSaving(false)
        }
    }

    useEffect(() => {
        if (contactAction && !resultId && !editingEventId) {
            const lastRes = localStorage.getItem('crm_last_contact_result')
            if (lastRes) setResultId(lastRes)
        }
    }, [contactAction, resultId, editingEventId])

    const getStatusIndicator = () => {
        if (isOverdue) return { color: 'bg-red-500', label: 'Просрочено' };
        if (task.status === 'done') return { color: 'bg-green-500', label: 'Выполнено' };
        if (task.status === 'cancelled' || task.status === 'archived') return { color: 'bg-gray-400', label: 'Отменена' };
        if (task.status === 'in_progress') return { color: 'bg-blue-500', label: 'В работе' };
        return { color: 'bg-gray-400', label: 'К выполнению' };
    };
    const statusInd = getStatusIndicator();

    return (
        <div className={`w-[380px] shrink-0 border-l border-[#e5e7eb] flex flex-col h-auto overflow-visible animate-in slide-in-from-right-4 duration-200 ${isOverdue ? 'bg-red-50/50 border-l-4 border-l-red-500' : 'bg-white'}`}>
            <div className={`flex items-center px-4 py-3 border-b ${isOverdue ? 'border-red-100 bg-red-50/30' : 'border-gray-100 bg-indigo-50/10'}`}>
                <div className="flex items-center flex-1 min-w-0 pr-4 gap-2">
                    <h3 className="text-card-title truncate shrink">
                        {task.title}
                    </h3>
                    <TooltipProvider>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <div className={`w-[7px] h-[7px] rounded-full shrink-0 ${statusInd.color} shadow-sm cursor-help transition-colors duration-300`} />
                            </TooltipTrigger>
                            <TooltipContent side="bottom" className="bg-slate-800 border-none text-white text-[11px] font-bold px-2.5 py-1">
                                Статус: {statusInd.label}
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
                                    onClick={(e) => { e.stopPropagation(); updateTask.mutate({ id: task.id, patch: { assigneeId: null } }) }}
                                    className={`w-full text-left px-3 py-2 text-[12px] hover:bg-gray-50 flex items-center gap-3 ${!task.assigneeId ? 'font-bold bg-indigo-50/50 text-indigo-700' : 'text-gray-700'}`}
                                >
                                    <User className="w-4 h-4" /> Не назначен
                                </button>
                                {users.map((u: any) => (
                                    <button
                                        key={u.id}
                                        onClick={(e) => { e.stopPropagation(); updateTask.mutate({ id: task.id, patch: { assigneeId: u.id } }) }}
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
                                <button onClick={(e) => { e.stopPropagation(); updateTask.mutate({ id: task.id, patch: { source: 'auto' as any } }) }} className={`w-full px-3 py-2 text-[12px] hover:bg-gray-50 flex items-center gap-3 ${task.source === 'auto' ? 'bg-blue-50/50 font-bold text-blue-700' : 'text-gray-700'}`}>
                                    <Bot className="w-4 h-4 text-blue-500" /> {SOURCE_LABELS['auto']}
                                </button>
                                <button onClick={(e) => { e.stopPropagation(); updateTask.mutate({ id: task.id, patch: { source: 'manual' as any } }) }} className={`w-full px-3 py-2 text-[12px] hover:bg-gray-50 flex items-center gap-3 ${task.source === 'manual' ? 'bg-slate-50 font-bold text-slate-700' : 'text-gray-700'}`}>
                                    <MousePointerClick className="w-4 h-4 text-slate-400" /> {SOURCE_LABELS['manual']}
                                </button>
                                <button onClick={(e) => { e.stopPropagation(); updateTask.mutate({ id: task.id, patch: { source: 'chat' as any } }) }} className={`w-full px-3 py-2 text-[12px] hover:bg-gray-50 flex items-center gap-3 ${task.source === 'chat' ? 'bg-emerald-50/50 font-bold text-emerald-700' : 'text-gray-700'}`}>
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
                                <button onClick={(e) => { e.stopPropagation(); updateTask.mutate({ id: task.id, patch: { priority: 'medium' as any } }) }} className={`w-full px-3 py-2 text-[12px] hover:bg-gray-50 flex items-center gap-3 ${task.priority === 'medium' ? 'bg-gray-50 font-bold text-gray-700' : 'text-gray-700'}`}>
                                    <Plus className="w-4 h-4 text-gray-400" /> Обычный
                                </button>
                                <button onClick={(e) => { e.stopPropagation(); updateTask.mutate({ id: task.id, patch: { priority: 'high' as any } }) }} className={`w-full px-3 py-2 text-[12px] hover:bg-gray-50 flex items-center gap-3 ${task.priority === 'high' ? 'bg-orange-50 font-bold text-orange-700' : 'text-gray-700'}`}>
                                    <AlertTriangle className="w-4 h-4 text-orange-500" /> Высокий
                                </button>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="w-[1px] h-4 bg-gray-200 ml-3 mr-0.5 shrink-0" />

                <button
                    onClick={() => setSelectedTask(null)}
                    className="p-1 px-1.5 rounded-lg hover:bg-gray-100 transition-colors text-gray-400 hover:text-gray-600 shrink-0 ml-1"
                >
                    <X className="w-5 h-5" />
                </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-visible px-4 py-4 space-y-3">
                {/* New reply banner */}
                {task.hasNewReply && (
                    <button
                        onClick={handleMarkNewReplyRead}
                        className="w-full flex items-center gap-2 px-3 py-2 bg-blue-50 border border-blue-100 rounded-lg text-[13px] text-blue-700 font-bold hover:bg-blue-100 transition-colors shadow-sm"
                    >
                        <Bell className="w-4 h-4" />
                        Новый ответ водителя
                        <span className="ml-auto text-[11px] text-blue-400">Отметить прочитанным</span>
                    </button>
                )}

                {/* 1. Сетка полей: Сценарий | Событие ... */}
                <div className="grid grid-cols-2 gap-x-3 gap-y-3">
                    <MetaField label="Сценарий" icon={<Zap className="w-3.5 h-3.5 text-purple-500" />}>
                        <select
                            value={scenario}
                            onChange={(e) => updateTask.mutate({ id: task.id, patch: { scenario: e.target.value } })}
                            className="bg-transparent border border-transparent hover:border-gray-200 outline-none rounded text-primary-value py-0.5 cursor-pointer -ml-1 transition-colors w-full whitespace-normal line-clamp-2"
                        >
                            {dicts?.scenarios?.map((s: any) => (
                                <option key={s.id} value={s.id}>{s.label}</option>
                            )) || <option value="contact">Контакт</option>}
                        </select>
                    </MetaField>

                    <MetaField label="Событие" icon={<Tag className="w-3.5 h-3.5 text-blue-500" />}>
                        <select
                            value={task.type}
                            onChange={(e) => updateTask.mutate({ id: task.id, patch: { type: e.target.value } })}
                            className="bg-transparent outline-none border border-transparent hover:border-gray-200 rounded py-0.5 cursor-pointer -ml-1 transition-colors w-full whitespace-normal line-clamp-2 text-primary-value"
                        >
                            {availableEvents.map((t: any) => (
                                <option key={t.id} value={t.id}>{t.label}</option>
                            )) || <option value={task.type}>{task.type}</option>}
                        </select>
                    </MetaField>

                    <MetaField label="Статус" icon={<ChevronRight className="w-3.5 h-3.5" />}>
                        <div className="flex items-center gap-1 -ml-1">
                            {isOverdue && <AlertTriangle className="w-4 h-4 text-red-500 shrink-0" />}
                            <select
                                value={task.status}
                            onChange={(e) => updateTask.mutate({ id: task.id, patch: { status: e.target.value as any } })}
                            className="bg-transparent border border-transparent hover:border-gray-200 outline-none rounded py-0.5 cursor-pointer -ml-1 transition-colors text-primary-value"
                        >
                            {Object.entries(STATUS_LABELS).map(([val, lbl]) => (
                                <option key={val} value={val}>{lbl}</option>
                            ))}
                        </select>
                        </div>
                    </MetaField>

                    <MetaField label="Срок" icon={<Clock className={`w-3.5 h-3.5 ${isOverdue ? 'text-red-500' : ''}`} />}>
                        <div className="relative cursor-pointer">
                            <span className={`text-primary-value ${isOverdue ? '!text-[#DC2626]' : !task.dueAt ? 'bg-yellow-50 border-yellow-200 !text-yellow-800' : ''}`}>
                                {task.dueAt ? new Date(task.dueAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) + ', ' + new Date(task.dueAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '—'}
                            </span>
                            {!['done', 'cancelled', 'archived'].includes(task.status) && (
                                <input
                                    type="datetime-local"
                                    value={task.dueAt ? new Date(new Date(task.dueAt).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ''}
                                    onClick={(e) => (e.target as any).showPicker()}
                                    onChange={(e) => {
                                        const val = e.target.value;
                                        if (val && new Date(val).getTime() < Date.now()) {
                                            alert('Нельзя установить срок в прошлом');
                                            return;
                                        }
                                        updateTask.mutate({ id: task.id, patch: { dueAt: val ? new Date(val).toISOString() : null } })
                                    }}
                                    className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
                                />
                            )}
                        </div>
                    </MetaField>




                </div>

                {/* Блок: Последний контакт (под сеткой полей) */}
                {lastContact && (() => {
                    const resId = (lastContact.payload as any)?.newResultId || (lastContact.payload as any)?.resultId;
                    const bgClass = resId === 'no_answer' ? 'bg-yellow-50 border-yellow-100' :
                                   resId === 'docs_waiting' ? 'bg-blue-50 border-blue-100' :
                                   resId === 'problem_solved' ? 'bg-green-50 border-green-100' :
                                   resId === 'rejected' ? 'bg-red-50 border-red-100' :
                                   'bg-indigo-50/50 border-indigo-100/50';
                    const labelColor = resId === 'no_answer' ? 'text-yellow-600' :
                                      resId === 'docs_waiting' ? 'text-blue-600' :
                                      resId === 'problem_solved' ? 'text-green-600' :
                                      resId === 'rejected' ? 'text-red-600' :
                                      'text-indigo-400';
                    
                    return (
                        <div className={`p-3 border rounded-xl animate-in fade-in slide-in-from-top-1 duration-300 ${bgClass}`}>
                            <div className={`flex items-center gap-1.5 text-section-label mb-2 ${labelColor}`}>
                                <Clock className="w-3 h-3" />
                                Последний контакт
                            </div>
                            <div className="flex items-start justify-between gap-3">
                                <div className="flex-1 min-w-0">
                                    {(() => {
                                        const actionLabel = EVENT_LABELS[lastContact.eventType] || dicts?.history_actions?.find((a: any) => a.id === lastContact.eventType)?.label;
                                        const resultLabel = resId ? (dicts?.contact_results?.find((r: any) => r.id === resId)?.label || resId) : null;
                                        const commentText = (lastContact.payload as any)?.comment;
                                        const isLongComment = commentText?.length > 80;

                                        return (
                                            <>
                                                <p className="text-primary-value leading-tight">
                                                    {resultLabel || (!actionLabel ? lastContact.eventType : null)}
                                                </p>
                                                
                                                {lastContact.eventType === 'contact_corrected' && actionLabel && (
                                                    <p className="text-meta !text-[#94A3B8] mt-1 leading-none">
                                                        {actionLabel}
                                                    </p>
                                                )}
                                                
                                                {commentText && (
                                                    <div className="mt-1.5 flex flex-col items-start">
                                                        <p className={`text-secondary-value italic leading-snug ${!isCommentExpanded ? 'line-clamp-2' : ''}`}>
                                                            «{commentText}»
                                                        </p>
                                                        {isLongComment && !isCommentExpanded && (
                                                            <button 
                                                                onClick={() => setIsCommentExpanded(true)} 
                                                                className="text-meta !text-[#4F46E5] hover:underline mt-0.5"
                                                            >
                                                                Показать полностью
                                                            </button>
                                                        )}
                                                        {isLongComment && isCommentExpanded && (
                                                            <button 
                                                                onClick={() => setIsCommentExpanded(false)} 
                                                                className="text-meta !text-[#4F46E5] hover:underline mt-0.5"
                                                            >
                                                                Скрыть
                                                            </button>
                                                        )}
                                                    </div>
                                                )}
                                            </>
                                        );
                                    })()}
                                </div>
                                <div className="text-right shrink-0 flex flex-col items-end">
                                    <span className="text-meta bg-white/80 px-1.5 py-0.5 rounded border border-gray-100 shadow-sm mt-0.5">
                                        {new Date(lastContact.createdAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}, {new Date(lastContact.createdAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
                                    </span>
                                </div>
                            </div>

                            {/* Touch Counter inside Last Contact */}
                            <div className="mt-3 pt-2 border-t border-black/5 flex items-center justify-between">
                                <TooltipProvider>
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <div style={{ fontSize: '11px', padding: '4px 8px', borderRadius: '999px', background: '#F1F5F9', color: '#475569' }} className="cursor-help flex items-center gap-1 group/touches transition-colors hover:bg-slate-200">
                                                <span className="group-hover/touches:text-[#4F46E5] transition-colors font-semibold">{task.attempts || 0}</span> касаний
                                            </div>
                                        </TooltipTrigger>
                                        <TooltipContent className="bg-slate-900 text-white p-3 max-w-[220px] border-none shadow-xl">
                                            <p className="font-bold text-[13px] mb-1">Всего касаний</p>
                                            <p className="text-[12px] opacity-80 leading-snug">
                                                Количество попыток связаться с водителем.<br/>
                                                <span className="mt-2 block pt-1 border-t border-white/10">
                                                    Считаются: <b>Позвонил, Написал</b>.<br/>
                                                    Не считаются: Перенос срока, Смена статуса.
                                                </span>
                                            </p>
                                        </TooltipContent>
                                    </Tooltip>
                                </TooltipProvider>

                                <div className="flex items-center gap-3">
                                    <span className="text-meta !text-[#94A3B8] flex items-center gap-1">
                                        <User className="w-2.5 h-2.5" />
                                        {(() => {
                                            const u = users.find((u: any) => u.id === lastContact.actorId);
                                            return u ? `${u.firstName} ${u.lastName || ''}`.trim() : 'Менеджер';
                                        })()}
                                    </span>
                                    <button 
                                        onClick={() => handleEditLastContact(lastContact)}
                                        className="text-meta !text-[#4F46E5] hover:underline cursor-pointer"
                                    >
                                        Изменить
                                    </button>
                                </div>
                            </div>
                        </div>
                    );
                })()}

                {/* Поле: Следующее действие */}
                <div className={`p-3 border rounded-xl space-y-2 transition-colors duration-300 ${isOverdue ? 'bg-red-50/80 border-red-200/60' : 'bg-gray-50/50 border-gray-100'}`}>
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5 text-section-label">
                            <Zap className="w-3 h-3" />
                            Следующее действие
                        </div>
                        <div className="text-section-label">
                            Срок
                        </div>
                    </div>
                    
                    <div className="flex items-center justify-between gap-3">
                        <select
                            value={task.nextActionId || ''}
                            onChange={(e) => updateTask.mutate({ id: task.id, patch: { scenario: scenario, nextActionId: e.target.value } as any })}
                            className="bg-transparent border-none outline-none text-primary-value cursor-pointer flex-1"
                        >
                            <option value="">Не выбрано</option>
                            {dicts?.next_actions?.map((a: any) => (
                                <option key={a.id} value={a.id}>{a.label}</option>
                            ))}
                        </select>
                        
                        <div className="flex flex-col items-end gap-1 shrink-0">
                            {task.dueAt && (
                                <span className="text-meta bg-white/80 px-2 py-0.5 rounded border border-gray-100 shadow-sm">
                                    {new Date(task.dueAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}, {new Date(task.dueAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
                                </span>
                            )}
                            <div className="flex gap-1">
                                <button
                                    onClick={() => {
                                        const current = task.dueAt ? new Date(task.dueAt) : new Date();
                                        current.setHours(current.getHours() + 1);
                                        updateTask.mutate({ id: task.id, patch: { dueAt: current.toISOString() } });
                                    }}
                                    className="text-meta px-1.5 py-0.5 bg-white border border-gray-200 hover:bg-gray-100 hover:border-blue-200 hover:!text-[#4F46E5] rounded transition-all cursor-pointer shadow-sm"
                                >
                                    +1ч
                                </button>
                                <button
                                    onClick={() => {
                                        const current = task.dueAt ? new Date(task.dueAt) : new Date();
                                        current.setDate(current.getDate() + 1);
                                        updateTask.mutate({ id: task.id, patch: { dueAt: current.toISOString() } });
                                    }}
                                    className="text-meta px-1.5 py-0.5 bg-blue-50 border border-blue-100 hover:bg-blue-100 hover:!text-blue-700 rounded !text-[#4F46E5] transition-all cursor-pointer shadow-sm"
                                >
                                    +1д
                                </button>
                            </div>
                        </div>
                    </div>
                </div>

                {/* 2. Блок: ДЕЙСТВИЕ */}
                <div className="pt-2 border-t border-gray-100">
                    <h4 className="text-section-label mb-2">Действие</h4>
                    <div className="flex gap-2">
                        <button
                            onClick={() => {
                                const now = Date.now();
                                if (now - lastActionTime < 2000) return;
                                setLastActionTime(now);
                                setContactAction('called');
                            }}
                            className="h-[36px] py-2 px-3 bg-gray-100 border border-gray-200 text-gray-900 font-medium rounded-lg hover:bg-gray-200 transition-all flex items-center justify-center gap-2 text-[14px]"
                        >
                            <Phone size={14} className="text-[#64748B]" /> Позвонил
                        </button>
                        <button
                            onClick={() => {
                                const now = Date.now();
                                if (now - lastActionTime < 2000) return;
                                setLastActionTime(now);
                                setContactAction('wrote');
                            }}
                            className="h-[36px] py-2 px-3 bg-gray-100 border border-gray-200 text-gray-900 font-medium rounded-lg hover:bg-gray-200 transition-all flex items-center justify-center gap-2 text-[14px]"
                        >
                            <MessageSquare size={14} className="text-[#64748B]" /> Написал
                        </button>
                    </div>
                </div>

                {/* 3. Блок: СВЯЗАТЬСЯ */}
                <div className="mt-4">
                    <h4 className="text-section-label mb-2">Связаться</h4>
                    <div className="bg-[#FAFAFA] border border-[#F0F0F0] rounded-[12px] p-4">
                        <div className="flex items-center gap-3 truncate">
                            <div className="w-9 h-9 rounded-full bg-gray-50 border border-gray-100 flex items-center justify-center shrink-0">
                                <User className="w-5 h-5 text-gray-400" />
                            </div>
                            <div className="flex flex-col min-w-0">
                                <span style={{ fontSize: '15px', fontWeight: 500 }} className="truncate leading-tight text-[#111827]">{task.driverName}</span>
                                {task.driverPhone && <span className="text-secondary-value mt-0.5 leading-none">+{task.driverPhone}</span>}
                            </div>
                        </div>

                        <div className="flex gap-2 mt-3">
                            <button 
                                onClick={() => window.open(`tel:${task.driverPhone}`, '_self')} 
                                className="flex-1 py-2 px-3 bg-white border border-[#E5E7EB] text-[#374151] font-medium rounded-[8px] hover:bg-gray-50 transition-all flex items-center justify-center gap-2 text-[12px]"
                            >
                                <Phone size={14} className="text-gray-400" /> Позвонить
                            </button>
                            <button 
                                onClick={() => router.push(`/messages?msg=new&phone=${task.driverPhone}&driver=${task.driverId}`)} 
                                className="flex-1 py-2 px-3 bg-white border border-[#E5E7EB] text-[#374151] font-medium rounded-[8px] hover:bg-gray-50 transition-all flex items-center justify-center gap-2 text-[12px]"
                            >
                                <MessageSquare size={14} className="text-gray-400" /> Написать
                            </button>
                            <button 
                                onClick={() => router.push(`/messages?focusedDriver=${task.driverId}`)} 
                                className="flex-1 py-2 px-3 bg-white border border-[#E5E7EB] text-[#374151] font-medium rounded-[8px] hover:bg-gray-50 transition-all flex items-center justify-center gap-2 text-[12px]"
                            >
                                <MessageSquare size={14} className="text-gray-400" /> Чат
                            </button>
                        </div>
                    </div>
                </div>
                {task.description && (
                    <div>
                        <h4 className="text-section-label mb-2">
                            Описание
                        </h4>
                        <p className="text-secondary-value leading-relaxed">{task.description}</p>
                    </div>
                )}

                {/* Chat origin */}
                {task.chatId && (
                    <div className="border border-[#e5e7eb] rounded-xl p-3">
                        <div className="flex items-center gap-2 mb-2">
                            <MessageSquare className="w-3.5 h-3.5 text-[#94A3B8]" />
                            <span className="text-section-label">
                                Связанный чат
                            </span>
                        </div>
                        {task.originExcerpt && (
                            <p className="text-meta !text-[#94A3B8] italic mb-2 line-clamp-2">
                                «{task.originExcerpt}»
                            </p>
                        )}
                        <div className="flex gap-2">
                            <Link
                                href={`/messages?id=${task.chatId}`}
                                className="flex items-center gap-1 text-meta !text-[#4F46E5] hover:!text-[#4338ca] transition-colors"
                            >
                                <ArrowUpRight className="w-3 h-3" />
                                Открыть чат
                            </Link>
                            {task.originMessageId && (
                                <Link
                                    href={`/messages?id=${task.chatId}&msg=${task.originMessageId}`}
                                    className="flex items-center gap-1 text-meta !text-[#64748B] hover:!text-[#4F46E5] transition-colors"
                                >
                                    К сообщению
                                </Link>
                            )}
                        </div>
                    </div>
                )}

                <div>
                    <div className="flex items-center justify-between mb-3">
                        <h4 className="text-section-label flex items-center gap-2">
                            <FileText className="w-3.5 h-3.5" />
                            История
                        </h4>
                        <div className="flex bg-[#F1F5F9] rounded-md p-0.5" style={{ fontSize: '11px' }}>
                            <button
                                onClick={() => setHistoryMode('actions')}
                                className={`px-2 py-0.5 rounded transition-colors cursor-pointer ${
                                    historyMode === 'actions'
                                        ? 'bg-white text-[#111827] shadow-sm font-medium'
                                        : 'text-[#94A3B8] hover:text-[#64748B]'
                                }`}
                            >
                                Действия
                            </button>
                            <button
                                onClick={() => setHistoryMode('all')}
                                className={`px-2 py-0.5 rounded transition-colors cursor-pointer ${
                                    historyMode === 'all'
                                        ? 'bg-white text-[#111827] shadow-sm font-medium'
                                        : 'text-[#94A3B8] hover:text-[#64748B]'
                                }`}
                            >
                                Все
                            </button>
                        </div>
                    </div>
                    {isLoading ? (
                        <div className="space-y-2">
                            {[1, 2, 3].map((i) => (
                                <div key={i} className="h-8 bg-[#f3f4f6] rounded-lg animate-pulse" />
                            ))}
                        </div>
                    ) : details?.events && details.events.length > 0 ? (
                        <div className={`space-y-0 ${isHistoryExpanded && (details?.events?.length || 0) > 10 ? 'max-h-[300px] overflow-y-auto pr-2 custom-scrollbar' : ''}`}>
                            {(() => {
                                // Technical event types to hide in 'actions' mode
                                const technicalTypes = ['postponed', 'status_changed', 'priority_changed'];
                                const rawEvents = historyMode === 'actions'
                                    ? details.events.filter((e: any) => !technicalTypes.includes(e.eventType))
                                    : details.events;

                                // Filter out no-op postponed events (from === to)
                                const isNoOpPostponed = (e: any) => {
                                    if (e.eventType !== 'postponed' || !e.payload) return false;
                                    const f = e.payload.from, t = e.payload.to;
                                    if (!f || !t) return false;
                                    // Compare truncated to minute
                                    return f.slice(0, 16) === t.slice(0, 16);
                                };
                                const baseEvents = rawEvents.filter((e: any) => !isNoOpPostponed(e));

                                // Sort newest first
                                const sortedEvents = [...(isHistoryExpanded ? baseEvents : baseEvents.slice(0, 3))].sort(
                                    (a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
                                );

                                // Collapse consecutive postponed: keep first, store hidden ones
                                const processedEvents: { event: any; collapsedCount?: number; collapsedEvents?: any[]; groupKey?: string }[] = [];
                                for (let i = 0; i < sortedEvents.length; i++) {
                                    const ev = sortedEvents[i];
                                    if (ev.eventType === 'postponed') {
                                        const hidden: any[] = [];
                                        while (i + 1 < sortedEvents.length && sortedEvents[i + 1].eventType === 'postponed' && sortedEvents[i + 1].actorId === ev.actorId) {
                                            i++;
                                            hidden.push(sortedEvents[i]);
                                        }
                                        processedEvents.push({
                                            event: ev,
                                            collapsedCount: hidden.length > 0 ? hidden.length : undefined,
                                            collapsedEvents: hidden.length > 0 ? hidden : undefined,
                                            groupKey: ev.id,
                                        });
                                    } else {
                                        processedEvents.push({ event: ev });
                                    }
                                }

                                // Day separator helper
                                const now = new Date();
                                const todayStr = now.toLocaleDateString('ru-RU', { year: 'numeric', month: '2-digit', day: '2-digit' });
                                const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
                                const yesterdayStr = yesterday.toLocaleDateString('ru-RU', { year: 'numeric', month: '2-digit', day: '2-digit' });
                                const getDayLabel = (date: Date) => {
                                    const ds = date.toLocaleDateString('ru-RU', { year: 'numeric', month: '2-digit', day: '2-digit' });
                                    if (ds === todayStr) return 'Сегодня';
                                    if (ds === yesterdayStr) return 'Вчера';
                                    return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
                                };

                                // Group by consecutive actorId
                                const actorGroups: { actorId: string; actorUser: any; actorName: string; items: typeof processedEvents }[] = [];
                                processedEvents.forEach((item) => {
                                    const lastGroup = actorGroups[actorGroups.length - 1];
                                    if (lastGroup && lastGroup.actorId === item.event.actorId) {
                                        lastGroup.items.push(item);
                                    } else {
                                        const actorUser = users.find((u: any) => u.id === item.event.actorId);
                                        const actorName = actorUser ? `${actorUser.firstName} ${actorUser.lastName || ''}`.trim() : 'Система';
                                        actorGroups.push({ actorId: item.event.actorId, actorUser, actorName, items: [item] });
                                    }
                                });

                                // Track last rendered day for separators
                                let lastDay = '';

                                return actorGroups.map((group, gi) => {
                                    // Check if we need a day separator before this group
                                    const groupDay = getDayLabel(new Date(group.items[0].event.createdAt));
                                    let showDaySeparator = false;
                                    if (groupDay !== lastDay) {
                                        showDaySeparator = true;
                                        lastDay = groupDay;
                                    }

                                    return (
                                        <div key={`g-${gi}`}>
                                            {showDaySeparator && (
                                                <div className={`flex items-center gap-2 ${gi > 0 ? 'mt-3 mb-2' : 'mb-2'}`}>
                                                    <span style={{ fontSize: '11px', fontWeight: 500, color: '#94A3B8' }} className="uppercase tracking-wide shrink-0">{groupDay}</span>
                                                    <div className="flex-1 h-px bg-[#F0F0F0]" />
                                                </div>
                                            )}
                                            <div className={`${!showDaySeparator && gi > 0 ? 'mt-2' : ''}`}>
                                                {/* Actor header — initials only, full name on hover */}
                                                <div className="flex items-center gap-1.5 mb-1">
                                                    <TooltipProvider>
                                                        <Tooltip>
                                                            <TooltipTrigger asChild>
                                                                <div
                                                                    className="w-5 h-5 rounded-full flex items-center justify-center text-white text-[9px] font-bold cursor-help shrink-0"
                                                                    style={{ backgroundColor: group.actorUser ? getUserColor(group.actorUser.id) : '#94A3B8' }}
                                                                >
                                                                    {group.actorUser ? getInitials(group.actorUser.firstName, group.actorUser.lastName) : 'С'}
                                                                </div>
                                                            </TooltipTrigger>
                                                            <TooltipContent className="bg-slate-800 border-none text-white text-[11px] font-bold px-2.5 py-1">
                                                                {group.actorName}
                                                            </TooltipContent>
                                                        </Tooltip>
                                                    </TooltipProvider>
                                                </div>
                                                {/* Events */}
                                                <div className="ml-[26px] space-y-1.5">
                                                    {group.items.map((item) => {
                                                        const event = item.event;
                                                        const hasResult = event.payload && (event.payload as any).resultId;
                                                        const resultLabel = hasResult ? dicts?.contact_results?.find((r: any) => r.id === (event.payload as any).resultId)?.label : null;
                                                        const isContactAction = ['called', 'wrote'].includes(event.eventType);
                                                        const isStatusChange = event.eventType === 'status_changed';
                                                        const isCorrected = event.eventType === 'contact_corrected';

                                                        // Build event label
                                                        let eventTitle: React.ReactNode;
                                                        const technicalEventTypes = ['status_changed', 'postponed', 'priority_changed'];
                                                        const isCreated = event.eventType === 'created';

                                                        if (isStatusChange) {
                                                            // Technical: muted
                                                            eventTitle = (
                                                                <div className="flex flex-col">
                                                                    <span style={{ fontWeight: 400, color: '#64748B' }} className="text-[13px]">
                                                                        {dicts?.history_actions?.find((a: any) => a.id === 'status_changed')?.label || 'Смена статуса'}
                                                                    </span>
                                                                    <span style={{ fontWeight: 400, color: '#94A3B8' }} className="text-[12px] mt-0.5">
                                                                        {STATUS_LABELS[(event.payload as any).from] || (event.payload as any).from} → {STATUS_LABELS[(event.payload as any).to] || (event.payload as any).to}
                                                                    </span>
                                                                </div>
                                                            );
                                                        } else if (isCorrected) {
                                                            // User action: bold result transition
                                                            eventTitle = (
                                                                <span style={{ fontWeight: 500 }} className="text-[#111827]">
                                                                    {dicts?.contact_results?.find((r: any) => r.id === (event.payload as any).oldResultId)?.label || (event.payload as any).oldResultId}
                                                                    {' → '}
                                                                    {dicts?.contact_results?.find((r: any) => r.id === (event.payload as any).newResultId)?.label || (event.payload as any).newResultId}
                                                                </span>
                                                            );
                                                        } else if (isContactAction && resultLabel) {
                                                            // User action: bold result
                                                            eventTitle = <span style={{ fontWeight: 500 }} className="text-[#111827]">{resultLabel}</span>;
                                                        } else if (isCreated) {
                                                            // Created: lightest
                                                            eventTitle = <span style={{ fontWeight: 400, color: '#94A3B8' }} className="text-[13px]">{EVENT_LABELS.created}</span>;
                                                        } else if (technicalEventTypes.includes(event.eventType)) {
                                                            // Technical: muted
                                                            const label = dicts?.history_actions?.find((a: any) => a.id === event.eventType)?.label || EVENT_LABELS[event.eventType] || event.eventType;
                                                            eventTitle = <span style={{ fontWeight: 400, color: '#64748B' }} className="text-[13px]">{label}</span>;
                                                        } else {
                                                            // User actions: bold
                                                            const label = dicts?.history_actions?.find((a: any) => a.id === event.eventType)?.label || EVENT_LABELS[event.eventType] || event.eventType;
                                                            eventTitle = <span style={{ fontWeight: 500 }} className="text-[#111827]">{label}</span>;
                                                        }

                                                        return (
                                                            <div key={event.id}>
                                                                <div className="flex items-start gap-2">
                                                                    <div className="flex-1 min-w-0">
                                                                        <div className="flex items-start gap-1.5">
                                                                            <div className="w-1.5 h-1.5 rounded-full bg-[#d1d5db] mt-1.5 shrink-0" />
                                                                            <div className="flex-1 min-w-0">
                                                                                {eventTitle}
                                                                                {/* Postponed detail line */}
                                                                                {event.eventType === 'postponed' && event.payload && (event.payload as any).from && (
                                                                                    <span style={{ fontWeight: 400, color: '#94A3B8' }} className="text-[12px] block mt-0.5">
                                                                                        {`${new Date((event.payload as any).from).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}, ${new Date((event.payload as any).from).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })} → ${new Date((event.payload as any).to).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}, ${new Date((event.payload as any).to).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`}
                                                                                    </span>
                                                                                )}
                                                                                {/* Collapsed postponed toggle */}
                                                                                {item.collapsedCount && item.groupKey && (
                                                                                    <>
                                                                                        {!expandedPostponed.has(item.groupKey) && (
                                                                                            <button
                                                                                                onClick={() => {
                                                                                                    setExpandedPostponed(prev => {
                                                                                                        const next = new Set(prev);
                                                                                                        next.add(item.groupKey!);
                                                                                                        return next;
                                                                                                    });
                                                                                                }}
                                                                                                style={{ fontSize: '11px', fontWeight: 400, color: '#94A3B8' }}
                                                                                                className="block mt-0.5 cursor-pointer hover:text-[#64748B] hover:underline transition-colors"
                                                                                            >
                                                                                                {`ещё ${item.collapsedCount} ${item.collapsedCount === 1 ? 'изменение' : item.collapsedCount < 5 ? 'изменения' : 'изменений'} срока`}
                                                                                            </button>
                                                                                        )}
                                                                                        {expandedPostponed.has(item.groupKey) && item.collapsedEvents && (
                                                                                            <div className="mt-1.5 ml-0">
                                                                                                <span style={{ fontSize: '12px', fontWeight: 500, color: '#64748B' }} className="block mb-1.5">История изменений срока:</span>
                                                                                                <div className="space-y-0.5">
                                                                                                    {/* Include the main event's time range first */}
                                                                                                    {event.payload && (event.payload as any).from && (
                                                                                                        <span style={{ fontWeight: 400, color: '#94A3B8' }} className="text-[12px] block">
                                                                                                            {`${new Date((event.payload as any).from).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })} → ${new Date((event.payload as any).to).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`}
                                                                                                        </span>
                                                                                                    )}
                                                                                                    {item.collapsedEvents.map((ce: any) => (
                                                                                                        <span key={ce.id} style={{ fontWeight: 400, color: '#94A3B8' }} className="text-[12px] block">
                                                                                                            {ce.payload && (ce.payload as any).from
                                                                                                                ? `${new Date((ce.payload as any).from).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })} → ${new Date((ce.payload as any).to).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`
                                                                                                                : ''}
                                                                                                        </span>
                                                                                                    ))}
                                                                                                </div>
                                                                                                <button
                                                                                                    onClick={() => {
                                                                                                        setExpandedPostponed(prev => {
                                                                                                            const next = new Set(prev);
                                                                                                            next.delete(item.groupKey!);
                                                                                                            return next;
                                                                                                        });
                                                                                                    }}
                                                                                                    style={{ fontSize: '11px', fontWeight: 400, color: '#94A3B8' }}
                                                                                                    className="block mt-1.5 cursor-pointer hover:text-[#64748B] hover:underline transition-colors"
                                                                                                >
                                                                                                    Свернуть изменения срока
                                                                                                </button>
                                                                                            </div>
                                                                                        )}
                                                                                    </>
                                                                                )}
                                                                                {(event.payload as any).comment && (
                                                                                    <p className="text-[11px] text-[#4F46E5]/70 italic mt-0.5 bg-blue-50/30 px-1.5 py-0.5 rounded border-l-2 border-blue-200">
                                                                                        «{(event.payload as any).comment}»
                                                                                    </p>
                                                                                )}
                                                                                {event.id === lastContact?.id && (
                                                                                    <button 
                                                                                        onClick={() => handleEditLastContact(event)}
                                                                                        style={{ fontSize: '12px', color: '#94A3B8' }}
                                                                                        className="hover:underline cursor-pointer mt-0.5 block"
                                                                                    >
                                                                                        Изменить
                                                                                    </button>
                                                                                )}
                                                                            </div>
                                                                        </div>
                                                                    </div>
                                                                    <span style={{ fontWeight: 400, color: '#94A3B8' }} className="text-[11px] shrink-0 mt-0.5 w-[90px] text-right">
                                                                        {new Date(event.createdAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) + ', ' + new Date(event.createdAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
                                                                    </span>
                                                                </div>
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            </div>
                                        </div>
                                    );
                                });
                            })()}
                            {(() => {
                                const technicalTypes = ['postponed', 'status_changed', 'priority_changed'];
                                const filteredCount = historyMode === 'actions'
                                    ? details.events.filter((e: any) => !technicalTypes.includes(e.eventType)).length
                                    : details.events.length;
                                return filteredCount > 3 ? (
                                    <button
                                        onClick={() => setIsHistoryExpanded(!isHistoryExpanded)}
                                        style={{ fontSize: '12px', fontWeight: 400, color: '#94A3B8' }}
                                        className="hover:text-[#64748B] hover:underline mt-1.5 cursor-pointer block transition-colors"
                                    >
                                        {isHistoryExpanded ? '\u0421\u0432\u0435\u0440\u043d\u0443\u0442\u044c' : '\u041f\u043e\u043a\u0430\u0437\u0430\u0442\u044c \u0435\u0449\u0451'}
                                    </button>
                                ) : null;
                            })()}
                        </div>
                    ) : (
                        <p className="text-meta !text-[#94A3B8]">Нет событий</p>
                    )}
                </div>
            </div>

            {/* Footer actions */}
            {task.isActive && (
                <div className="px-4 py-3 flex items-center gap-3">
                    <button
                        onClick={() => resolveTask.mutate({ id: task.id, resolution: 'done' })}
                        style={{ height: '36px', padding: '8px 14px', fontSize: '14px', fontWeight: 500, borderRadius: '8px', width: 'auto' }}
                        className="flex items-center justify-center gap-1.5 bg-[#DCFCE7] text-[#166534] hover:bg-[#bbf7d0] transition-colors"
                    >
                        <Check className="w-4 h-4" />
                        Выполнено
                    </button>
                    <button
                        onClick={() => resolveTask.mutate({ id: task.id, resolution: 'cancelled' })}
                        style={{ height: '36px', padding: '8px 14px', fontSize: '14px', fontWeight: 500, borderRadius: '8px', width: 'auto' }}
                        className="flex items-center justify-center gap-1 bg-[#F3F4F6] text-[#374151] hover:bg-[#E5E7EB] transition-colors"
                    >
                        Отменить
                    </button>
                </div>
            )}

            {/* Modal: Результат контакта */}
            {contactAction && (
                <div className="absolute inset-0 z-50 bg-white/95 backdrop-blur-sm flex items-center justify-center p-6 animate-in fade-in duration-200">
                    <div className="w-full max-w-[320px] bg-white rounded-2xl shadow-2xl border border-gray-100 p-5 space-y-4">
                        <div className="flex items-center justify-between">
                            <h4 className="text-[15px] font-bold text-gray-900">{editingEventId ? 'Исправление результата' : 'Результат контакта'}</h4>
                            <button onClick={() => { setContactAction(null); setEditingEventId(null); }} className="p-1 hover:bg-gray-100 rounded-full transition-colors">
                                <X className="w-4 h-4 text-gray-400" />
                            </button>
                        </div>

                        <div className="space-y-3">
                            <div className="space-y-1.5">
                                <label className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">Результат</label>
                                <select 
                                    value={resultId} 
                                    onChange={(e) => setResultId(e.target.value)}
                                    className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2 text-[13px] outline-none focus:border-blue-500 transition-colors cursor-pointer"
                                >
                                    <option value="">Выберите...</option>
                                    {dicts?.contact_results?.map((r: any) => (
                                        <option key={r.id} value={r.id}>{r.label}</option>
                                    ))}
                                </select>
                            </div>

                            <div className="space-y-1.5">
                                <label className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">Комментарий</label>
                                <textarea 
                                    value={comment}
                                    onChange={(e) => setComment(e.target.value.slice(0, 200))}
                                    placeholder="Кратко о главном..."
                                    className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2 text-[13px] outline-none focus:border-blue-500 transition-colors h-20 resize-none"
                                />
                                <div className="text-[10px] text-right text-gray-400">{comment.length}/200</div>
                            </div>
                        </div>

                        <div className="flex gap-2 pt-2">
                            <button 
                                onClick={() => setContactAction(null)}
                                className="flex-1 py-2.5 rounded-xl bg-gray-50 text-gray-600 text-[13px] font-bold hover:bg-gray-100 transition-colors"
                            >
                                Отмена
                            </button>
                            <button 
                                onClick={handleSaveContactResult}
                                disabled={!resultId || isSaving}
                                className="flex-2 py-2.5 rounded-xl bg-blue-600 text-white text-[13px] font-bold hover:bg-blue-700 transition-all shadow-md shadow-blue-200 disabled:opacity-50 disabled:shadow-none"
                            >
                                {isSaving ? 'Сохранение...' : 'Зафиксировать'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}

// ─── Helper component ──────────────────────────────────────────────────────

function MetaField({
    label,
    icon,
    children,
}: {
    label: string
    icon: React.ReactNode
    children: React.ReactNode
}) {
    return (
        <div className="flex flex-col gap-1.5">
            <span className="flex items-center gap-1 text-section-label">
                {icon}
                {label}
            </span>
            {children}
        </div>
    )
}
