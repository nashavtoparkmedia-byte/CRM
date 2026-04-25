"use client"

import { useState, useEffect, useRef, useMemo, useCallback } from "react"
import { useRouter, useSearchParams, usePathname } from "next/navigation"
import { Search, PanelRightClose, PanelRightOpen, AlertCircle, X, ChevronUp, ChevronDown, ClipboardList, UserPlus, CheckCircle2, RotateCcw, UserMinus } from "lucide-react"
import { useChatNavigation } from "../hooks/useChatNavigation"
import { Conversation } from "../hooks/useConversations"
import { useContact } from "../hooks/useContact"

import { getDriverActiveTasks } from '@/app/tasks/actions'
import type { TaskDTO } from '@/lib/tasks/types'
import { getScenario, getStage } from '@/lib/tasks/scenario-config'
import Link from 'next/link'

interface ChatHeaderProps {
    chat: Conversation
    isProfileOpen: boolean
    isSearchActive: boolean
    setIsSearchActive: (v: boolean) => void
    searchQuery: string
    setSearchQuery: (v: string) => void
    searchResultsCount: number
    activeSearchIndex: number
    onSearchNavigate: (direction: 'up' | 'down') => void
    onOpenCreateTask?: () => void
    onConversationUpdate?: () => void
}

export default function ChatHeader({ 
    chat, 
    isProfileOpen,
    isSearchActive,
    setIsSearchActive,
    searchQuery,
    setSearchQuery,
    searchResultsCount,
    activeSearchIndex,
    onSearchNavigate,
    onOpenCreateTask,
    onConversationUpdate
}: ChatHeaderProps) {
    const { toggleProfileDrawer } = useChatNavigation()
    const searchInputRef = useRef<HTMLInputElement>(null)
    const [showTasksPopover, setShowTasksPopover] = useState(false)
    const tasksPopoverRef = useRef<HTMLDivElement>(null)

    // Contact metadata for 2nd line
    const { contact } = useContact(chat.contactId)

    // Real tasks state
    const [tasks, setTasks] = useState<TaskDTO[]>([])
    const [counts, setCounts] = useState({ active: 0, overdue: 0 })
    const [isLoadingTasks, setIsLoadingTasks] = useState(false)

    // Fetch tasks only if we have a driver
    useEffect(() => {
        if (!chat.driver?.id) return
        let isMounted = true
        async function fetchTasks() {
            try {
                setIsLoadingTasks(true)
                const res = await getDriverActiveTasks(chat.driver!.id)
                if (isMounted) {
                    setTasks(res.tasks)
                    setCounts(res.counts)
                }
            } catch (err) {
                console.error('Failed to load tasks for chat header', err)
            } finally {
                if (isMounted) setIsLoadingTasks(false)
            }
        }
        fetchTasks()
        return () => { isMounted = false }
    }, [chat.driver?.id])

    const getStatusLabel = (status: string) => {
        switch (status) {
            case 'new': return 'Новый'
            case 'open': return 'В работе'
            case 'waiting_customer': return 'Ожидаем клиента'
            case 'waiting_internal': return 'Внутренний вопрос'
            case 'resolved': return 'Завершён'
            default: return status
        }
    }

    // Keyboard Shortcuts
    useEffect(() => {
        const handleGlobalKeyDown = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
                e.preventDefault()
                setIsSearchActive(true)
            }
            if (e.key === 'Escape' && isSearchActive) {
                e.preventDefault()
                setIsSearchActive(false)
                setSearchQuery("")
            }
        }
        window.addEventListener('keydown', handleGlobalKeyDown)
        return () => window.removeEventListener('keydown', handleGlobalKeyDown)
    }, [isSearchActive, setIsSearchActive, setSearchQuery])

    // Auto-focus search input when activated
    useEffect(() => {
        if (isSearchActive && searchInputRef.current) {
            searchInputRef.current.focus()
        }
    }, [isSearchActive])

    // Close tasks popover on outside click
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (tasksPopoverRef.current && !tasksPopoverRef.current.contains(e.target as Node)) {
                setShowTasksPopover(false)
            }
        }
        document.addEventListener('mousedown', handleClickOutside)
        return () => document.removeEventListener('mousedown', handleClickOutside)
    }, [])

    const handleSearchKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            e.preventDefault()
            if (e.shiftKey) onSearchNavigate('down')
            else onSearchNavigate('up')
        }
    }

    const taskCount = counts.active

    const searchParams = useSearchParams()
    const isProfileOpenFromUrl = searchParams.get('profile') === '1'

    // Build 2nd line metadata
    const segment = contact?.driver?.segment || chat.driver?.segment
    const masterSource = contact?.masterSource
    const channelCount = contact?.identities?.length ?? chat.allChannels?.length ?? 0

    const SOURCE_LABEL: Record<string, string> = {
        yandex: 'Яндекс',
        chat: 'Чат',
        manual: 'Ручной',
    }

    const SEGMENT_STYLE: Record<string, string> = {
        vip: 'bg-amber-50 text-amber-700',
        active: 'bg-emerald-50 text-emerald-700',
        new: 'bg-blue-50 text-blue-700',
        inactive: 'bg-gray-100 text-gray-500',
        churned: 'bg-red-50 text-red-600',
    }

    const hasMetadata = !!(segment || masterSource || channelCount > 0)

    return (
        <div className="border-b border-[#E8E8E8] shrink-0 flex justify-center bg-white z-20 relative">
            <div className="w-full max-w-[720px] px-4">
                {/* Standard Header View */}
                {!isSearchActive ? (
                    <>
                        {/* Line 1: name, phone, status, action buttons */}
                        <div className="h-[48px] flex items-center justify-between">
                        <div className="flex items-center gap-2.5 min-w-0">
                            <div className="flex items-center gap-1.5 min-w-0">
                                <h3 className="font-semibold text-[15px] text-[#111] leading-none shrink-0">{chat.name || "Водитель"}</h3>
                                <span className="text-[11px] text-gray-400">·</span>
                                <span className="text-[11px] text-gray-500 font-mono truncate">{chat.driver?.phone || chat.externalChatId?.split(':')[1] || chat.externalChatId}</span>
                                <span className="text-[11px] text-gray-400">·</span>
                                <span className={`text-[11px] font-medium ${chat.status === 'open' || chat.status === 'waiting_customer' ? 'text-[#3390EC]' : chat.status === 'resolved' ? 'text-green-500' : 'text-gray-500'}`}>{getStatusLabel(chat.status)}</span>
                            </div>
                        </div>

                        <div className="flex items-center gap-0.5">
                            {/* 📌 Tasks button */}
                            <div className="relative" ref={tasksPopoverRef}>
                                <button 
                                    onClick={() => setShowTasksPopover(!showTasksPopover)}
                                    className={`h-[28px] px-2 rounded-md flex items-center gap-1 text-[11px] font-medium transition-colors ${
                                        showTasksPopover 
                                        ? 'bg-[#3390EC]/10 text-[#3390EC]' 
                                        : taskCount > 0 
                                            ? 'hover:bg-gray-100 text-gray-600' 
                                            : 'hover:bg-gray-100 text-gray-400'
                                    }`}
                                    title="Задачи"
                                >
                                    <ClipboardList size={13} />
                                    <span>📌 {taskCount}</span>
                                </button>

                                {/* Tasks popover */}
                                {showTasksPopover && (
                                    <div className="absolute top-full right-0 mt-1.5 bg-white rounded-xl shadow-xl border border-[#E0E0E0] w-[300px] z-50 animate-in fade-in slide-in-from-top-1 duration-150 overflow-hidden">
                                        <div className="px-3.5 py-2.5 border-b border-[#E8E8E8] flex items-center justify-between">
                                            <span className="text-[13px] font-bold text-[#111]">Задачи контакта</span>
                                            <span className="text-[11px] text-gray-400 font-medium">{taskCount} активных</span>
                                        </div>
                                        <div className="py-1 max-h-[240px] overflow-y-auto custom-scrollbar">
                                            {isLoadingTasks ? (
                                                <div className="px-3.5 py-6 text-center text-[12px] text-gray-400">Загрузка...</div>
                                            ) : tasks.length === 0 ? (
                                                <div className="px-3.5 py-6 text-center text-[12px] text-gray-400">Нет активных задач</div>
                                            ) : (
                                                tasks.map(task => {
                                                    const isOverdue = task.dueAt && new Date(task.dueAt) < new Date()
                                                    let dueLabel = '—'
                                                    if (task.dueAt) {
                                                        dueLabel = new Date(task.dueAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
                                                    }
                                                    return (
                                                        <Link
                                                            key={task.id}
                                                            href={`/tasks?driverId=${chat.driver?.id}`}
                                                            className="w-full px-3.5 py-2 flex items-start gap-2.5 hover:bg-gray-50 transition-colors text-left block"
                                                        >
                                                            <div className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${isOverdue ? 'bg-red-500' : 'bg-[#3390EC]'}`} />
                                                            <div className="flex-1 min-w-0">
                                                                <div className="text-[13px] text-[#111] font-medium truncate">{task.title}</div>
                                                                {task.scenario && (
                                                                    <div className="text-[11px] mt-0.5 text-indigo-500">
                                                                        {getScenario(task.scenario)?.label}{task.stage && <> · {getStage(task.scenario, task.stage)?.label}</>}
                                                                    </div>
                                                                )}
                                                                <div className={`text-[11px] mt-0.5 ${isOverdue ? 'text-red-500 font-semibold' : 'text-gray-400'}`}>
                                                                    Срок: {dueLabel}
                                                                </div>
                                                            </div>
                                                        </Link>
                                                    )
                                                })
                                            )}
                                        </div>
                                        <div className="px-3.5 py-2.5 border-t border-[#E8E8E8] bg-[#f9fafb]">
                                            <button
                                                onClick={() => {
                                                    setShowTasksPopover(false)
                                                    onOpenCreateTask?.()
                                                }}
                                                className="w-full py-1.5 rounded-lg bg-[#3390EC] text-white text-[12px] font-semibold hover:bg-[#2B7FD4] transition-colors"
                                            >
                                                Создать задачу
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>

                            {/* Workflow action buttons */}
                            {!chat.assignedToUserId ? (
                                <button
                                    onClick={async () => {
                                        const userId = document.cookie.split(';').map(c => c.trim()).find(c => c.startsWith('crm_user_id='))?.split('=')[1]
                                        if (!userId) return
                                        await fetch(`/api/chats/${chat.id}/assign`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId }) })
                                        onConversationUpdate?.()
                                    }}
                                    className="h-[28px] px-2 rounded-md hover:bg-blue-50 flex items-center gap-1 text-[11px] font-medium text-[#3390EC] transition-colors"
                                    title="Взять себе"
                                >
                                    <UserPlus size={13} />
                                    <span>Взять</span>
                                </button>
                            ) : (
                                <button
                                    onClick={async () => {
                                        await fetch(`/api/chats/${chat.id}/unassign`, { method: 'POST' })
                                        onConversationUpdate?.()
                                    }}
                                    className="h-[28px] px-2 rounded-md hover:bg-gray-100 flex items-center gap-1 text-[11px] font-medium text-gray-400 transition-colors"
                                    title="Снять назначение"
                                >
                                    <UserMinus size={13} />
                                </button>
                            )}

                            {chat.status !== 'resolved' ? (
                                <button
                                    onClick={async () => {
                                        await fetch(`/api/chats/${chat.id}/resolve`, { method: 'POST' })
                                        onConversationUpdate?.()
                                    }}
                                    className="h-[28px] px-2 rounded-md hover:bg-green-50 flex items-center gap-1 text-[11px] font-medium text-emerald-500 transition-colors"
                                    title="Завершить"
                                >
                                    <CheckCircle2 size={13} />
                                    <span>Завершить</span>
                                </button>
                            ) : (
                                <button
                                    onClick={async () => {
                                        await fetch(`/api/chats/${chat.id}/reopen`, { method: 'POST' })
                                        onConversationUpdate?.()
                                    }}
                                    className="h-[28px] px-2 rounded-md hover:bg-amber-50 flex items-center gap-1 text-[11px] font-medium text-amber-500 transition-colors"
                                    title="Переоткрыть"
                                >
                                    <RotateCcw size={13} />
                                    <span>Открыть</span>
                                </button>
                            )}

                            <button
                                onClick={() => setIsSearchActive(true)}
                                className="h-[28px] w-[28px] rounded-md hover:bg-gray-100 flex items-center justify-center text-gray-400 transition-colors"
                                title="Поиск (Cmd/Ctrl+F)"
                            >
                                <Search size={15} />
                            </button>
                            <button
                                onClick={() => toggleProfileDrawer(!isProfileOpenFromUrl)}
                                className={`h-[28px] w-[28px] rounded-md flex items-center justify-center transition-colors ${
                                    isProfileOpenFromUrl ? 'bg-[#3390EC]/10 text-[#3390EC]' : 'hover:bg-gray-100 text-gray-400'
                                }`}
                                title="Профиль контакта"
                            >
                                {isProfileOpenFromUrl ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
                            </button>
                        </div>
                        </div>

                        {/* Line 2: contact metadata */}
                        {hasMetadata && (
                            <div className="h-[24px] flex items-center gap-2 pb-1">
                                {segment && (
                                    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${SEGMENT_STYLE[segment] || 'bg-gray-100 text-gray-500'}`}>
                                        {segment === 'vip' ? 'VIP' : segment === 'active' ? 'Активный' : segment === 'new' ? 'Новый' : segment === 'inactive' ? 'Неактивный' : segment === 'churned' ? 'Ушёл' : segment}
                                    </span>
                                )}
                                {masterSource && (
                                    <>
                                        <span className="text-[10px] text-gray-300">·</span>
                                        <span className="text-[10px] text-gray-400">
                                            Источник: <span className="font-medium text-gray-500">{SOURCE_LABEL[masterSource] || masterSource}</span>
                                        </span>
                                    </>
                                )}
                                {channelCount > 0 && (
                                    <>
                                        <span className="text-[10px] text-gray-300">·</span>
                                        <span className="text-[10px] text-gray-400">
                                            {channelCount} {channelCount === 1 ? 'канал' : channelCount < 5 ? 'канала' : 'каналов'}
                                        </span>
                                    </>
                                )}
                            </div>
                        )}
                    </>
                ) : (
                /* Search Bar View (In-Place Transformation) */
                <div className="h-[48px] flex-1 flex items-center justify-end w-full animate-in fade-in zoom-in-95 duration-200 origin-right">
                    <div className="flex items-center bg-[#F6F7F8] rounded-[18px] h-[36px] px-3 w-full max-w-[400px]">
                        <Search size={14} className="text-gray-400 shrink-0" />
                        <input 
                            ref={searchInputRef}
                            type="text"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            onKeyDown={handleSearchKeyDown}
                            placeholder="Поиск по истории переписки..."
                            className="bg-transparent border-none outline-none text-[13px] flex-1 px-3 min-w-0"
                        />
                        
                        {searchQuery && (
                            <div className="flex items-center gap-2 shrink-0 border-l border-gray-200 pl-3 ml-1">
                                <span className="text-[12px] font-medium text-gray-400 min-w-[36px] text-center">
                                    {searchResultsCount > 0 ? `${activeSearchIndex + 1} / ${searchResultsCount}` : "0 / 0"}
                                </span>
                                <div className="flex items-center">
                                    <button 
                                        onClick={() => onSearchNavigate('up')}
                                        disabled={searchResultsCount === 0}
                                        className="w-7 h-7 rounded flex items-center justify-center text-gray-500 hover:text-gray-900 hover:bg-gray-200 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
                                        title="Пред. совпадение (Enter)"
                                    >
                                        <ChevronUp size={16} />
                                    </button>
                                    <button 
                                        onClick={() => onSearchNavigate('down')}
                                        disabled={searchResultsCount === 0}
                                        className="w-7 h-7 rounded flex items-center justify-center text-gray-500 hover:text-gray-900 hover:bg-gray-200 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
                                        title="След. совпадение (Shift+Enter)"
                                    >
                                        <ChevronDown size={16} />
                                    </button>
                                </div>
                            </div>
                        )}
                        
                        <button 
                            onClick={() => {
                                setIsSearchActive(false)
                                setSearchQuery("")
                            }}
                            className="w-7 h-7 rounded-full ml-1 flex items-center justify-center text-gray-500 hover:bg-gray-200 hover:text-gray-900 transition-colors shrink-0"
                            title="Закрыть поиск (Esc)"
                        >
                            <X size={14} />
                        </button>
                    </div>
                </div>
            )}
            </div>
        </div>
    )
}
