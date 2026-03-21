"use client"

import { useState, useMemo, useEffect, useRef } from "react"
import { Search, LayoutGrid, AlertCircle, MessageSquare, Plus, Bot, Zap, Users, BarChart3, Truck, Settings } from "lucide-react"
import Link from "next/link"
import { useDebounce } from "use-debounce"
import { Virtuoso } from "react-virtuoso"
import { useChatNavigation } from "../hooks/useChatNavigation"
import { useConversations, Conversation } from "../hooks/useConversations"
import NewChatPopover from "./NewChatPopover"

export default function ChatList({ selectedChatId, activeListTab, activeChannelTab }: { selectedChatId: string | null, activeListTab: string, activeChannelTab?: string }) {
    const { conversations, setConversations, isLoading } = useConversations()
    const { setChatId, setListTab, setChannel } = useChatNavigation()

    const [searchQuery, setSearchQuery] = useState("")
    const [debouncedSearch] = useDebounce(searchQuery, 200)
    const [showCrmPanel, setShowCrmPanel] = useState(false)
    const [showNewChat, setShowNewChat] = useState(false)
    const crmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    const currentChannelTab = activeChannelTab || 'all'

    // Filter Logic
    const filteredConversations = useMemo(() => {
        let list = conversations

        // 1. Text Search
        if (debouncedSearch) {
            const query = debouncedSearch.toLowerCase()
            list = list.filter(c => 
                c.name?.toLowerCase().includes(query) || 
                c.driver?.phone?.includes(query) ||
                c.externalChatId?.toLowerCase().includes(query)
            )
        }

        // 2. Channel Filter
        if (currentChannelTab !== 'all') {
            const normalizedChannel = currentChannelTab === 'wa' ? 'whatsapp' : currentChannelTab === 'tg' ? 'telegram' : currentChannelTab === 'ypro' ? 'yandex_pro' : currentChannelTab
            list = list.filter(c => 
                c.allChannels?.includes(normalizedChannel) || c.channel === normalizedChannel
            )
        }

        // 3. Tab Filter
        if (activeListTab === 'unread') {
            list = list.filter(c => c.unreadCount > 0 || c.requiresResponse)
        } else if (activeListTab === 'assigned') {
            list = list.filter(c => c.status === 'active')
        } else if (activeListTab === 'auto') {
            list = list.filter(c => c.messages?.some((m: any) => m.origin === 'auto'))
        } else if (activeListTab === 'ai') {
            list = list.filter(c => c.messages?.some((m: any) => m.origin === 'ai'))
        }

        return list
    }, [conversations, debouncedSearch, activeListTab, currentChannelTab])

    // Keyboard Navigation
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            const activeEl = document.activeElement
            const activeTag = activeEl?.tagName.toLowerCase()
            const isSearchInput = activeEl?.getAttribute('placeholder') === 'Поиск...'
            
            if (activeTag === 'textarea' || (activeTag === 'input' && !isSearchInput)) {
                return
            }

            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                if (filteredConversations.length === 0) return
                
                const currentIndex = filteredConversations.findIndex(c => c.id === selectedChatId || c.allChatIds?.includes(selectedChatId!))
                let nextIndex = 0
                
                if (currentIndex === -1) {
                    nextIndex = 0
                } else if (e.key === 'ArrowDown') {
                    nextIndex = currentIndex < filteredConversations.length - 1 ? currentIndex + 1 : currentIndex
                } else if (e.key === 'ArrowUp') {
                    nextIndex = currentIndex > 0 ? currentIndex - 1 : 0
                }
                
                const nextChatId = filteredConversations[nextIndex].id
                setChatId(nextChatId)
                
                setTimeout(() => {
                    const btn = document.getElementById(`chat-row-${nextChatId}`)
                    if (btn) btn.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
                }, 10)
            }

            if (e.key === 'Enter') {
                if (isSearchInput || (activeTag !== 'input' && activeTag !== 'textarea')) {
                    e.preventDefault()
                    const composer = document.getElementById('message-composer')
                    if (composer) composer.focus()
                }
            }
        }

        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [filteredConversations, selectedChatId, setChatId])

    // Local unread reset when chat is selected
    useEffect(() => {
        if (!selectedChatId || !setConversations) return
        
        setConversations((prev: Conversation[]) => prev.map(c => {
            if (c.id === selectedChatId || (c.allChatIds && c.allChatIds.includes(selectedChatId))) {
                if (c.unreadCount === 0) return c
                return { ...c, unreadCount: 0 }
            }
            return c
        }))
    }, [selectedChatId, setConversations])

    const getChannelBadge = (channel: string) => {
        switch (channel) {
            case 'whatsapp': return <span className="text-[8px] font-bold text-emerald-600 bg-emerald-50 px-1 py-px rounded leading-none">WA</span>
            case 'telegram': return <span className="text-[8px] font-bold text-blue-600 bg-blue-50 px-1 py-px rounded leading-none">TG</span>
            case 'max': return <span className="text-[8px] font-bold text-purple-600 bg-purple-50 px-1 py-px rounded leading-none">MAX</span>
            case 'yandex_pro': return <span className="text-[8px] font-bold text-yellow-600 bg-yellow-50 px-1 py-px rounded leading-none">YP</span>
            default: return null
        }
    }

    const listTabs = [
        { id: 'all', label: 'Все' },
        { id: 'unread', label: 'Новые' },
        { id: 'assigned', label: 'Мои' },
        { id: 'auto', label: 'Авто', icon: Zap, color: 'text-amber-500' },
        { id: 'ai', label: 'AI', icon: Bot, color: 'text-violet-500' },
    ]

    const channelTabs = [
        { id: 'all', label: 'All' },
        { id: 'wa', label: 'WA', dotColor: 'bg-emerald-500' },
        { id: 'tg', label: 'TG', dotColor: 'bg-blue-500' },
        { id: 'max', label: 'MAX', dotColor: 'bg-purple-500' },
        { id: 'ypro', label: 'YP', dotColor: 'bg-yellow-500' },
    ]

    const renderChatItem = (index: number, chat: Conversation) => {
        const isSelected = selectedChatId === chat.id || (chat.allChatIds && chat.allChatIds.includes(selectedChatId!))
        const timeString = chat.lastMessageAt ? new Date(chat.lastMessageAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
        const snippet = chat.messages?.[0]?.content || "Сообщений пока нет"

        return (
            <div id={`chat-row-${chat.id}`} className="px-2 py-0.5">
                <button
                    onClick={() => {
                        setChatId(chat.id)
                        // Local update triggered by useEffect as well, but this is for instant feedback
                        if (setConversations) {
                             setConversations((prev: Conversation[]) => prev.map((c: Conversation) => c.id === chat.id ? { ...c, unreadCount: 0 } : c))
                        }
                    }}
                    className={`w-full text-left flex items-center gap-3 px-3 h-[72px] rounded-xl transition-all relative ${
                        isSelected 
                        ? 'bg-[#3390EC] shadow-md z-10' 
                        : 'hover:bg-[#F0F2F5]'
                    }`}
                >
                    <div className="relative shrink-0">
                        <div className={`h-[48px] w-[48px] rounded-full flex items-center justify-center font-bold text-[15px] ${
                            isSelected 
                            ? 'bg-white/20 text-white' 
                            : 'bg-[#DEE3E8] text-[#546574]'
                        }`}>
                            {chat.name?.substring(0, 1).toUpperCase() || "D"}
                        </div>
                        <div className={`absolute -bottom-0.5 -right-0.5 rounded-full p-0.5 border ${isSelected ? 'bg-[#3390EC] border-[#3390EC]' : 'bg-white border-white'}`}>
                            {getChannelBadge(chat.channel)}
                        </div>
                    </div>

                    <div className="flex-1 min-w-0 flex flex-col justify-center">
                        <div className="flex items-center justify-between gap-1">
                            <span className={`font-bold text-[14px] truncate leading-tight ${isSelected ? 'text-white' : 'text-[#111]'}`}>
                                {chat.name || "Водитель"}
                            </span>
                            <span className={`text-[11px] font-medium shrink-0 ${isSelected ? 'text-white/60' : 'text-[#8A9099]'}`}>
                                {timeString}
                            </span>
                        </div>
                        
                        <p className={`text-[13px] leading-[16px] truncate pr-6 mt-0.5 font-medium ${isSelected ? 'text-white/80' : 'text-[#8A9099]'}`}>
                            {snippet}
                        </p>
                    </div>

                    {chat.unreadCount > 0 && !isSelected && (
                        <div className="absolute right-3 bottom-3">
                            <div className="h-[20px] min-w-[20px] px-1.5 rounded-full flex items-center justify-center text-[11px] font-bold bg-[#3390EC] text-white shadow-sm ring-1 ring-white/20">
                                {chat.unreadCount}
                            </div>
                        </div>
                    )}

                    {chat.requiresResponse && !isSelected && (
                        <div className="absolute right-3 top-3">
                            <AlertCircle size={12} className="text-[#FF5252]" />
                        </div>
                    )}
                </button>
            </div>
        )
    }

    return (
        <div className="w-[400px] bg-[#FAFAFA] border-r border-[#E8E8E8] shrink-0 h-full flex flex-col relative">
            {/* Header */}
            <div className="h-[48px] px-3.5 flex items-center justify-between shrink-0 bg-white border-b border-[#E8E8E8]">
                <div
                    onMouseEnter={() => { crmTimerRef.current && clearTimeout(crmTimerRef.current); setShowCrmPanel(true) }}
                    onMouseLeave={() => { crmTimerRef.current = setTimeout(() => setShowCrmPanel(false), 200) }}
                    className="relative"
                >
                    <button
                        className={`w-[28px] h-[28px] rounded-lg flex items-center justify-center transition-colors ${
                            showCrmPanel ? 'bg-[#3390EC]/10 text-[#3390EC]' : 'hover:bg-gray-100 text-gray-400 hover:text-gray-700'
                        }`}
                        title="CRM"
                    >
                        <LayoutGrid size={16} />
                    </button>
                </div>
                <h2 className="text-[15px] font-semibold text-[#111] tracking-tight">Чаты</h2>
                <div className="relative">
                    <button 
                        onClick={() => setShowNewChat(!showNewChat)}
                        className={`w-[28px] h-[28px] rounded-lg flex items-center justify-center transition-colors ${
                            showNewChat ? 'bg-[#3390EC] text-white' : 'hover:bg-[#3390EC]/10 text-[#3390EC]'
                        }`}
                        title="Написать первым"
                    >
                        <Plus size={18} />
                    </button>
                    {showNewChat && <NewChatPopover onClose={() => setShowNewChat(false)} />}
                </div>
            </div>

            {/* CRM Slide-in Sidebar */}
            {showCrmPanel && (
                <div 
                    className="absolute top-[48px] left-0 bottom-0 w-[280px] bg-white border-r border-[#E0E0E0] shadow-xl z-50 animate-in slide-in-from-left duration-200 flex flex-col"
                    onMouseEnter={() => { crmTimerRef.current && clearTimeout(crmTimerRef.current); setShowCrmPanel(true) }}
                    onMouseLeave={() => { crmTimerRef.current = setTimeout(() => setShowCrmPanel(false), 200) }}
                >
                    <div className="px-4 pt-4 pb-3">
                        <h3 className="text-[16px] font-bold text-[#111]">Gravity CRM</h3>
                        <p className="text-[12px] text-gray-500 mt-0.5">Перейти в модуль</p>
                    </div>
                    <div className="flex-1 py-1">
                        <Link href="/" className="flex items-center gap-3 px-4 h-[44px] text-[14px] text-[#111] hover:bg-gray-50 transition-colors font-medium">
                            <BarChart3 size={18} className="text-gray-400" />
                            Дашборд
                        </Link>
                        <Link href="/drivers" className="flex items-center gap-3 px-4 h-[44px] text-[14px] text-[#111] hover:bg-gray-50 transition-colors font-medium">
                            <Truck size={18} className="text-gray-400" />
                            Водители
                        </Link>
                        <Link href="/users" className="flex items-center gap-3 px-4 h-[44px] text-[14px] text-[#111] hover:bg-gray-50 transition-colors font-medium">
                            <Users size={18} className="text-gray-400" />
                            Пользователи
                        </Link>
                        <Link href="/messages" className="flex items-center gap-3 px-4 h-[44px] text-[14px] text-[#3390EC] bg-[#3390EC]/5 transition-colors font-medium">
                            <MessageSquare size={18} className="text-[#3390EC]" />
                            Чаты
                        </Link>
                        <div className="h-px bg-[#E8E8E8] mx-4 my-1" />
                        <Link href="/settings" className="flex items-center gap-3 px-4 h-[44px] text-[14px] text-gray-500 hover:bg-gray-50 transition-colors">
                            <Settings size={18} className="text-gray-400" />
                            Настройки
                        </Link>
                    </div>
                </div>
            )}
            
            {/* Search */}
            <div className="px-3.5 pt-2 pb-1.5 shrink-0">
                <div className="relative group">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 group-focus-within:text-gray-600 transition-colors" size={15} />
                    <input 
                        type="text" 
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Поиск..."
                        className="w-full h-[32px] bg-[#F4F5F7] rounded-[16px] pl-9 pr-3 text-[13px] outline-none placeholder:text-gray-400 transition-colors font-medium text-[#111]"
                    />
                </div>
            </div>

            {/* Channel filter */}
            <div className="px-4 pb-1.5 shrink-0 flex items-center gap-0.5">
                {channelTabs.map((ch, idx) => {
                    const isActive = currentChannelTab === ch.id
                    return (
                        <div key={ch.id} className="flex items-center">
                            {idx > 0 && <span className="text-gray-300 text-[10px] mx-1">·</span>}
                            <button
                                onClick={() => setChannel(ch.id as any)}
                                className={`text-[12px] transition-all px-0.5 ${
                                    isActive 
                                    ? 'text-[#111] font-bold' 
                                    : 'text-gray-400 hover:text-gray-600 font-medium'
                                }`}
                            >
                                {ch.label}
                            </button>
                        </div>
                    )
                })}
            </div>

            {/* Status tabs */}
            <div className="px-3 pb-1.5 shrink-0 flex gap-1 overflow-x-auto no-scrollbar border-b border-gray-100/50">
                {listTabs.map(tab => {
                    const isActive = activeListTab === tab.id
                    const Icon = tab.icon
                    return (
                        <button 
                            key={tab.id}
                            onClick={() => setListTab(tab.id as any)}
                            className={`h-[24px] px-2 text-[11px] rounded-md transition-all flex items-center gap-1 whitespace-nowrap shrink-0 ${
                                isActive 
                                ? 'bg-white text-[#111] font-semibold shadow-[0_1px_2px_rgba(0,0,0,0.06)]' 
                                : 'text-gray-400 hover:text-gray-600 hover:bg-white/50'
                            }`}
                        >
                            {Icon && <Icon size={11} className={isActive ? tab.color : ''} />}
                            {tab.label}
                        </button>
                    )
                })}
            </div>

            {/* Chat list */}
            <div className="flex-1 w-full relative">
                {isLoading ? (
                    <div className="absolute inset-0 flex flex-col pt-1 px-1 gap-0.5 overflow-hidden">
                        {[...Array(9)].map((_, i) => (
                            <div key={i} className="w-full h-[64px] flex items-center gap-2.5 px-3">
                                <div className="h-10 w-10 rounded-full bg-gray-200/50 shrink-0 animate-pulse" />
                                <div className="flex-1 flex flex-col gap-1.5">
                                    <div className="h-3 w-1/2 bg-gray-200/50 rounded animate-pulse" />
                                    <div className="h-2.5 w-3/4 bg-gray-100 rounded animate-pulse" />
                                </div>
                            </div>
                        ))}
                    </div>
                ) : filteredConversations.length === 0 ? (
                    <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-400 pb-20">
                        {activeListTab === 'auto' ? (
                            <>
                                <Zap size={28} className="opacity-20 mb-3 text-amber-400" />
                                <span className="text-[13px] font-medium">Нет авто-сообщений</span>
                                <span className="text-[11px] text-gray-400 mt-1">Триггерные рассылки появятся здесь</span>
                            </>
                        ) : activeListTab === 'ai' ? (
                            <>
                                <Bot size={28} className="opacity-20 mb-3 text-violet-400" />
                                <span className="text-[13px] font-medium">AI агент неактивен</span>
                                <span className="text-[11px] text-gray-400 mt-1">Переписки агента появятся здесь</span>
                            </>
                        ) : (
                            <>
                                <MessageSquare size={32} className="opacity-20 mb-3" />
                                <span className="text-[13px] font-medium">{debouncedSearch ? "Ничего не найдено" : "Нет чатов"}</span>
                            </>
                        )}
                    </div>
                ) : (
                    <Virtuoso
                        style={{ height: '100%', width: '100%' }}
                        data={filteredConversations}
                        itemContent={renderChatItem}
                        className="custom-scrollbar"
                    />
                )}
            </div>
        </div>
    )
}
