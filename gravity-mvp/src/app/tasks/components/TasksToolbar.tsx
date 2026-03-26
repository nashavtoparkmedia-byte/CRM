'use client'

import { useTasksStore } from '@/store/tasks-store'
import { useTaskCounts } from '@/store/tasks-selectors'
import type { TaskView } from '@/lib/tasks/types'
import {
    List,
    Columns3,
    Calendar,
    Search,
    X,
    Bell,
    AlertTriangle,
    Plus,
} from 'lucide-react'
import { useState } from 'react'
import GlobalTaskCreateModal from './GlobalTaskCreateModal'

const VIEW_OPTIONS: { key: TaskView; label: string; icon: typeof List }[] = [
    { key: 'list', label: 'Список', icon: List },
    { key: 'board', label: 'Доска', icon: Columns3 },
    { key: 'timeline', label: 'Время', icon: Calendar },
]

const STATUS_OPTIONS = [
    { value: 'all', label: 'Все статусы' },
    { value: 'todo', label: 'К выполнению' },
    { value: 'in_progress', label: 'В работе' },
    { value: 'waiting_reply', label: 'Ждет ответа' },
    { value: 'overdue', label: 'Просрочено' },
    { value: 'done', label: 'Выполнено' },
]

const PRIORITY_OPTIONS = [
    { value: 'all', label: 'Все приоритеты' },
    { value: 'high', label: 'Высокий' },
    { value: 'medium', label: 'Обычный' },
]

const SOURCE_OPTIONS = [
    { value: 'all', label: 'Все источники' },
    { value: 'auto', label: 'Авто' },
    { value: 'manual', label: 'Ручная' },
    { value: 'chat', label: 'Из чата' },
]

export default function TasksToolbar() {
    const currentView = useTasksStore((s) => s.currentView)
    const setView = useTasksStore((s) => s.setView)
    const filters = useTasksStore((s) => s.filters)
    const setFilters = useTasksStore((s) => s.setFilters)
    const resetFilters = useTasksStore((s) => s.resetFilters)
    const counts = useTaskCounts()
    const [searchOpen, setSearchOpen] = useState(false)
    const [searchValue, setSearchValue] = useState('')
    const [isCreateModalOpen, setIsCreateModalOpen] = useState(false)

    const handleSearch = (value: string) => {
        setSearchValue(value)
        setFilters({ search: value || undefined })
    }

    const hasActiveFilters =
        (filters.status && filters.status !== 'all') ||
        (filters.priority && filters.priority !== 'all') ||
        (filters.source && filters.source !== 'all') ||
        filters.search

    return (
        <div className="flex flex-col gap-3">
            {/* Row 1: View Switcher + Quick Stats + Search */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    {/* View Switcher */}
                    <div className="flex items-center bg-[#f3f4f6] rounded-lg p-0.5">
                        {VIEW_OPTIONS.map((opt) => (
                            <button
                                key={opt.key}
                                onClick={() => setView(opt.key)}
                                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[13px] font-medium transition-all ${
                                    currentView === opt.key
                                        ? 'bg-white text-[#4f46e5] shadow-sm'
                                        : 'text-[#6b7280] hover:text-[#374151]'
                                }`}
                            >
                                <opt.icon className="w-3.5 h-3.5" />
                                {opt.label}
                            </button>
                        ))}
                    </div>

                    {/* Quick Stats */}
                    <div className="flex items-center gap-3 ml-4 text-[12px] text-[#9ca3af]">
                        <span className="flex items-center gap-1">
                            <span className="font-semibold text-[#374151]">{counts.active}</span>
                            активных
                        </span>
                        {counts.overdue > 0 && (
                            <span className="flex items-center gap-1 text-red-500">
                                <AlertTriangle className="w-3 h-3" />
                                <span className="font-semibold">{counts.overdue}</span>
                                просрочено
                            </span>
                        )}
                        {counts.hasNewReply > 0 && (
                            <span className="flex items-center gap-1 text-blue-500">
                                <Bell className="w-3 h-3" />
                                <span className="font-semibold">{counts.hasNewReply}</span>
                                с ответом
                            </span>
                        )}
                    </div>
                </div>

                {/* Search */}
                <div className="flex items-center gap-2">
                    {searchOpen ? (
                        <div className="flex items-center bg-[#f3f4f6] rounded-lg overflow-hidden">
                            <Search className="w-4 h-4 text-[#9ca3af] ml-3" />
                            <input
                                autoFocus
                                value={searchValue}
                                onChange={(e) => handleSearch(e.target.value)}
                                placeholder="Поиск по задачам..."
                                className="bg-transparent border-none outline-none text-sm px-2 py-1.5 w-[220px]"
                            />
                            <button
                                onClick={() => {
                                    setSearchOpen(false)
                                    handleSearch('')
                                }}
                                className="p-1.5 hover:bg-[#e5e7eb] rounded-md mr-1 transition-colors"
                            >
                                <X className="w-3.5 h-3.5 text-[#9ca3af]" />
                            </button>
                        </div>
                    ) : (
                        <button
                            onClick={() => setSearchOpen(true)}
                            className="p-2 rounded-lg hover:bg-[#f3f4f6] transition-colors text-[#6b7280]"
                        >
                            <Search className="w-4 h-4" />
                        </button>
                    )}
                    
                    <button
                        onClick={() => setIsCreateModalOpen(true)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#4f46e5] text-white text-[13px] font-semibold hover:bg-[#4338ca] transition-colors ml-2 shadow-sm"
                    >
                        <Plus className="w-4 h-4" />
                        Создать задачу
                    </button>
                </div>
            </div>

            {/* Row 2: Filters */}
            <div className="flex items-center gap-2">
                <select
                    value={(filters.status as string) ?? 'all'}
                    onChange={(e) => setFilters({ status: e.target.value as any })}
                    className="text-[13px] bg-[#f9fafb] border border-[#e5e7eb] rounded-lg px-3 py-1.5 text-[#374151] outline-none focus:border-[#4f46e5] transition-colors cursor-pointer"
                >
                    {STATUS_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                </select>

                <select
                    value={(filters.priority as string) ?? 'all'}
                    onChange={(e) => setFilters({ priority: e.target.value as any })}
                    className="text-[13px] bg-[#f9fafb] border border-[#e5e7eb] rounded-lg px-3 py-1.5 text-[#374151] outline-none focus:border-[#4f46e5] transition-colors cursor-pointer"
                >
                    {PRIORITY_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                </select>

                <select
                    value={(filters.source as string) ?? 'all'}
                    onChange={(e) => setFilters({ source: e.target.value as any })}
                    className="text-[13px] bg-[#f9fafb] border border-[#e5e7eb] rounded-lg px-3 py-1.5 text-[#374151] outline-none focus:border-[#4f46e5] transition-colors cursor-pointer"
                >
                    {SOURCE_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                </select>

                {hasActiveFilters && (
                    <button
                        onClick={resetFilters}
                        className="flex items-center gap-1 text-[12px] text-[#6b7280] hover:text-[#ef4444] transition-colors ml-1"
                    >
                        <X className="w-3 h-3" />
                        Сбросить
                    </button>
                )}
            </div>

            {isCreateModalOpen && (
                <GlobalTaskCreateModal onClose={() => setIsCreateModalOpen(false)} />
            )}
        </div>
    )
}
