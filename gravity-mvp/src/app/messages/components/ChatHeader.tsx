"use client"

import { useState, useEffect, useRef } from "react"
import { useRouter, useSearchParams, usePathname } from "next/navigation"
import { Search, PanelRightClose, PanelRightOpen, AlertCircle, X, ChevronUp, ChevronDown, ClipboardList } from "lucide-react"
import { useChatNavigation } from "../hooks/useChatNavigation"
import { Conversation } from "../hooks/useConversations"

// Mock tasks for demo — in production this would be fetched from API
const mockTasks = [
    { id: '1', title: 'Позвонить клиенту', dueLabel: 'Сегодня', status: 'active' },
    { id: '2', title: 'Проверить документы', dueLabel: 'Завтра', status: 'active' },
    { id: '3', title: 'Назначить смену', dueLabel: 'Просрочено', status: 'overdue' },
]

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
    onSearchNavigate
}: ChatHeaderProps) {
    const { toggleProfileDrawer } = useChatNavigation()
    const searchInputRef = useRef<HTMLInputElement>(null)
    const [showTasksPopover, setShowTasksPopover] = useState(false)
    const tasksPopoverRef = useRef<HTMLDivElement>(null)

    const getStatusLabel = (status: string) => {
        switch (status) {
            case 'new': return 'Новый'
            case 'active': return 'В работе'
            case 'waiting': return 'Ожидаем ответ'
            case 'closed': return 'Закрыт'
            default: return status.toUpperCase()
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

    const activeTasks = mockTasks.filter(t => t.status === 'active' || t.status === 'overdue')
    const taskCount = activeTasks.length

    const searchParams = useSearchParams()
    const isProfileOpenFromUrl = searchParams.get('profile') === '1'

    return (
        <div className="h-[48px] border-b border-[#E8E8E8] shrink-0 flex justify-center bg-white z-20 relative">
            <div className="w-full max-w-[720px] flex items-center justify-between px-4">
                {/* Standard Header View */}
                {!isSearchActive ? (
                    <>
                        <div className="flex items-center gap-2.5 min-w-0">
                            <div className="flex items-center gap-1.5 min-w-0">
                                <h3 className="font-semibold text-[15px] text-[#111] leading-none shrink-0">{chat.name || "Водитель"}</h3>
                                {chat.requiresResponse && (
                                    <AlertCircle size={10} className="text-red-500 shrink-0" />
                                )}
                                <span className="text-[11px] text-gray-400">·</span>
                                <span className="text-[11px] text-gray-500 font-mono truncate">{chat.driver?.phone || chat.externalChatId?.split(':')[1] || chat.externalChatId}</span>
                                <span className="text-[11px] text-gray-400">·</span>
                                <span className={`text-[11px] font-medium ${chat.status === 'active' ? 'text-[#3390EC]' : 'text-gray-500'}`}>{getStatusLabel(chat.status)}</span>
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
                                            {activeTasks.length === 0 ? (
                                                <div className="px-3.5 py-6 text-center text-[12px] text-gray-400">Нет активных задач</div>
                                            ) : (
                                                activeTasks.map(task => (
                                                    <button
                                                        key={task.id}
                                                        className="w-full px-3.5 py-2 flex items-start gap-2.5 hover:bg-gray-50 transition-colors text-left"
                                                    >
                                                        <div className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${task.status === 'overdue' ? 'bg-red-500' : 'bg-[#3390EC]'}`} />
                                                        <div className="flex-1 min-w-0">
                                                            <div className="text-[13px] text-[#111] font-medium truncate">{task.title}</div>
                                                            <div className={`text-[11px] mt-0.5 ${task.status === 'overdue' ? 'text-red-500 font-semibold' : 'text-gray-400'}`}>
                                                                {task.dueLabel}
                                                            </div>
                                                        </div>
                                                    </button>
                                                ))
                                            )}
                                        </div>
                                    </div>
                                )}
                            </div>

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
                    </>
                ) : (
                /* Search Bar View (In-Place Transformation) */
                <div className="flex-1 flex items-center justify-end w-full animate-in fade-in zoom-in-95 duration-200 origin-right">
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
