"use client"

import { useState, useEffect, useRef, useMemo, useCallback } from "react"
import { useRouter, useSearchParams, usePathname } from "next/navigation"
import { Search, PanelRightClose, PanelRightOpen, AlertCircle, X, ChevronUp, ChevronDown, ClipboardList, UserPlus, CheckCircle2, RotateCcw, UserMinus, ArrowLeft, MoreVertical, Check } from "lucide-react"
import { useChatNavigation } from "../hooks/useChatNavigation"
import { Conversation } from "../hooks/useConversations"
import { useContact } from "../hooks/useContact"
import { LeadStatusBadge } from "./LeadStatusBadge"
import { formatChatTitle, formatChatTitleDetailed } from "../utils/message-utils"
import LinkContactModal from "./LinkContactModal"

import { getDriverActiveTasks } from '@/app/tasks/actions'
import type { TaskDTO } from '@/lib/tasks/types'
import { getScenario, getStage } from '@/lib/tasks/scenario-config'
import Link from 'next/link'
import CallButton from '@/components/sip/CallButton'

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
    onBack?: () => void
    activeChannelTab?: string
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
    onConversationUpdate,
    onBack,
    activeChannelTab
}: ChatHeaderProps) {
    const { toggleProfileDrawer } = useChatNavigation()
    const searchInputRef = useRef<HTMLInputElement>(null)
    const [showTasksPopover, setShowTasksPopover] = useState(false)
    const tasksPopoverRef = useRef<HTMLDivElement>(null)
    const [showMobileMenu, setShowMobileMenu] = useState(false)
    const mobileMenuRef = useRef<HTMLDivElement>(null)
    const [copiedPhone, setCopiedPhone] = useState(false)
    // PR-О: modal для привязки чата к водителю
    const [showLinkModal, setShowLinkModal] = useState(false)

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
            if (mobileMenuRef.current && !mobileMenuRef.current.contains(e.target as Node)) {
                setShowMobileMenu(false)
            }
        }
        document.addEventListener('mousedown', handleClickOutside)
        return () => document.removeEventListener('mousedown', handleClickOutside)
    }, [])

    const handleCopyPhone = async () => {
        const raw =
            chat.driver?.phone ||
            contact?.phones?.find?.((p: any) => p.isPrimary)?.phone ||
            contact?.phones?.[0]?.phone ||
            (chat.externalChatId?.startsWith('+') ? chat.externalChatId.split(':')[0] : null) ||
            chat.name
        if (!raw) return
        // Normalize: strip non-digits → reformat as +7XXXXXXXXXX
        const digits = String(raw).replace(/\D/g, '')
        let normalized = raw
        if (digits.length === 11 && (digits[0] === '7' || digits[0] === '8')) {
            normalized = '+7' + digits.slice(1)
        } else if (digits.length === 10) {
            normalized = '+7' + digits
        } else if (digits.length > 6) {
            normalized = '+' + digits
        }
        try {
            await navigator.clipboard.writeText(normalized)
            setCopiedPhone(true)
            setTimeout(() => setCopiedPhone(false), 2000)
        } catch { /* clipboard unavailable */ }
    }

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

    // Метадата-строка показывается всегда, как только у чата есть channel —
    // там теперь живёт LeadStatusBadge (Лид/Водитель/Отток · Канал),
    // который актуален для каждого чата, даже без segment/masterSource.
    const hasMetadata = !!(chat.channel || segment || masterSource || channelCount > 0)

    return (
        <div className="border-b border-[#E8E8E8] shrink-0 flex justify-center bg-white z-20 relative">
            <div className="w-full max-w-[720px] px-[4px]">
                {/* Standard Header View */}
                {!isSearchActive ? (
                    <>
                        {/* Line 1: name, phone, status, action buttons */}
                        <div className="h-[48px] flex items-center justify-between">
                        <div className="flex items-center gap-2.5 min-w-0">
                            {/* Mobile-only back arrow — returns to the chat list (TG pattern) */}
                            {onBack && (
                                <button
                                    onClick={onBack}
                                    className="lg:hidden h-[36px] w-[36px] -ml-1 shrink-0 rounded-full flex items-center justify-center text-gray-600 hover:bg-gray-100 active:bg-gray-200 transition-colors"
                                    title="Назад к списку"
                                    aria-label="Назад к списку"
                                >
                                    <ArrowLeft size={22} />
                                </button>
                            )}
                            <div className="flex items-center gap-1.5 min-w-0">
                                {(() => {
                                    /* PR-З: title с правильным приоритетом источников */
                                    const tgIdentity = contact?.identities?.find(i => i.channel === 'telegram')
                                    const tgMeta = (tgIdentity?.metadata as Record<string, string | null> | null) ?? {}
                                    const detailed = formatChatTitleDetailed({
                                        driverFullName:       chat.driver?.fullName,
                                        contactDisplayName:   contact?.displayName ?? chat.contact?.displayName,
                                        contactNameIsManual:  ['manual', 'yandex'].includes((contact?.displayNameSource ?? chat.contact?.displayNameSource) ?? ''),
                                        chatName:             chat.name,
                                        externalChatId:       chat.externalChatId,
                                        preferTelegramIdentity: activeChannelTab === 'tg' || activeChannelTab === 'telegram',
                                        tgFirstName:          tgMeta.firstName,
                                        tgLastName:           tgMeta.lastName,
                                        tgUsername:           tgMeta.username,
                                        tgPhone:              chat.driver?.phone,
                                    })
                                    const driverPhone = chat.driver?.phone
                                    // Показываем номер из linked Driver если он не дубль title
                                    const subtitle = driverPhone && driverPhone !== detailed.title ? driverPhone : null
                                    return (
                                        <>
                                            <button
                                                onClick={handleCopyPhone}
                                                className={`font-semibold text-[15px] leading-none truncate min-w-0 lg:shrink-0 lg:overflow-visible text-left active:opacity-70 transition-opacity ${detailed.isUnlinked ? 'text-gray-400 italic' : 'text-[#111]'}`}
                                                title="Нажмите чтобы скопировать"
                                            >
                                                {detailed.title}
                                            </button>
                                            {copiedPhone && (
                                                <span className="shrink-0 text-[11px] text-emerald-500 flex items-center gap-0.5">
                                                    <Check size={10} />
                                                    Скопировано
                                                </span>
                                            )}
                                            {detailed.isUnlinked && !copiedPhone && (
                                                <button
                                                    onClick={() => setShowLinkModal(true)}
                                                    className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200 shrink-0 hover:bg-amber-100 transition-colors cursor-pointer"
                                                    title="Кликните чтобы привязать чат к водителю"
                                                >
                                                    Привязать
                                                </button>
                                            )}
                                            {subtitle && !copiedPhone && (
                                                <>
                                                    <span className="text-[11px] text-gray-400">·</span>
                                                    <span className="text-[11px] text-gray-500 font-mono truncate">{subtitle}</span>
                                                </>
                                            )}
                                            {!copiedPhone && (
                                                <>
                                                    <span className="text-[11px] text-gray-400">·</span>
                                                    <span className={`text-[11px] font-medium ${chat.status === 'open' || chat.status === 'waiting_customer' ? 'text-[#3390EC]' : chat.status === 'resolved' ? 'text-green-500' : 'text-gray-500'}`}>
                                                        {getStatusLabel(chat.status)}
                                                    </span>
                                                </>
                                            )}
                                        </>
                                    )
                                })()}
                            </div>
                        </div>

                        <div className="flex items-center gap-0.5">
                            {/* 📌 Tasks button — desktop only (mobile: inside ⋮ menu) */}
                            <div className="relative" ref={tasksPopoverRef}>
                                <button
                                    onClick={() => setShowTasksPopover(!showTasksPopover)}
                                    className={`h-[28px] px-[2px] rounded-md hidden lg:flex items-center gap-1 text-[11px] font-medium transition-colors ${
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
                                                            className="w-full px-3.5 py-[2px] flex items-start gap-2.5 hover:bg-gray-50 transition-colors text-left block"
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

                            {/* Workflow action buttons — desktop only (mobile: inside ⋮ menu) */}
                            {!chat.assignedToUserId ? (
                                <button
                                    onClick={async () => {
                                        const userId = document.cookie.split(';').map(c => c.trim()).find(c => c.startsWith('crm_user_id='))?.split('=')[1]
                                        if (!userId) return
                                        await fetch(`/api/chats/${chat.id}/assign`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId }) })
                                        onConversationUpdate?.()
                                    }}
                                    className="h-[28px] px-[2px] rounded-md hover:bg-blue-50 hidden lg:flex items-center gap-1 text-[11px] font-medium text-[#3390EC] transition-colors"
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
                                    className="h-[28px] px-[2px] rounded-md hover:bg-gray-100 hidden lg:flex items-center gap-1 text-[11px] font-medium text-gray-400 transition-colors"
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
                                    className="h-[28px] px-[2px] rounded-md hover:bg-green-50 hidden lg:flex items-center gap-1 text-[11px] font-medium text-emerald-500 transition-colors"
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
                                    className="h-[28px] px-[2px] rounded-md hover:bg-amber-50 hidden lg:flex items-center gap-1 text-[11px] font-medium text-amber-500 transition-colors"
                                    title="Переоткрыть"
                                >
                                    <RotateCcw size={13} />
                                    <span>Открыть</span>
                                </button>
                            )}

                            {/* Call button — visible on all screens */}
                            {(() => {
                                const phone =
                                    chat.driver?.phone ||
                                    contact?.phones?.find?.((p: any) => p.isPrimary)?.phone ||
                                    contact?.phones?.[0]?.phone ||
                                    (chat.externalChatId?.startsWith('+') ? chat.externalChatId.split(':')[0] : null)
                                if (!phone) return null
                                return <CallButton phoneNumber={phone} label="" />
                            })()}

                            {/* Search — visible on all screens; larger tap target on mobile */}
                            <button
                                onClick={() => setIsSearchActive(true)}
                                className="flex h-[36px] w-[36px] lg:h-[28px] lg:w-[28px] rounded-md hover:bg-gray-100 items-center justify-center text-gray-400 transition-colors"
                                title="Поиск (Cmd/Ctrl+F)"
                            >
                                <Search size={17} className="lg:hidden" />
                                <Search size={15} className="hidden lg:block" />
                            </button>

                            {/* Profile — visible on all screens; larger tap target on mobile */}
                            <button
                                onClick={() => toggleProfileDrawer(!isProfileOpenFromUrl)}
                                className={`flex h-[36px] w-[36px] lg:h-[28px] lg:w-[28px] rounded-md items-center justify-center transition-colors ${
                                    isProfileOpenFromUrl ? 'bg-[#3390EC]/10 text-[#3390EC]' : 'hover:bg-gray-100 text-gray-400'
                                }`}
                                title="Профиль контакта"
                            >
                                {isProfileOpenFromUrl ? <PanelRightClose size={17} className="lg:hidden" /> : <PanelRightOpen size={17} className="lg:hidden" />}
                                {isProfileOpenFromUrl ? <PanelRightClose size={15} className="hidden lg:block" /> : <PanelRightOpen size={15} className="hidden lg:block" />}
                            </button>

                            {/* ⋮ Three-dot menu — mobile only; larger tap target */}
                            <div className="relative lg:hidden" ref={mobileMenuRef}>
                                <button
                                    onClick={() => setShowMobileMenu(v => !v)}
                                    className={`h-[36px] w-[36px] rounded-md flex items-center justify-center transition-colors ${showMobileMenu ? 'bg-gray-100 text-gray-700' : 'text-gray-400 hover:bg-gray-100'}`}
                                    title="Ещё"
                                >
                                    <MoreVertical size={17} />
                                </button>
                                {showMobileMenu && (
                                    <div className="absolute top-full right-0 mt-1 bg-white rounded-xl shadow-xl border border-[#E0E0E0] w-[200px] z-50 overflow-hidden py-1">
                                        {/* Tasks item */}
                                        {chat.driver?.id && (
                                            <button
                                                onClick={() => { setShowMobileMenu(false); onOpenCreateTask?.() }}
                                                className="w-full px-3.5 py-2.5 flex items-center gap-2.5 text-[13px] text-[#111] hover:bg-gray-50 transition-colors"
                                            >
                                                <ClipboardList size={15} className="text-gray-400 shrink-0" />
                                                <span>Задачи <span className="text-gray-400">({taskCount})</span></span>
                                            </button>
                                        )}
                                        {/* Assign/unassign */}
                                        {!chat.assignedToUserId ? (
                                            <button
                                                onClick={async () => {
                                                    setShowMobileMenu(false)
                                                    const userId = document.cookie.split(';').map(c => c.trim()).find(c => c.startsWith('crm_user_id='))?.split('=')[1]
                                                    if (!userId) return
                                                    await fetch(`/api/chats/${chat.id}/assign`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId }) })
                                                    onConversationUpdate?.()
                                                }}
                                                className="w-full px-3.5 py-2.5 flex items-center gap-2.5 text-[13px] text-[#3390EC] hover:bg-gray-50 transition-colors"
                                            >
                                                <UserPlus size={15} className="shrink-0" />
                                                <span>Взять себе</span>
                                            </button>
                                        ) : (
                                            <button
                                                onClick={async () => {
                                                    setShowMobileMenu(false)
                                                    await fetch(`/api/chats/${chat.id}/unassign`, { method: 'POST' })
                                                    onConversationUpdate?.()
                                                }}
                                                className="w-full px-3.5 py-2.5 flex items-center gap-2.5 text-[13px] text-gray-500 hover:bg-gray-50 transition-colors"
                                            >
                                                <UserMinus size={15} className="shrink-0" />
                                                <span>Снять назначение</span>
                                            </button>
                                        )}
                                        {/* Resolve/reopen */}
                                        {chat.status !== 'resolved' ? (
                                            <button
                                                onClick={async () => {
                                                    setShowMobileMenu(false)
                                                    await fetch(`/api/chats/${chat.id}/resolve`, { method: 'POST' })
                                                    onConversationUpdate?.()
                                                }}
                                                className="w-full px-3.5 py-2.5 flex items-center gap-2.5 text-[13px] text-emerald-600 hover:bg-gray-50 transition-colors"
                                            >
                                                <CheckCircle2 size={15} className="shrink-0" />
                                                <span>Завершить чат</span>
                                            </button>
                                        ) : (
                                            <button
                                                onClick={async () => {
                                                    setShowMobileMenu(false)
                                                    await fetch(`/api/chats/${chat.id}/reopen`, { method: 'POST' })
                                                    onConversationUpdate?.()
                                                }}
                                                className="w-full px-3.5 py-2.5 flex items-center gap-2.5 text-[13px] text-amber-600 hover:bg-gray-50 transition-colors"
                                            >
                                                <RotateCcw size={15} className="shrink-0" />
                                                <span>Открыть чат</span>
                                            </button>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>
                        </div>

                        {/* Line 2: contact metadata — скрыта на мобиле (каналы видны в табах) */}
                        {hasMetadata && (
                            <div className="h-[24px] hidden lg:flex items-center gap-[2px] pb-1">
                                {/* Бейдж этапа жизни: Лид · Канал /
                                    Водитель · Канал / Отток · Канал.
                                    contact.driver приходит из useContact —
                                    содержит lastOrderAt и dismissedAt. */}
                                <LeadStatusBadge
                                    channel={chat.channel}
                                    driver={contact?.driver ?? chat.driver}
                                />
                                {segment && (
                                    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${SEGMENT_STYLE[segment] || 'bg-gray-100 text-gray-500'}`}>
                                        {segment === 'vip' ? 'VIP' : segment === 'active' ? 'Активный' : segment === 'new' ? 'Новый' : segment === 'inactive' ? 'Неактивный' : segment === 'churned' ? 'Ушёл' : segment}
                                    </span>
                                )}
                                {/* «Источник» и счётчик каналов — служебная инфа, на мобиле
                                    скрываем (юзеру в шапке диалога не нужна), на ПК оставляем. */}
                                {masterSource && (
                                    <span className="hidden lg:inline-flex items-center gap-[2px]">
                                        <span className="text-[10px] text-gray-300">·</span>
                                        <span className="text-[10px] text-gray-400">
                                            Источник: <span className="font-medium text-gray-500">{SOURCE_LABEL[masterSource] || masterSource}</span>
                                        </span>
                                    </span>
                                )}
                                {channelCount > 0 && (
                                    <span className="hidden lg:inline-flex items-center gap-[2px]">
                                        <span className="text-[10px] text-gray-300">·</span>
                                        <span className="text-[10px] text-gray-400">
                                            {channelCount} {channelCount === 1 ? 'канал' : channelCount < 5 ? 'канала' : 'каналов'}
                                        </span>
                                    </span>
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
                            <div className="flex items-center gap-[2px] shrink-0 border-l border-gray-200 pl-3 ml-1">
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
            {/* PR-О: modal привязки чата к водителю */}
            <LinkContactModal
                chatId={chat.id}
                isOpen={showLinkModal}
                onClose={() => setShowLinkModal(false)}
                onLinked={() => {
                    onConversationUpdate?.()
                }}
            />
        </div>
    )
}
