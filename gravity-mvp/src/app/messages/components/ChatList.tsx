"use client"

import { useState, useMemo, useEffect, useRef } from "react"
import { Search, LayoutGrid, AlertCircle, MessageSquare, Plus, Bot, Zap, Users, Clock, CheckCircle2, Inbox, ChevronDown, SlidersHorizontal } from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useDebounce } from "use-debounce"
import { Virtuoso } from "react-virtuoso"
import { useChatNavigation } from "../hooks/useChatNavigation"
import { useConversations, Conversation, markChatRead, releaseStickyUnread } from "../hooks/useConversations"
import { useContactSearch, ContactSearchResult } from "../hooks/useContactSearch"
import { useStartConversation } from "../hooks/useStartConversation"
import NewChatPopover from "./NewChatPopover"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"

export default function ChatList({ selectedChatId, activeListTab, activeChannelTab, onSelectChat, initialPhone }: { selectedChatId: string | null, activeListTab: string, activeChannelTab?: string, onSelectChat?: (id: string, channelHint?: string) => void, initialPhone?: string | null }) {
    const { conversations, setConversations, isLoading } = useConversations()
    const { setChatId, setListTab } = useChatNavigation()
    // If onSelectChat is provided (from MessagesShell), use it for instant client-side switching.
    // Otherwise fall back to setChatId (URL-based, used when ChatList is rendered standalone).
    const baseChatSelect = onSelectChat ?? ((id: string) => setChatId(id))

    const router = useRouter()

    const [searchQuery, setSearchQuery] = useState("")
    const [debouncedSearch] = useDebounce(searchQuery, 200)
    const [showNewChat, setShowNewChat] = useState(!!initialPhone)
    const [viewMode, setViewMode] = useState<'chats' | 'groups'>('chats')

    // Multi-channel filter: empty set = all channels (no filter)
    const [selectedChannels, setSelectedChannels] = useState<Set<string>>(new Set())

    // Wrap to pass channel hint when exactly 1 channel is selected in sidebar.
    // If no/multiple sidebar filters, derive hint from the chat itself: this opens the chat
    // on its OWN channel tab (e.g. clicking a TG row opens TG, not WhatsApp).
    const handleChatSelect = (id: string, fallbackChannel?: string) => {
        if (selectedChannels.size === 1) {
            const ch = Array.from(selectedChannels)[0]
            baseChatSelect(id, ch)
        } else if (fallbackChannel) {
            // Map full channel names to short tab ids used by MessagesShell
            const channelToTab: Record<string, string> = {
                whatsapp: 'wa', telegram: 'tg', max: 'max', yandex_pro: 'ypro', phone: 'phone',
            }
            baseChatSelect(id, channelToTab[fallbackChannel] || fallbackChannel)
        } else {
            baseChatSelect(id)
        }
    }

    // Current user for ownership filtering
    const currentUserId = useMemo(() => {
        if (typeof document === 'undefined') return undefined
        return document.cookie.split(';').map(c => c.trim()).find(c => c.startsWith('crm_user_id='))?.split('=')[1]
    }, [])

    // Channel accounts: for account filter + dynamic tabs
    const [channelAccounts, setChannelAccounts] = useState<Record<string, any[]>>({})
    const [selectedAccountIds, setSelectedAccountIds] = useState<Set<string>>(new Set())
    const [accountDropdownOpen, setAccountDropdownOpen] = useState(false)
    const accountDropdownRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        fetch('/api/channels/accounts').then(r => r.json()).then(data => {
            setChannelAccounts(data || {})
        }).catch(() => {})
    }, [])

    // Close account dropdown on outside click
    useEffect(() => {
        const handleClick = (e: MouseEvent) => {
            if (accountDropdownRef.current && !accountDropdownRef.current.contains(e.target as Node)) {
                setAccountDropdownOpen(false)
            }
        }
        document.addEventListener('mousedown', handleClick)
        return () => document.removeEventListener('mousedown', handleClick)
    }, [])

    // Group visibility: load hidden group IDs
    const [hiddenGroupIds, setHiddenGroupIds] = useState<Set<string>>(new Set())
    useEffect(() => {
        if (viewMode === 'groups') {
            fetch('/api/groups/visibility').then(r => r.json()).then(data => {
                setHiddenGroupIds(new Set(data.hiddenChatIds || []))
            }).catch(() => {})
        }
    }, [viewMode])

    const toggleGroupVisibility = async (chatId: string) => {
        const isHidden = hiddenGroupIds.has(chatId)
        const newVisibility = isHidden ? 'visible' : 'hidden'
        // Optimistic update
        setHiddenGroupIds(prev => {
            const next = new Set(prev)
            if (isHidden) next.delete(chatId)
            else next.add(chatId)
            return next
        })
        await fetch('/api/groups/visibility', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chatId, visibility: newVisibility })
        }).catch(() => {})
    }

    // FC-10: Contact Search API for broader results
    const { results: contactResults, loading: contactSearchLoading } = useContactSearch(searchQuery)

    // Filter Logic
    const filteredConversations = useMemo(() => {
        let list = conversations

        // 0. View mode: Chats (private) vs Groups
        if (viewMode === 'chats') {
            list = list.filter(c => (c.chatType || 'private') === 'private')
        } else {
            list = list.filter(c => c.chatType && c.chatType !== 'private')
            // Filter out hidden groups
            list = list.filter(c => !hiddenGroupIds.has(c.id))
        }

        // 0b. Account filter: multi-select on metadata.connectionId
        if (selectedAccountIds.size > 0) {
            list = list.filter(c => {
                const connId = (c.metadata as any)?.connectionId
                return connId && selectedAccountIds.has(connId)
            })
        }

        // 1. Text Search
        if (debouncedSearch) {
            const query = debouncedSearch.toLowerCase()
            list = list.filter(c => 
                c.name?.toLowerCase().includes(query) || 
                c.driver?.phone?.includes(query) ||
                c.externalChatId?.toLowerCase().includes(query)
            )
        }

        // 2. Channel Filter (multi-select) — but never filter out the currently selected chat.
        // Strict matching: a chat appears on a channel tab ONLY if its primary channel matches.
        // Merged conversations (e.g. driver with both MAX and WA chats) are shown under their
        // primary channel only — clicking the WA tab shows only WA chats.
        if (selectedChannels.size > 0) {
            const normalizeChannel = (ch: string) => ch === 'wa' ? 'whatsapp' : ch === 'tg' ? 'telegram' : ch === 'ypro' ? 'yandex_pro' : ch
            const normalizedSet = new Set(Array.from(selectedChannels).map(normalizeChannel))
            list = list.filter(c => {
                const isSelected = selectedChatId && (c.id === selectedChatId || c.allChatIds?.includes(selectedChatId))
                if (isSelected) return true
                return normalizedSet.has(c.channel)
            })
        }

        // 3. Tab Filter — but never filter out the currently selected chat
        const keepSelected = (c: Conversation) =>
            !!selectedChatId && (c.id === selectedChatId || !!c.allChatIds?.includes(selectedChatId))

        if (activeListTab === 'all') {
            list = list.filter(c => c.status !== 'resolved' || keepSelected(c))
        } else if (activeListTab === 'queue') {
            list = list.filter(c => keepSelected(c) || (
                !c.assignedToUserId &&
                c.status !== 'resolved' &&
                (c.unreadCount > 0 || c.requiresResponse || c.status === 'new' || c.status === 'open')
            ))
        } else if (activeListTab === 'mine') {
            list = list.filter(c => keepSelected(c) || (c.assignedToUserId && c.assignedToUserId === currentUserId))
        } else if (activeListTab === 'waiting') {
            list = list.filter(c => keepSelected(c) || c.status === 'waiting_customer')
        } else if (activeListTab === 'resolved') {
            list = list.filter(c => keepSelected(c) || c.status === 'resolved')
        }

        // 4. List is already sorted by useConversations (unread-first, with sticky-unread for
        //    the just-read selected chat keeping its position). No additional sort needed here.
        return list
    }, [conversations, debouncedSearch, activeListTab, selectedChannels, viewMode, hiddenGroupIds, selectedAccountIds, selectedChatId])

    // Conversations filtered only by account (for badge counts on channel tabs)
    const accountFilteredConversations = useMemo(() => {
        if (selectedAccountIds.size === 0) return conversations
        return conversations.filter(c => {
            const connId = (c.metadata as any)?.connectionId
            return connId && selectedAccountIds.has(connId)
        })
    }, [conversations, selectedAccountIds])

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

    // Track previous selectedChatId to release its sticky-unread flag when user navigates away.
    // Effect: when selectedChatId changes, OLD chat drops from "sticky unread" (re-sorts to read
    // section if it has no real unread messages).
    const prevSelectedChatIdRef = useRef<string | null>(null)

    // Local unread reset + API mark-read when chat is selected.
    // markChatRead handles: optimistic zero of unreadCount + channelUnread,
    // adds sticky-unread flag so chat keeps its sort position until user navigates away,
    // and a polling-safe overlay so counts don't flicker back.
    useEffect(() => {
        // Release sticky-unread for the PREVIOUS chat (so it naturally falls to read section)
        if (prevSelectedChatIdRef.current && prevSelectedChatIdRef.current !== selectedChatId) {
            releaseStickyUnread(prevSelectedChatIdRef.current)
        }
        prevSelectedChatIdRef.current = selectedChatId

        if (!selectedChatId) return
        const conv = conversations.find(c => c.id === selectedChatId || c.allChatIds?.includes(selectedChatId))
        if (conv && conv.unreadCount > 0) {
            markChatRead(selectedChatId)
        }
    }, [selectedChatId])

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
        const channel = selectedChannels.size === 1 ? Array.from(selectedChannels)[0] : 'tg'
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
            case 'phone': return <span className="text-[8px] font-bold text-orange-600 bg-orange-50 px-1 py-px rounded leading-none">ТЕЛ</span>
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

    // Dynamic channel tabs: show channel if it has data OR connected accounts OR is a built-in CRM module
    const channelTabs = useMemo(() => {
        const channelsWithData = new Set(conversations.map(c => c.channel))
        const channelsWithAccounts = new Set(
            Object.entries(channelAccounts)
                .filter(([, accs]) => (accs as any[]).length > 0)
                .map(([ch]) => ch === 'wa' ? 'whatsapp' : ch === 'tg' ? 'telegram' : ch === 'ypro' ? 'yandex_pro' : ch)
        )
        const all: { id: string; label: string; channel: string; dotColor?: string; alwaysShow?: boolean }[] = [
            { id: 'wa', label: 'WA', dotColor: 'bg-emerald-500', channel: 'whatsapp' },
            { id: 'tg', label: 'TG', dotColor: 'bg-blue-500', channel: 'telegram' },
            { id: 'max', label: 'MAX', dotColor: 'bg-purple-500', channel: 'max' },
            { id: 'ypro', label: 'YP', dotColor: 'bg-yellow-500', channel: 'yandex_pro', alwaysShow: true },
            { id: 'phone', label: 'Тел', dotColor: 'bg-orange-500', channel: 'phone', alwaysShow: true },
        ]
        return all.filter(ch => ch.alwaysShow || channelsWithData.has(ch.channel) || channelsWithAccounts.has(ch.channel))
    }, [conversations, channelAccounts])

    const renderChatItem = (index: number, chat: Conversation) => {
        const isSelected = selectedChatId === chat.id || (chat.allChatIds && chat.allChatIds.includes(selectedChatId!))
        // Telegram-style time labels:
        //   today      → "14:03"
        //   yesterday  → "вчера"
        //   this week  → "пн", "вт", "ср", "чт", "пт", "сб", "вс"
        //   this year  → "12 апр"
        //   older      → "12.04.25"
        const timeString = (() => {
            if (!chat.lastMessageAt) return ''
            const msgDate = new Date(chat.lastMessageAt)
            const now = new Date()
            const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
            const startOfMsgDay = new Date(msgDate.getFullYear(), msgDate.getMonth(), msgDate.getDate())
            const dayDiff = Math.floor((startOfToday.getTime() - startOfMsgDay.getTime()) / 86_400_000)
            if (dayDiff <= 0) {
                return msgDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            }
            if (dayDiff === 1) return 'вчера'
            if (dayDiff < 7) {
                const weekdays = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб']
                return weekdays[msgDate.getDay()]
            }
            if (msgDate.getFullYear() === now.getFullYear()) {
                const months = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']
                return `${msgDate.getDate()} ${months[msgDate.getMonth()]}`
            }
            const yy = String(msgDate.getFullYear()).slice(2)
            const mm = String(msgDate.getMonth() + 1).padStart(2, '0')
            const dd = String(msgDate.getDate()).padStart(2, '0')
            return `${dd}.${mm}.${yy}`
        })()
        const lastMsg = chat.messages?.[0]
        const isGroupChat = chat.chatType && chat.chatType !== 'private'
        const snippet = (() => {
            if (!lastMsg?.content) return "Сообщений пока нет"
            if (lastMsg.type === 'call') return `📞 ${lastMsg.content}`
            if (isGroupChat && lastMsg.metadata?.senderName) {
                return `${lastMsg.metadata.senderName}: ${lastMsg.content}`
            }
            return lastMsg.content
        })()

        return (
            <div id={`chat-row-${chat.id}`} className="px-2 py-0.5">
                <button
                    onClick={() => {
                        handleChatSelect(chat.id, chat.channel)
                        if (chat.unreadCount > 0) markChatRead(chat.id)
                    }}
                    onContextMenu={(e) => {
                        if (isGroupChat) {
                            e.preventDefault()
                            if (confirm('Скрыть эту группу?')) {
                                toggleGroupVisibility(chat.id)
                            }
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
                            : isGroupChat ? 'bg-[#C8D6E5] text-[#546574]' : 'bg-[#DEE3E8] text-[#546574]'
                        }`}>
                            {isGroupChat ? <Users size={20} /> : (chat.name?.substring(0, 1).toUpperCase() || "D")}
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
                                    {chat.name
                                        || chat.driver?.fullName
                                        || chat.driver?.phone
                                        || (() => {
                                            // Extract phone from externalChatId (e.g. "whatsapp:79221853150" → "+79221853150")
                                            const ext = chat.externalChatId || ''
                                            const digits = ext.replace(/\D/g, '')
                                            if (digits.length >= 10) return '+' + digits
                                            return null
                                        })()
                                        || (isGroupChat ? 'Группа' : 'Водитель')}
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
                    {showNewChat && <NewChatPopover onClose={() => setShowNewChat(false)} onSelectChat={handleChatSelect} initialQuery={initialPhone || undefined} />}
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

            {/* View mode: Chats / Groups + Account selector icon */}
            <div className="flex gap-1 px-3 py-1.5 border-b border-[#E4ECFC] shrink-0 items-center">
                <button
                    onClick={() => setViewMode('chats')}
                    className={`px-3 py-1.5 rounded-lg text-[13px] font-semibold transition-colors ${
                        viewMode === 'chats' ? 'bg-[#3390EC] text-white' : 'text-[#8A9099] hover:bg-[#F0F2F5]'
                    }`}
                >Чаты</button>
                <button
                    onClick={() => setViewMode('groups')}
                    className={`px-3 py-1.5 rounded-lg text-[13px] font-semibold transition-colors ${
                        viewMode === 'groups' ? 'bg-[#3390EC] text-white' : 'text-[#8A9099] hover:bg-[#F0F2F5]'
                    }`}
                >Группы</button>

                {/* Account selector — icon button + dropdown */}
                {(() => {
                    const channelDisplayName: Record<string, string> = { wa: 'WhatsApp', tg: 'Telegram', max: 'MAX', ypro: 'Yandex Pro' }
                    const channelBadge: Record<string, string> = { wa: 'WA', tg: 'TG', max: 'MAX', ypro: 'YP' }
                    const dropdownAccounts: { id: string; label: string; phone?: string; channel?: string; channelKey?: string }[] = []
                    if (selectedChannels.size === 0) {
                        Object.entries(channelAccounts).forEach(([ch, accs]) => {
                            (accs as any[]).forEach(a => dropdownAccounts.push({ ...a, channel: channelBadge[ch] || ch, channelKey: ch }))
                        })
                    } else {
                        for (const chId of selectedChannels) {
                            const accs = channelAccounts[chId] || []
                            accs.forEach((a: any) => dropdownAccounts.push({ ...a, channel: channelBadge[chId] || chId, channelKey: chId }))
                        }
                    }

                    const normalizePhone = (p: string) => p?.replace(/[\s\-\+\(\)]/g, '') || ''
                    const phoneGroups = new Map<string, typeof dropdownAccounts>()
                    const phoneDisplay = new Map<string, string>()
                    const ungrouped: typeof dropdownAccounts = []

                    for (const acc of dropdownAccounts) {
                        const norm = normalizePhone(acc.phone || '')
                        if (norm.length >= 7) {
                            if (!phoneGroups.has(norm)) {
                                phoneGroups.set(norm, [])
                                phoneDisplay.set(norm, acc.phone || norm)
                            }
                            phoneGroups.get(norm)!.push(acc)
                        } else {
                            ungrouped.push(acc)
                        }
                    }

                    const allOff = selectedAccountIds.has('__none__')
                    const isAccSelected = (accId: string) => selectedAccountIds.size === 0 || selectedAccountIds.has(accId)
                    const hasFilter = selectedAccountIds.size > 0 && !allOff

                    const toggleAll = () => {
                        if (selectedAccountIds.size === 0) {
                            setSelectedAccountIds(new Set(['__none__']))
                        } else {
                            setSelectedAccountIds(new Set())
                        }
                    }
                    const toggleGroup = (groupAccs: typeof dropdownAccounts) => {
                        const groupIds = groupAccs.map(a => a.id)
                        const allGroupSelected = groupIds.every(id => isAccSelected(id))
                        setSelectedAccountIds(prev => {
                            if (prev.size === 0) {
                                const all = new Set(dropdownAccounts.map(a => a.id))
                                groupIds.forEach(id => all.delete(id))
                                return all
                            }
                            const next = new Set(prev)
                            next.delete('__none__')
                            if (allGroupSelected) groupIds.forEach(id => next.delete(id))
                            else groupIds.forEach(id => next.add(id))
                            return next.size === 0 ? new Set(['__none__']) : next
                        })
                    }
                    const toggleSingle = (accId: string) => {
                        setSelectedAccountIds(prev => {
                            if (prev.size === 0) {
                                const all = new Set(dropdownAccounts.map(a => a.id))
                                all.delete(accId)
                                return all
                            }
                            const next = new Set(prev)
                            next.delete('__none__')
                            if (next.has(accId)) next.delete(accId)
                            else next.add(accId)
                            return next.size === 0 ? new Set(['__none__']) : next
                        })
                    }

                    return (
                        <div className="relative ml-auto" ref={accountDropdownRef}>
                            <button
                                onClick={() => setAccountDropdownOpen(!accountDropdownOpen)}
                                className={`w-[28px] h-[28px] rounded-lg flex items-center justify-center transition-colors ${
                                    hasFilter || accountDropdownOpen
                                    ? 'bg-[#3390EC]/10 text-[#3390EC]'
                                    : 'text-gray-400 hover:bg-[#F0F2F5] hover:text-gray-600'
                                }`}
                                title="Аккаунты"
                            >
                                <SlidersHorizontal size={15} />
                                {hasFilter && (
                                    <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-[#3390EC]" />
                                )}
                            </button>
                            {accountDropdownOpen && (
                                <div className="absolute top-full right-0 mt-1 bg-white rounded-lg shadow-xl border border-[#E0E0E0] py-1 min-w-[240px] z-50">
                                    <button
                                        onClick={toggleAll}
                                        className={`w-full px-3 py-1.5 text-left text-[12px] hover:bg-gray-50 transition-colors flex items-center gap-2 ${selectedAccountIds.size === 0 ? 'font-bold text-[#3390EC]' : 'text-[#111]'}`}
                                    >
                                        <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center text-[9px] ${selectedAccountIds.size === 0 ? 'bg-[#3390EC] border-[#3390EC] text-white' : 'border-gray-300'}`}>
                                            {selectedAccountIds.size === 0 && '✓'}
                                        </span>
                                        Все аккаунты
                                    </button>
                                    {Array.from(phoneGroups.entries()).map(([normPhone, groupAccs]) => {
                                        const allSelected = groupAccs.every(a => isAccSelected(a.id))
                                        const someSelected = groupAccs.some(a => isAccSelected(a.id))
                                        return (
                                            <div key={normPhone}>
                                                <div className="border-t border-gray-100 mt-1 pt-1" />
                                                <button
                                                    onClick={() => toggleGroup(groupAccs)}
                                                    className="w-full px-3 py-1.5 text-left hover:bg-gray-50 transition-colors flex items-center gap-2"
                                                >
                                                    <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center text-[9px] ${allSelected ? 'bg-[#3390EC] border-[#3390EC] text-white' : someSelected ? 'bg-[#3390EC]/30 border-[#3390EC]' : 'border-gray-300'}`}>
                                                        {allSelected && '✓'}
                                                    </span>
                                                    <span className="text-[12px] font-semibold text-[#111]">{phoneDisplay.get(normPhone)}</span>
                                                    <div className="flex gap-0.5 ml-auto">
                                                        {groupAccs.map(a => (
                                                            <span key={a.id} className="text-[9px] text-gray-500 bg-gray-100 px-1 rounded">{a.channel || channelBadge[a.channelKey || ''] || '?'}</span>
                                                        ))}
                                                    </div>
                                                </button>
                                                {groupAccs.map(acc => (
                                                    <button
                                                        key={acc.id}
                                                        onClick={() => toggleSingle(acc.id)}
                                                        className="w-full px-3 py-1 text-left hover:bg-gray-50 transition-colors flex items-center gap-2 pl-6"
                                                    >
                                                        <span className={`w-3 h-3 rounded border flex items-center justify-center text-[8px] ${isAccSelected(acc.id) ? 'bg-[#3390EC] border-[#3390EC] text-white' : 'border-gray-300'}`}>
                                                            {isAccSelected(acc.id) && '✓'}
                                                        </span>
                                                        <span className="text-[12px] text-[#333]">{channelDisplayName[acc.channelKey || ''] || acc.label}</span>
                                                    </button>
                                                ))}
                                            </div>
                                        )
                                    })}
                                    {ungrouped.length > 0 && phoneGroups.size > 0 && <div className="border-t border-gray-100 mt-1 pt-1" />}
                                    {ungrouped.map(acc => (
                                        <button
                                            key={acc.id}
                                            onClick={() => toggleSingle(acc.id)}
                                            className="w-full px-3 py-1.5 text-left hover:bg-gray-50 transition-colors flex items-center gap-2"
                                        >
                                            <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center text-[9px] ${isAccSelected(acc.id) ? 'bg-[#3390EC] border-[#3390EC] text-white' : 'border-gray-300'}`}>
                                                {isAccSelected(acc.id) && '✓'}
                                            </span>
                                            <span className="text-[12px] text-[#111]">{acc.label}</span>
                                            {acc.channel && <span className="text-[9px] text-gray-400 bg-gray-100 px-1 rounded ml-auto">{acc.channel}</span>}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    )
                })()}
            </div>

            {/* Channel filter — multi-select */}
            <div className="px-3 pb-1.5 shrink-0 flex items-center gap-1">
                {/* "Все" button — clears channel filter */}
                {(() => {
                    // Exclude currently selected chat from tab counts — user is actively viewing it.
                    const isSelectedConv = (c: Conversation) =>
                        !!selectedChatId && (c.id === selectedChatId || !!c.allChatIds?.includes(selectedChatId))
                    // Only count conversations matching the current viewMode (Чаты vs Группы).
                    // Groups are hidden from Chats view and vice versa — tab count must match what's visible.
                    const matchesViewMode = (c: Conversation) => {
                        const isGroup = c.chatType && c.chatType !== 'private'
                        return viewMode === 'chats' ? !isGroup : !!isGroup
                    }
                    const totalUnread = accountFilteredConversations.reduce(
                        (sum, c) => sum + ((isSelectedConv(c) || !matchesViewMode(c)) ? 0 : (c.unreadCount || 0)), 0)
                    return (
                        <button
                            onClick={() => setSelectedChannels(new Set())}
                            className={`h-[28px] px-2.5 rounded-lg text-[13px] font-semibold transition-all flex items-center gap-1 ${
                                selectedChannels.size === 0
                                ? 'bg-[#3390EC] text-white'
                                : 'text-[#8A9099] hover:bg-[#F0F2F5]'
                            }`}
                        >
                            Все
                            {totalUnread > 0 && (
                                <span className={`h-[16px] min-w-[16px] px-1 rounded-full text-[10px] font-bold flex items-center justify-center leading-none ${
                                    selectedChannels.size === 0 ? 'bg-white/25 text-white' : 'bg-[#3390EC] text-white'
                                }`}>
                                    {totalUnread > 999 ? '999+' : totalUnread}
                                </span>
                            )}
                        </button>
                    )
                })()}
                {channelTabs.map((ch) => {
                    const isActive = selectedChannels.has(ch.id)
                    const normalizedChannel = ch.channel
                    // Exclude currently selected chat from tab counts — user is actively viewing it.
                    const isSelectedConv = (c: Conversation) =>
                        !!selectedChatId && (c.id === selectedChatId || !!c.allChatIds?.includes(selectedChatId))
                    // Only count conversations matching the current viewMode (Чаты vs Группы)
                    const matchesViewMode = (c: Conversation) => {
                        const isGroup = c.chatType && c.chatType !== 'private'
                        return viewMode === 'chats' ? !isGroup : !!isGroup
                    }
                    // Tab badge counts ONLY chats whose PRIMARY channel matches the tab.
                    // This keeps the badge consistent with what's visible after clicking the tab
                    // (filter is also strict: primary channel only).
                    const channelUnread = accountFilteredConversations
                        .filter(c => c.channel === normalizedChannel)
                        .reduce((sum, c) => {
                            if (isSelectedConv(c) || !matchesViewMode(c)) return sum
                            return sum + (c.unreadCount || 0)
                        }, 0)
                    return (
                        <button
                            key={ch.id}
                            onClick={() => {
                                setSelectedChannels(prev => {
                                    const next = new Set(prev)
                                    if (next.has(ch.id)) next.delete(ch.id)
                                    else next.add(ch.id)
                                    return next
                                })
                            }}
                            className={`h-[28px] px-2.5 rounded-lg text-[13px] font-semibold transition-all flex items-center gap-1 ${
                                isActive
                                ? 'bg-[#3390EC] text-white'
                                : 'text-[#8A9099] hover:bg-[#F0F2F5]'
                            }`}
                        >
                            {ch.label}
                            {channelUnread > 0 && (
                                <span className={`h-[16px] min-w-[16px] px-1 rounded-full text-[10px] font-bold flex items-center justify-center leading-none ${
                                    isActive ? 'bg-white/25 text-white' : 'bg-[#3390EC] text-white'
                                }`}>
                                    {channelUnread > 999 ? '999+' : channelUnread}
                                </span>
                            )}
                        </button>
                    )
                })}

                {/* Account selector moved to Chats/Groups row */}
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
