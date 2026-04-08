"use client"

import { useState, useMemo, useEffect, useRef } from "react"
import { Search, LayoutGrid, AlertCircle, MessageSquare, Plus, Bot, Zap, Users, Clock, CheckCircle2, Inbox } from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useDebounce } from "use-debounce"
import { Virtuoso } from "react-virtuoso"
import { useChatNavigation } from "../hooks/useChatNavigation"
import { useConversations, Conversation } from "../hooks/useConversations"
import { useContactSearch, ContactSearchResult } from "../hooks/useContactSearch"
import { useStartConversation } from "../hooks/useStartConversation"
import NewChatPopover from "./NewChatPopover"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"

export default function ChatList({ selectedChatId, activeListTab, activeChannelTab, onSelectChat }: { selectedChatId: string | null, activeListTab: string, activeChannelTab?: string, onSelectChat?: (id: string) => void }) {
    const { conversations, setConversations, isLoading } = useConversations()
    const { setChatId, setListTab, setChannel } = useChatNavigation()
    // If onSelectChat is provided (from MessagesShell), use it for instant client-side switching.
    // Otherwise fall back to setChatId (URL-based, used when ChatList is rendered standalone).
    const handleChatSelect = onSelectChat ?? setChatId

    const router = useRouter()

    const [searchQuery, setSearchQuery] = useState("")
    const [debouncedSearch] = useDebounce(searchQuery, 200)
    const [showNewChat, setShowNewChat] = useState(false)

    const currentChannelTab = activeChannelTab || 'all'

    // Current user for ownership filtering
    const currentUserId = useMemo(() => {
        if (typeof document === 'undefined') return undefined
        return document.cookie.split(';').map(c => c.trim()).find(c => c.startsWith('crm_user_id='))?.split('=')[1]
    }, [])

    // FC-10: Contact Search API for broader results
    const { results: contactResults, loading: contactSearchLoading } = useContactSearch(searchQuery)

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
        if (activeListTab === 'all') {
            // All except resolved
            list = list.filter(c => c.status !== 'resolved')
        } else if (activeListTab === 'queue') {
            // Operator queue: unassigned, not resolved, needs attention
            list = list.filter(c =>
                !c.assignedToUserId &&
                c.status !== 'resolved' &&
                (c.unreadCount > 0 || c.requiresResponse || c.status === 'new' || c.status === 'open')
            )
        } else if (activeListTab === 'mine') {
            // My chats: assigned to current user
            list = list.filter(c => c.assignedToUserId && c.assignedToUserId === currentUserId)
        } else if (activeListTab === 'waiting') {
            list = list.filter(c => c.status === 'waiting_customer')
        } else if (activeListTab === 'resolved') {
            list = list.filter(c => c.status === 'resolved')
        }

        return list
    }, [conversations, debouncedSearch, activeListTab, currentChannelTab])

    // FC-10: Extra contacts from API that aren't already shown as conversations
    const extraContacts = useMemo(() => {
        if (!debouncedSearch || debouncedSearch.length < 2 || contactResults.length === 0) return []

        // Collect all chatIds visible in filteredConversations
        const visibleChatIds = new Set<string>()
        for (const c of filteredConversations) {
            visibleChatIds.add(c.id)
            c.allChatIds?.forEach(id => visibleChatIds.add(id))
        }

        // Filter out contacts whose chats are already visible
        return contactResults.filter(contact => {
            const chatIds = Object.values(contact.hasChat)
            if (chatIds.length === 0) return true // no chat at all — show
            return !chatIds.some(id => visibleChatIds.has(id))
        })
    }, [debouncedSearch, contactResults, filteredConversations])

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
                handleChatSelect(nextChatId)
                
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

    // Local unread reset + API mark-read when chat is selected
    useEffect(() => {
        if (!selectedChatId || !setConversations) return

        // Find the conversation to check if mark-read is needed
        const conv = conversations.find(c => c.id === selectedChatId || c.allChatIds?.includes(selectedChatId))

        // Optimistic local reset
        setConversations((prev: Conversation[]) => prev.map(c => {
            if (c.id === selectedChatId || (c.allChatIds && c.allChatIds.includes(selectedChatId))) {
                if (c.unreadCount === 0) return c
                return { ...c, unreadCount: 0 }
            }
            return c
        }))

        // API call only if there are unread messages
        if (conv && conv.unreadCount > 0) {
            fetch(`/api/chats/${selectedChatId}/read`, { method: 'POST' }).catch(() => {})
        }
    }, [selectedChatId, setConversations])

    // FC-10: Navigate to a contact from API search results
    const handleContactSelect = (contact: ContactSearchResult) => {
        // If contact has any chat, navigate to the most recent one
        const chatEntries = Object.entries(contact.hasChat)
        if (chatEntries.length > 0) {
            const chatId = chatEntries[0][1] // first chat id
            handleChatSelect(chatId)
            return
        }
        // No chat exists — open NewChatPopover pre-filled would be complex,
        // so trigger start-conversation directly via API
        const channel = currentChannelTab !== 'all' ? currentChannelTab : 'tg'
        startContactConversation(contact.id, channel)
    }

    // Start conversation for contact without existing chat
    const { startByContact, loading: startingConversation } = useStartConversation()
    const startContactConversation = async (contactId: string, urlChannel: string) => {
        const result = await startByContact(contactId, urlChannel)
        if (result) {
            handleChatSelect(result.chatId)
        }
    }

    const getChannelBadge = (channel: string) => {
        switch (channel) {
            case 'whatsapp': return <span className="text-[8px] font-bold text-emerald-600 bg-emerald-50 px-1 py-px rounded leading-none">WA</span>
            case 'telegram': return <span className="text-[8px] font-bold text-blue-600 bg-blue-50 px-1 py-px rounded leading-none">TG</span>
            case 'max': return <span className="text-[8px] font-bold text-purple-600 bg-purple-50 px-1 py-px rounded leading-none">MAX</span>
            case 'yandex_pro': return <span className="text-[8px] font-bold text-yellow-600 bg-yellow-50 px-1 py-px rounded leading-none">YP</span>
            default: return null
        }
    }

    // Queue badge: unassigned + not resolved + needs attention
    const queueCount = useMemo(() => {
        return conversations.filter(c =>
            !c.assignedToUserId &&
            c.status !== 'resolved' &&
            (c.unreadCount > 0 || c.requiresResponse)
        ).length
    }, [conversations])

    const listTabs = [
        { id: 'all', label: 'Все', icon: MessageSquare },
        { id: 'queue', label: 'Очередь', icon: Inbox, badge: queueCount || undefined },
        { id: 'mine', label: 'Мои', icon: Users },
        { id: 'waiting', label: 'Ожидание', icon: Clock },
        { id: 'resolved', label: 'Решённые', icon: CheckCircle2 },
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
                        handleChatSelect(chat.id)
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
                            <div className="flex items-center gap-1.5 min-w-0">
                                {/* Status dot */}
                                <span className={`w-[6px] h-[6px] rounded-full shrink-0 ${
                                    chat.status === 'new' ? 'bg-blue-400' :
                                    chat.status === 'open' ? 'bg-emerald-400' :
                                    chat.status === 'waiting_customer' ? 'bg-amber-400' :
                                    chat.status === 'waiting_internal' ? 'bg-orange-400' :
                                    'bg-gray-300'
                                }`} />
                                <span className={`font-bold text-[14px] truncate leading-tight ${isSelected ? 'text-white' : 'text-[#111]'}`}>
                                    {chat.name || "Водитель"}
                                </span>
                            </div>
                            <div className="flex items-center gap-1.5 shrink-0">
                                {/* Assigned operator initials */}
                                {chat.assignedToUserId && !isSelected && (
                                    <span className="text-[8px] font-bold text-gray-500 bg-gray-100 px-1 py-px rounded leading-none">
                                        {chat.assignedToUserId === currentUserId ? 'Я' : chat.assignedToUserId.substring(0, 2).toUpperCase()}
                                    </span>
                                )}
                                <span className={`text-[11px] font-medium ${isSelected ? 'text-white/60' : 'text-[#8A9099]'}`}>
                                    {timeString}
                                </span>
                            </div>
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
                <TooltipProvider delayDuration={300}>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <button
                                onClick={() => {
                                    const lastRoute = localStorage.getItem('last_crm_route');
                                    router.push(lastRoute || '/dashboard');
                                }}
                                className="w-[36px] h-[36px] rounded-[8px] flex items-center justify-center transition-colors text-gray-400 hover:bg-[#f3f4f6] hover:text-gray-700 active:bg-[#eef2ff] active:text-[#4f46e5]"
                            >
                                <LayoutGrid size={18} />
                            </button>
                        </TooltipTrigger>
                        <TooltipContent side="right">
                            <span className="font-medium">Вернуться в CRM</span>
                        </TooltipContent>
                    </Tooltip>
                </TooltipProvider>

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
                    {showNewChat && <NewChatPopover onClose={() => setShowNewChat(false)} onSelectChat={handleChatSelect} />}
                </div>
            </div>
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
                            {Icon && <Icon size={11} />}
                            {tab.label}
                            {tab.badge && tab.badge > 0 && (
                                <span className="ml-0.5 h-[14px] min-w-[14px] px-1 rounded-full bg-[#FF5252] text-white text-[9px] font-bold flex items-center justify-center leading-none">
                                    {tab.badge > 99 ? '99+' : tab.badge}
                                </span>
                            )}
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
                ) : filteredConversations.length === 0 && extraContacts.length === 0 ? (
                    <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-400 pb-20">
                        {activeListTab === 'queue' ? (
                            <>
                                <Inbox size={28} className="opacity-20 mb-3" />
                                <span className="text-[13px] font-medium">Очередь пуста</span>
                                <span className="text-[11px] text-gray-400 mt-1">Новые обращения появятся здесь</span>
                            </>
                        ) : activeListTab === 'mine' ? (
                            <>
                                <Users size={28} className="opacity-20 mb-3" />
                                <span className="text-[13px] font-medium">Нет назначенных чатов</span>
                                <span className="text-[11px] text-gray-400 mt-1">Возьмите чат из очереди</span>
                            </>
                        ) : activeListTab === 'waiting' ? (
                            <>
                                <Clock size={28} className="opacity-20 mb-3" />
                                <span className="text-[13px] font-medium">Нет ожидающих ответа</span>
                            </>
                        ) : activeListTab === 'resolved' ? (
                            <>
                                <CheckCircle2 size={28} className="opacity-20 mb-3" />
                                <span className="text-[13px] font-medium">Нет решённых чатов</span>
                            </>
                        ) : (
                            <>
                                <MessageSquare size={32} className="opacity-20 mb-3" />
                                <span className="text-[13px] font-medium">{debouncedSearch ? "Ничего не найдено" : "Нет чатов"}</span>
                                {contactSearchLoading && debouncedSearch && (
                                    <span className="text-[11px] text-gray-400 mt-1">Поиск контактов...</span>
                                )}
                            </>
                        )}
                    </div>
                ) : (
                    <div className="absolute inset-0 overflow-y-auto custom-scrollbar">
                        {/* Local conversation results */}
                        {filteredConversations.length > 0 && (
                            <Virtuoso
                                style={{ height: extraContacts.length > 0 ? `${Math.min(filteredConversations.length * 73, 400)}px` : '100%', width: '100%' }}
                                data={filteredConversations}
                                itemContent={renderChatItem}
                            />
                        )}

                        {/* FC-10: Extra contacts from API */}
                        {extraContacts.length > 0 && (
                            <div className="border-t border-[#E8E8E8]">
                                <div className="px-4 py-2 flex items-center gap-2">
                                    <Users size={12} className="text-gray-400" />
                                    <span className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">Контакты</span>
                                    {contactSearchLoading && (
                                        <div className="w-3 h-3 border border-gray-300 border-t-transparent rounded-full animate-spin" />
                                    )}
                                </div>
                                {extraContacts.map(contact => {
                                    const phone = contact.phones.find(p => p.isPrimary)?.phone || contact.phones[0]?.phone
                                    const chatCount = Object.keys(contact.hasChat).length
                                    return (
                                        <div key={contact.id} className="px-2 py-0.5">
                                            <button
                                                onClick={() => handleContactSelect(contact)}
                                                className="w-full text-left flex items-center gap-3 px-3 h-[64px] rounded-xl hover:bg-[#F0F2F5] transition-all"
                                            >
                                                <div className="h-[44px] w-[44px] rounded-full bg-[#E3E8ED] text-[#6B7A8D] flex items-center justify-center font-bold text-[14px] shrink-0">
                                                    {(contact.displayName || "?").substring(0, 1).toUpperCase()}
                                                </div>
                                                <div className="flex-1 min-w-0">
                                                    <div className="flex items-center gap-1.5">
                                                        <span className="font-semibold text-[13px] text-[#111] truncate">
                                                            {contact.displayName || "Без имени"}
                                                        </span>
                                                        {chatCount === 0 && (
                                                            <span className="text-[9px] font-semibold text-orange-500 bg-orange-50 px-1 py-px rounded">новый</span>
                                                        )}
                                                    </div>
                                                    <div className="flex items-center gap-1.5 mt-0.5">
                                                        {phone && (
                                                            <span className="text-[11px] text-gray-400 font-mono">{phone}</span>
                                                        )}
                                                        {contact.channels.length > 0 && (
                                                            <div className="flex gap-0.5">
                                                                {contact.channels.map(ch => <span key={ch}>{getChannelBadge(ch)}</span>)}
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            </button>
                                        </div>
                                    )
                                })}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    )
}
