"use client"

import { useState, useEffect, useRef } from "react"
import { 
    Send, 
    MoreVertical, 
    Search, 
    Phone, 
    Video, 
    CheckCheck, 
    ChevronLeft,
    Paperclip,
    Smile,
    MessageCircle,
    User,
    Flashlight,
    CheckCircle2,
    Clock,
    AlertCircle,
    Archive,
    Filter,
    PlusCircle,
    Zap,
    SendHorizonal,
    Paperclip as ClipIcon,
    LayoutGrid,
    MessageSquare,
    Users,
    ChevronDown,
    ChevronUp
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"

interface Conversation {
    id: string
    name: string
    channel: string
    externalChatId: string
    lastMessageAt: string
    unreadCount: number
    requiresResponse: boolean
    status: 'new' | 'open' | 'waiting_customer' | 'waiting_internal' | 'resolved'
    driver?: {
        id: string
        fullName: string
        phone: string | null
        segment: string
    }
    messages?: Message[]
}

interface Message {
    id: string
    direction: 'inbound' | 'outbound'
    type: 'text' | 'image' | 'system'
    content: string
    sentAt: string
    status: 'sent' | 'delivered' | 'read'
}

export default function Messenger() {
    const [conversations, setConversations] = useState<Conversation[]>([])
    const [selectedChatId, setSelectedChatId] = useState<string | null>(null)
    const [messages, setMessages] = useState<Message[]>([])
    const [newMessage, setNewMessage] = useState("")
    const [isLoading, setIsLoading] = useState(true)
    const [searchQuery, setSearchQuery] = useState("")
    const [activeFilter, setActiveFilter] = useState<'all' | 'unread' | 'requires_response' | 'mine'>('all')
    const [channelFilter, setChannelFilter] = useState<'all' | 'whatsapp' | 'telegram' | 'max' | 'yandex_pro'>('all')
    const [isNewChatModalOpen, setIsNewChatModalOpen] = useState(false)
    const [searchDriverQuery, setSearchDriverQuery] = useState("")
    const [foundDrivers, setFoundDrivers] = useState<any[]>([])
    const [selectedDriverForNewChat, setSelectedDriverForNewChat] = useState<any | null>(null)
    const [availableChannels, setAvailableChannels] = useState<any[]>([])
    const [isStartingChat, setIsStartingChat] = useState(false)
    const [selectedChannelForOutbound, setSelectedChannelForOutbound] = useState<'whatsapp' | 'telegram' | 'max' | 'yandex_pro' | null>(null)
    const [availableProfiles, setAvailableProfiles] = useState<Record<string, any[]>>({whatsapp: [], telegram: [], max: [], yandex_pro: []})
    const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null)
    const [selectedProfileFilter, setSelectedProfileFilter] = useState<string | 'all'>('all')
    const lastInitializedChatId = useRef<string | null>(null)
    const messagesEndRef = useRef<HTMLDivElement>(null)
    const scrollContainerRef = useRef<HTMLDivElement>(null)

    const selectedChat = conversations.find(c => c.id === selectedChatId)

    const filteredConversations = conversations.filter(c => {
        const matchesSearch = c.name?.toLowerCase().includes(searchQuery.toLowerCase()) || 
                             c.driver?.phone?.includes(searchQuery)
        
        // Support unified driver view: if allChannels exists, check if any of those channels matches the filter
        const chatChannels: string[] = (c as any).allChannels || [c.channel]
        const matchesChannel = channelFilter === 'all' || chatChannels.includes(channelFilter)
        
        // Profile Filter
        const matchesProfile = channelFilter === 'all' || selectedProfileFilter === 'all' || 
                              ((c as any).allProfiles || []).some((p: any) => 
                                  p.channel === channelFilter && p.profileId === selectedProfileFilter
                              )

        const matchesTab = activeFilter === 'all' || 
                          (activeFilter === 'unread' && c.unreadCount > 0) ||
                          (activeFilter === 'requires_response' && c.requiresResponse)
        
        return matchesSearch && matchesChannel && matchesProfile && matchesTab
    })

    useEffect(() => {
        const loadChats = async () => {
            try {
                const res = await fetch('/api/messages/conversations')
                const data = await res.json()
                if (Array.isArray(data)) {
                    setConversations(data)
                } else {
                    console.error("Invalid conversations data format", data)
                    setConversations([])
                }
                setIsLoading(false)
            } catch (err) {
                console.error("Failed to load conversations", err)
            }
        }
        
        const loadProfiles = async () => {
            try {
                const res = await fetch('/api/messages/profiles')
                const data = await res.json()
                setAvailableProfiles(data)
                // Set defaults if possible
                if (data.telegram?.length > 0) setSelectedProfileId(data.telegram[0].id)
            } catch (err) {
                console.error("Failed to load profiles", err)
            }
        }

        loadChats()
        loadProfiles()
        const interval = setInterval(loadChats, 5000) // Poll conversations every 5s instead of 10s
        return () => clearInterval(interval)
    }, [])

    // Add another useEffect for polling messages of THE ACTIVE chat
    useEffect(() => {
        const pollMessages = async () => {
            if (!selectedChatId) return
            const idsToFetch = (selectedChat as any).allChatIds ? (selectedChat as any).allChatIds.join(',') : selectedChatId
            try {
                const res = await fetch(`/api/messages?chatId=${idsToFetch}&_t=${Date.now()}`)
                const data = await res.json()
                if (Array.isArray(data)) {
                    setMessages(prev => {
                        if (prev.length !== data.length || JSON.stringify(prev) !== JSON.stringify(data)) {
                            return data
                        }
                        return prev
                    })
                }
            } catch (e) {
                console.error('[Messenger] Message poll failed:', e)
            }
        }

        pollMessages() // Initial call
        const interval = setInterval(pollMessages, 3000) // Poll messages every 3s
        return () => clearInterval(interval)
    }, [selectedChatId, (selectedChat as any)?.allChatIds?.join(',')])

    // Load messages when chat selected
    useEffect(() => {
        if (selectedChatId && selectedChat) {
            // Support unified history: fetch from all conversation IDs belonging to this driver
            const idsToFetch = (selectedChat as any).allChatIds ? (selectedChat as any).allChatIds.join(',') : selectedChatId
            fetch(`/api/messages?chatId=${idsToFetch}`)
                .then(res => res.json())
                .then(data => setMessages(data))
        } else {
            setMessages([])
        }
    }, [selectedChatId, (selectedChat as any)?.allChatIds?.join(',')])

    // -------------------------------------------------------------------------
    // RENDER: SCROLL TO BOTTOM (STRICT & INSTANT)
    // -------------------------------------------------------------------------
    useEffect(() => {
        const scrollToBottom = () => {
             const container = scrollContainerRef.current;
             if (container) {
                 // Brute force scroll to the very bottom
                 container.scrollTop = container.scrollHeight + 1000;
             }
             // Fallback to ref-based scroll
             messagesEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
        }

        scrollToBottom(); // Instant
        
        // Retries for dynamic elements like images or layout shifts
        const t1 = setTimeout(scrollToBottom, 50);
        const t2 = setTimeout(scrollToBottom, 200);
        const t3 = setTimeout(scrollToBottom, 500);

        return () => {
            clearTimeout(t1);
            clearTimeout(t2);
            clearTimeout(t3);
        }
    }, [messages, selectedChatId]) 

    // Update selectedProfileId when channel switches
    useEffect(() => {
        if (selectedChannelForOutbound && (availableProfiles[selectedChannelForOutbound as keyof typeof availableProfiles] || []).length > 0) {
            // Find the first active profile for this channel
            const profiles = availableProfiles[selectedChannelForOutbound as keyof typeof availableProfiles] || []
            setSelectedProfileId(profiles[0].id)
        } else {
            setSelectedProfileId(null)
        }
    }, [selectedChannelForOutbound, availableProfiles])

    // Load available channels when chat is selected
    useEffect(() => {
        if (!selectedChat) return

        const fetchChannels = async () => {
            try {
                let channels: any[] = []
                
                if (selectedChat.driver?.id) {
                    const res = await fetch(`/api/messages/drivers/${selectedChat.driver.id}/channels`)
                    const data = await res.json()
                    channels = data.channels || []
                }
                
                // Business Logic: If we have a phone number, we can always attempt WA and MAX
                const rawPhone = selectedChat.driver?.phone || (selectedChat.externalChatId?.includes(':') ? selectedChat.externalChatId.split(':')[1] : selectedChat.externalChatId)
                const hasPhone = !!rawPhone || !!selectedChat.name?.startsWith('+')
                
                if (hasPhone) {
                    if (!channels.find((c: any) => c.type === 'whatsapp')) channels.push({ type: 'whatsapp', available: true })
                    if (!channels.find((c: any) => c.type === 'max')) channels.push({ type: 'max', available: true })
                }
                // For Telegram, show it as available if it's already active or we want to allow trial
                if (!channels.find((c: any) => c.type === 'telegram')) channels.push({ type: 'telegram', available: true })

                // Ensure the current channel is always in the list
                if (selectedChat && !channels.find((c: any) => c.type === selectedChat.channel)) {
                    channels.push({ type: selectedChat.channel, available: true })
                }
                
                setAvailableChannels(channels)
            } catch (err) {
                console.error("Failed to load driver channels", err)
                if (selectedChat) {
                    setAvailableChannels([{ type: selectedChat.channel, available: true }])
                }
            }
        }

        fetchChannels()
    }, [selectedChatId, selectedChat?.driver?.id, selectedChat?.channel, selectedChat?.driver?.phone, selectedChat?.externalChatId, selectedChat?.name])

    // Initialize channel when selectedChatId changes
    useEffect(() => {
        if (selectedChatId && selectedChat) {
            console.log(`[Messenger] Chat selection changed to ${selectedChatId}, defaulting channel to ${selectedChat.channel}`)
            setSelectedChannelForOutbound(selectedChat.channel as 'whatsapp' | 'telegram' | 'max' | 'yandex_pro')
        }
    }, [selectedChatId, !!selectedChat])

    // Search drivers for new chat
    useEffect(() => {
        if (searchDriverQuery.length >= 2) {
            fetch(`/api/messages/drivers/search?q=${encodeURIComponent(searchDriverQuery)}`)
                .then(res => res.json())
                .then(data => setFoundDrivers(data))
        } else {
            setFoundDrivers([])
        }
    }, [searchDriverQuery])

    const handleStartNewChat = async (driverId: string, channel: string) => {
        console.log(`[Messenger] Starting new chat: driver=${driverId}, channel=${channel}`)
        setIsStartingChat(true)
        try {
            const res = await fetch('/api/messages/start-chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ driverId, channel })
            })
            const newChat = await res.json()
            console.log(`[Messenger] Response status: ${res.status}, data:`, newChat)
            if (res.ok && newChat.id) {
                // Refresh list and select new chat
                const chatsRes = await fetch('/api/messages/conversations')
                const chatsData = await chatsRes.json()
                setConversations(chatsData)
                setSelectedChatId(newChat.id)
                setIsNewChatModalOpen(false)
                setSelectedDriverForNewChat(null)
                setSearchDriverQuery("")
            } else {
                const errorMsg = newChat.error || "Неизвестная ошибка при создании чата."
                alert(`Ошибка: ${errorMsg}`)
            }
        } catch (error) {
            console.error("Failed to start new chat:", error)
            alert("Не удалось создать чат. Проверьте соединение с сервером.")
        } finally {
            setIsStartingChat(false)
        }
    }

    const handleSendMessage = async () => {
        if (!newMessage.trim() || !selectedChatId) return

        const content = newMessage
        setNewMessage("")

        console.log(`[Messenger] handleSendMessage: chatId=${selectedChatId}, channel=${selectedChannelForOutbound}, profileId=${selectedProfileId}`)

        try {
            // Determine the actual chatId to send to. 
            // If channel matches current but we have a map, use the specific id from map
            let effectiveChatId = selectedChatId
            if (selectedChannelForOutbound && (selectedChat as any).channelMap?.[selectedChannelForOutbound]) {
                effectiveChatId = (selectedChat as any).channelMap[selectedChannelForOutbound]
            }

            const res = await fetch('/api/messages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    chatId: effectiveChatId, 
                    content,
                    channel: selectedChannelForOutbound,
                    profileId: selectedProfileId 
                })
            })

            if (res.ok) {
                const data = await res.json()
                const usedChatId = data.chatId || effectiveChatId
                
                // Refresh message list
                // For unified view, we still want to fetch everything again
                const idsToFetch = (selectedChat as any).allChatIds 
                    ? [...new Set([...(selectedChat as any).allChatIds, usedChatId])].join(',')
                    : usedChatId

                const historyRes = await fetch(`/api/messages?chatId=${idsToFetch}&_t=${Date.now()}`)
                const historyData = await historyRes.json()
                setMessages(historyData)

                // Refresh conversation list to update "last message" and chat list
                fetch('/api/messages/conversations')
                    .then(r => r.json())
                    .then(data => setConversations(data))

                // FORCE SCROLL to bottom (immediate)
                if (scrollContainerRef.current) {
                    scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight
                }
                setTimeout(() => {
                    messagesEndRef.current?.scrollIntoView({ behavior: "auto" })
                }, 50)
            } else {
                const errData = await res.json().catch(() => ({ error: 'Unknown error' }))
                alert(`Ошибка отправки: ${errData.error}`)
            }
        } catch (error) {
            console.error("Send message error:", error)
            alert("Критическая ошибка при отправке")
        }
    }

    const getStatusLabel = (status: string) => {
        switch (status) {
            case 'new': return 'Новый'
            case 'open': return 'В работе'
            case 'waiting_customer': return 'Ожидаем клиента'
            case 'waiting_internal': return 'Внутренний'
            case 'resolved': return 'Завершён'
            default: return status
        }
    }

    const getChannelBadge = (channel: string) => {
        switch (channel) {
            case 'whatsapp': return <span className="flex items-center gap-1.5 text-[10px] font-black text-emerald-500 bg-emerald-500/10 px-2 py-0.5 rounded-full">🟢 WA</span>
            case 'telegram': return <span className="flex items-center gap-1.5 text-[10px] font-black text-blue-500 bg-blue-500/10 px-2 py-0.5 rounded-full">🔵 TG</span>
            case 'max': return <span className="flex items-center gap-1.5 text-[10px] font-black text-purple-500 bg-purple-500/10 px-2 py-0.5 rounded-full">🟣 MAX</span>
            case 'yandex_pro': return <span className="flex items-center gap-1.5 text-[10px] font-black text-yellow-500 bg-yellow-500/10 px-2 py-0.5 rounded-full">🟡 YP</span>
            default: return null
        }
    }

    return (
        <div className="flex h-[calc(100vh-160px)] w-full overflow-hidden rounded-[2rem] border bg-background/40 backdrop-blur-3xl shadow-2xl transition-all duration-500">
            {/* Sidebar */}
            <div className="w-[340px] border-r bg-muted/10 flex flex-col shrink-0">
                <div className="p-5 border-b space-y-4">
                    <div className="flex items-center justify-between pb-2 border-b border-border/10">
                        <h2 className="text-2xl font-black tracking-tighter text-foreground flex items-center gap-2">
                            Inbox
                            <div className="h-2 w-2 rounded-full bg-primary animate-pulse" />
                        </h2>
                        <Button 
                            variant="ghost" 
                            size="icon" 
                            onClick={() => setIsNewChatModalOpen(true)}
                            className="h-10 w-10 rounded-2xl bg-primary/10 text-primary hover:bg-primary/20"
                        >
                            <PlusCircle size={20} />
                        </Button>
                    </div>

                    {/* CHANNEL FILTER - PROMINENT TOP ROW */}
                    <div className="flex gap-2 overflow-x-auto no-scrollbar pb-1">
                        <button 
                            onClick={() => { setChannelFilter('all'); setSelectedProfileFilter('all'); }} 
                            className={`px-4 py-2 rounded-xl text-[11px] font-black uppercase tracking-wider transition-all border whitespace-nowrap flex items-center gap-1.5 ${channelFilter === 'all' ? 'bg-primary border-primary text-primary-foreground shadow-lg scale-105' : 'bg-background border-border text-muted-foreground opacity-60 hover:opacity-100'}`}
                        >
                            Все
                        </button>
                        <button 
                            onClick={() => { setChannelFilter('whatsapp'); setSelectedProfileFilter('all'); }} 
                            className={`px-4 py-2 rounded-xl text-[11px] font-black uppercase tracking-wider transition-all border whitespace-nowrap flex items-center gap-1.5 ${channelFilter === 'whatsapp' ? 'bg-emerald-500 border-emerald-500 text-white shadow-lg scale-105' : 'bg-background border-border text-muted-foreground opacity-60 hover:opacity-100'}`}
                        >
                            WA {channelFilter === 'whatsapp' ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                        </button>
                        <button 
                            onClick={() => { setChannelFilter('telegram'); setSelectedProfileFilter('all'); }} 
                            className={`px-4 py-2 rounded-xl text-[11px] font-black uppercase tracking-wider transition-all border whitespace-nowrap flex items-center gap-1.5 ${channelFilter === 'telegram' ? 'bg-blue-500 border-blue-500 text-white shadow-lg scale-105' : 'bg-background border-border text-muted-foreground opacity-60 hover:opacity-100'}`}
                        >
                            TG {channelFilter === 'telegram' ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                        </button>
                        <button 
                            onClick={() => { setChannelFilter('max'); setSelectedProfileFilter('all'); }} 
                            className={`px-4 py-2 rounded-xl text-[11px] font-black uppercase tracking-wider transition-all border whitespace-nowrap flex items-center gap-1.5 ${channelFilter === 'max' ? 'bg-purple-500 border-purple-500 text-white shadow-lg scale-105' : 'bg-background border-border text-muted-foreground opacity-60 hover:opacity-100'}`}
                        >
                            MAX {channelFilter === 'max' ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                        </button>
                    </div>

                    {/* PROFILE FILTER - APPEARS WHEN CHANNEL SELECTED */}
                    {channelFilter !== 'all' && availableProfiles[channelFilter]?.length > 0 && (
                        <div className="flex flex-wrap gap-2 p-3 bg-muted/30 rounded-2xl border border-white/5 animate-in fade-in zoom-in-95 duration-200">
                            <button 
                                onClick={() => setSelectedProfileFilter('all')} 
                                className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-tighter transition-all border whitespace-nowrap ${selectedProfileFilter === 'all' ? 'bg-background border-primary/50 text-primary shadow-sm' : 'bg-transparent border-transparent text-muted-foreground opacity-60 hover:opacity-100'}`}
                            >
                                Весь {channelFilter === 'whatsapp' ? 'WhatsApp' : channelFilter.toUpperCase()}
                            </button>
                            {availableProfiles[channelFilter].map((p: any) => (
                                <button 
                                    key={p.id}
                                    onClick={() => setSelectedProfileFilter(p.id)} 
                                    className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-tighter transition-all border whitespace-nowrap ${selectedProfileFilter === p.id ? 'bg-background border-primary/50 text-primary shadow-sm' : 'bg-transparent border-transparent text-muted-foreground opacity-60 hover:opacity-100'}`}
                                >
                                    {p.name.split(' (')[0]}
                                </button>
                            ))}
                        </div>
                    )}

                    {/* SEARCH - MOVED BELOW FILTERS */}
                    <div className="relative group">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/40 transition-colors group-focus-within:text-primary" size={16} />
                        <Input 
                            placeholder="Поиск..." 
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="pl-10 h-11 bg-background/80 border-none ring-1 ring-border/50 focus-visible:ring-primary/40 rounded-2xl shadow-sm transition-all" 
                        />
                    </div>

                    {/* STATUS FILTERS - ROW 3 */}
                    <div className="flex gap-2 overflow-x-auto no-scrollbar pb-1 pt-1">
                        <button onClick={() => setActiveFilter('all')} className={`px-2.5 py-1.5 rounded-xl text-[10px] font-bold uppercase tracking-wider transition-all border whitespace-nowrap ${activeFilter === 'all' ? 'bg-primary/10 border-primary/20 text-primary shadow-sm' : 'bg-background border-border text-muted-foreground opacity-70 hover:opacity-100'}`}>Все</button>
                        <button onClick={() => setActiveFilter('unread')} className={`px-2.5 py-1.5 rounded-xl text-[10px] font-bold uppercase tracking-wider transition-all border whitespace-nowrap ${activeFilter === 'unread' ? 'bg-primary/10 border-primary/20 text-primary shadow-sm' : 'bg-background border-border text-muted-foreground opacity-70 hover:opacity-100'}`}>Непрочитанные</button>
                        <button onClick={() => setActiveFilter('requires_response')} className={`px-2.5 py-1.5 rounded-xl text-[10px] font-bold uppercase tracking-wider transition-all border whitespace-nowrap ${activeFilter === 'requires_response' ? 'bg-primary/10 border-primary/20 text-primary shadow-sm' : 'bg-background border-border text-muted-foreground opacity-70 hover:opacity-100'}`}>Ожидают</button>
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto custom-scrollbar bg-background/30">
                    <div className="p-3 space-y-2">
                        {isLoading ? (
                             <div className="p-12 text-center text-muted-foreground animate-pulse text-sm font-medium">Синхронизация...</div>
                        ) : filteredConversations.length === 0 ? (
                            <div className="p-12 text-center">
                                <MessageSquare className="mx-auto mb-3 opacity-10" size={48} />
                                <p className="text-muted-foreground/50 text-xs font-bold uppercase tracking-widest">Пусто</p>
                            </div>
                        ) : filteredConversations.map((chat) => (
                            <button
                                key={chat.id}
                                onClick={() => setSelectedChatId(chat.id)}
                                className={`w-full group flex items-start gap-3 p-4 rounded-3xl transition-all duration-300 relative ${
                                    selectedChatId === chat.id 
                                    ? "bg-card shadow-xl ring-2 ring-primary/20 scale-[1.02] z-10" 
                                    : "hover:bg-muted/50 border border-transparent"
                                }`}
                            >
                                <div className="relative shrink-0">
                                    <div className={`h-14 w-14 rounded-2xl border bg-muted flex items-center justify-center font-black text-xs transition-transform duration-500 group-hover:rotate-3 ${
                                        selectedChatId === chat.id ? "border-primary/50 ring-2 ring-primary/10" : "border-border/50"
                                    }`}>
                                        {chat.name?.substring(0, 2).toUpperCase() || "DR"}
                                    </div>
                                    <div className="absolute -bottom-1 -right-1 bg-background rounded-lg p-0.5 shadow-sm border border-border/50">
                                        {getChannelBadge(chat.channel)}
                                    </div>
                                </div>

                                <div className="flex-1 text-left min-w-0 py-0.5">
                                    <div className="flex items-center justify-between gap-2 mb-1">
                                        <span className={`font-black text-sm truncate ${chat.unreadCount > 0 ? 'text-foreground' : 'text-foreground/80'}`}>
                                            {chat.name || "Водитель"}
                                        </span>
                                        <div className="flex items-center gap-1.5 shrink-0">
                                            {chat.requiresResponse && (
                                                <div className="flex items-center gap-1 bg-red-500/10 text-red-500 px-1.5 py-0.5 rounded-lg border border-red-500/20">
                                                    <AlertCircle size={8} />
                                                    <span className="text-[8px] font-black uppercase tracking-tighter">Ждёт ответа</span>
                                                </div>
                                            )}
                                            <span className="text-[10px] font-medium opacity-40">
                                                {chat.lastMessageAt ? new Date(chat.lastMessageAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                                            </span>
                                        </div>
                                    </div>
                                    
                                    <p className={`text-[11px] line-clamp-2 leading-snug break-words ${chat.unreadCount > 0 ? 'font-bold text-foreground opacity-90' : 'text-muted-foreground/60'}`}>
                                        {(chat as any).messages?.[0]?.content || "Сообщений пока нет..."}
                                    </p>
                                    
                                    <div className="mt-2 flex items-center justify-between">
                                        <div className="flex items-center gap-1 bg-muted/50 px-2 py-0.5 rounded-lg border border-border/20">
                                            <span className={`text-[9px] font-black uppercase tracking-widest ${
                                                chat.status === 'new' ? 'text-blue-500' :
                                                chat.status === 'open' ? 'text-emerald-500' :
                                                chat.status === 'waiting_customer' ? 'text-orange-500' :
                                                'text-muted-foreground'
                                            }`}>
                                                {getStatusLabel(chat.status)}
                                            </span>
                                        </div>
                                        {chat.unreadCount > 0 && (
                                            <div className="h-5 min-w-[1.25rem] px-1 rounded-full bg-red-500 flex items-center justify-center shadow-lg shadow-red-500/40 animate-in zoom-in duration-300">
                                                <span className="text-[10px] font-black text-white leading-none">{chat.unreadCount}</span>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </button>
                        ))}
                    </div>
                </div>
            </div>

            {/* Chat Window */}
            <div className="flex-1 flex flex-col bg-background/10 backdrop-blur-md relative overflow-hidden">
                {selectedChat ? (
                    <>
                        {/* Header */}
                        <div className="h-20 px-8 border-b flex items-center justify-between bg-card/40 backdrop-blur-xl sticky top-0 z-20">
                            <div className="flex items-center gap-5">
                                <div className="h-12 w-12 rounded-2xl bg-primary/5 border border-primary/10 flex items-center justify-center text-primary shadow-inner">
                                    <User size={24} />
                                </div>
                                <div className="space-y-0.5">
                                    <div className="flex items-center gap-2">
                                        <h3 className="font-extrabold text-lg text-foreground tracking-tight leading-none">{selectedChat.name}</h3>
                                        <Badge variant="outline" className={`text-[9px] font-black tracking-tighter uppercase px-1.5 h-4 border-none ${
                                            selectedChat.status === 'new' ? 'bg-blue-500/10 text-blue-500' :
                                            selectedChat.status === 'open' ? 'bg-emerald-500/10 text-emerald-500' :
                                            selectedChat.status === 'waiting_customer' ? 'bg-orange-500/10 text-orange-500' :
                                            'bg-muted text-muted-foreground'
                                        }`}>
                                            {getStatusLabel(selectedChat.status)}
                                        </Badge>
                                        {selectedChat.requiresResponse && (
                                            <Badge variant="outline" className="text-[9px] font-black tracking-tighter bg-red-500/10 text-red-500 border-none px-1.5 h-4 flex items-center gap-0.5">
                                                <AlertCircle size={8} /> Ждёт ответа
                                            </Badge>
                                        )}
                                    </div>
                                    <div className="flex items-center gap-3">
                                        <div className="flex items-center gap-1.5">
                                            {getChannelBadge(selectedChat.channel)}
                                        </div>
                                        <div className="flex gap-1 ml-1">
                                            {availableChannels.map(ch => (
                                                <div 
                                                    key={ch.type} 
                                                    title={ch.available ? `Доступен в ${ch.type}` : `${ch.type} не подключен`}
                                                    className={`h-4 w-4 rounded-full flex items-center justify-center p-0.5 border ${
                                                        ch.available ? 'bg-primary/10 border-primary/20 opacity-100' : 'bg-muted opacity-20'
                                                    }`}
                                                >
                                                    {getChannelBadge(ch.type)}
                                                </div>
                                            ))}
                                        </div>
                                        <span className="text-[10px] text-muted-foreground/50 font-mono tracking-tighter leading-none">
                                            {selectedChat.driver?.phone || 
                                             (selectedChat.externalChatId.includes(':') ? `+${selectedChat.externalChatId.split(':')[1]}` : `+${selectedChat.externalChatId}`)}
                                        </span>
                                    </div>
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
                                <div className="flex items-center mr-4">
                                    <div className="flex -space-x-1.5 overflow-hidden">
                                        {[1,2].map(i => (
                                            <div key={i} className="inline-block h-7 w-7 rounded-full ring-2 ring-background bg-muted border border-border flex items-center justify-center">
                                                <User size={12} className="opacity-40" />
                                            </div>
                                        ))}
                                    </div>
                                    <span className="ml-2 text-[10px] font-bold text-muted-foreground/60">+2 оператора</span>
                                </div>
                                <div className="flex gap-1">
                                    <Button variant="ghost" size="icon" className="h-11 w-11 rounded-2xl text-muted-foreground hover:bg-primary/5 hover:text-primary transition-all"><Phone size={20} /></Button>
                                    <Button variant="ghost" size="icon" className="h-11 w-11 rounded-2xl text-muted-foreground hover:bg-primary/5 hover:text-primary transition-all"><Video size={20} /></Button>
                                    <Button variant="ghost" size="icon" className="h-11 w-11 rounded-2xl text-muted-foreground hover:bg-primary/5 hover:text-primary transition-all"><MoreVertical size={20} /></Button>
                                </div>
                            </div>
                        </div>

                        {/* Ghost Actions Area (AI Suggestions) */}
                        <div className="px-8 mt-4 animate-in slide-in-from-top-4 duration-500">
                            <div className="bg-primary/10 border border-primary/20 rounded-[1.5rem] p-4 flex items-center justify-between backdrop-blur-md shadow-lg shadow-primary/5">
                                <div className="flex items-center gap-4">
                                    <div className="h-10 w-10 rounded-xl bg-primary flex items-center justify-center shadow-lg shadow-primary/20">
                                        <Zap size={20} className="text-primary-foreground animate-pulse" />
                                    </div>
                                    <div>
                                        <div className="flex items-center gap-2 mb-1">
                                            <p className="text-[11px] font-black uppercase tracking-widest text-primary leading-none">Ghost Suggestion</p>
                                            <span className="text-[9px] text-primary/50 font-mono italic">AI думает: {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                                        </div>
                                        <p className="text-sm font-bold text-foreground/80 leading-tight">Водитель просит перезвонить. Создать напоминание в CRM?</p>
                                    </div>
                                </div>
                                <div className="flex gap-2">
                                    <Button size="sm" className="rounded-xl h-9 px-4 bg-primary text-primary-foreground font-bold text-xs shadow-md">Создать задачу</Button>
                                    <Button size="sm" variant="outline" className="rounded-xl h-9 px-4 border-primary/30 text-primary font-bold text-xs hover:bg-primary/5">Пропустить</Button>
                                </div>
                            </div>
                        </div>

                        {/* Messages Area */}
                        <div 
                            ref={scrollContainerRef}
                            style={{ overflowAnchor: 'none' }}
                            className="flex-1 overflow-y-auto p-8 custom-scrollbar space-y-8 mt-2 relative z-0"
                        >
                            <div className="max-w-4xl mx-auto flex flex-col gap-6">
                                {messages.length === 0 && (
                                    <div className="flex flex-col items-center justify-center py-20 text-muted-foreground/10 select-none">
                                        <MessageSquare size={120} />
                                        <p className="font-black text-2xl tracking-tighter uppercase mt-4">No History</p>
                                    </div>
                                )}
                                {messages.map((msg, idx) => {
                                    const nextMsg = messages[idx + 1]
                                    const isLastInGroup = !nextMsg || nextMsg.direction !== msg.direction
                                    
                                    if (msg.type === 'system') {
                                        return (
                                            <div key={idx} className="flex justify-center my-2">
                                                <div className="bg-muted px-4 py-1.5 rounded-full border border-border/50 shadow-sm">
                                                    <span className="text-[10px] font-bold text-muted-foreground/70 uppercase tracking-widest">{msg.content}</span>
                                                </div>
                                            </div>
                                        )
                                    }

                                    return (
                                        <div 
                                            key={idx} 
                                            className={`flex ${msg.direction === 'outbound' ? 'justify-end pl-20' : 'justify-start pr-20'}`}
                                        >
                                            <div className="relative group">
                                                <div className={`p-4 rounded-[1.5rem] shadow-sm transition-all duration-300 hover:shadow-xl ${
                                                    msg.direction === 'outbound' 
                                                    ? `bg-primary text-primary-foreground ${isLastInGroup ? 'rounded-br-none' : ''} shadow-primary/10` 
                                                    : `bg-card border border-border/60 ${isLastInGroup ? 'rounded-bl-none' : ''}`
                                                }`}>
                                                    <p className="text-[14px] leading-relaxed font-medium whitespace-pre-wrap">{msg.content}</p>
                                                    <div className="flex items-center justify-end gap-1.5 mt-2 opacity-40 group-hover:opacity-100 transition-opacity">
                                                        <span className="text-[9px] font-black tracking-tighter uppercase whitespace-nowrap">
                                                            {new Date(msg.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                                        </span>
                                                        {msg.direction === 'outbound' && (
                                                            <div className="flex -space-x-1.5">
                                                                <CheckCheck size={12} className={msg.status === 'read' ? "text-primary-foreground" : "opacity-30"} />
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    )
                                })}
                                <div ref={messagesEndRef} />
                            </div>
                        </div>

                        {/* Input Area */}
                        <div className="p-8 bg-card/40 backdrop-blur-2xl border-t">
                            <div className="max-w-4xl mx-auto space-y-4">
                                <div className="flex items-end gap-4 p-2 pl-4 pr-3 bg-background/80 rounded-[1.5rem] ring-1 ring-border/50 focus-within:ring-primary/30 transition-all shadow-xl shadow-black/5">
                                    <div className="flex gap-1 pb-1.5 items-center">
                                        <div className="flex flex-col gap-2 mr-4 flex-shrink-0">
                                            <span className="text-[8px] font-black uppercase tracking-widest text-muted-foreground/50 ml-1">Отправить через:</span>
                                            <div className="flex bg-muted/40 p-1 rounded-xl border border-border/50">
                                                {availableChannels.map(ch => (
                                                    <button
                                                        key={ch.type}
                                                        onClick={() => setSelectedChannelForOutbound(ch.type as any)}
                                                        className={`h-11 px-3 rounded-lg text-[10px] font-black transition-all flex flex-col items-center justify-center gap-0.5 relative ${
                                                            selectedChannelForOutbound === ch.type 
                                                            ? 'bg-background shadow-md ring-1 ring-border/50 translate-y-[-1px]' 
                                                            : 'hover:bg-primary/5 text-muted-foreground opacity-40 hover:opacity-100'
                                                        } ${!ch.available && 'grayscale pointer-events-none opacity-10'}`}
                                                    >
                                                        <span className="flex items-center gap-1">
                                                            {ch.type === 'whatsapp' ? '🟢 WA' : 
                                                             ch.type === 'telegram' ? '🔵 TG' : 
                                                             ch.type === 'max' ? '🟣 MAX' : '🟡 YP'}
                                                        </span>
                                                        <span className={`text-[7px] tracking-tight uppercase px-1 rounded-[4px] ${
                                                            ch.available 
                                                            ? 'bg-emerald-500/10 text-emerald-500 font-black' 
                                                            : 'bg-red-500/10 text-red-500'
                                                        }`}>
                                                            {ch.available ? 'Активен' : 'Откл.'}
                                                        </span>
                                                    </button>
                                                ))}
                                            </div>
                                        </div>

                                        {(selectedChannelForOutbound === 'telegram' || selectedChannelForOutbound === 'max' || selectedChannelForOutbound === 'whatsapp') && 
                                         availableProfiles[selectedChannelForOutbound]?.length > 0 && (
                                            <div className="flex flex-col gap-2 flex-shrink-0 animate-in fade-in slide-in-from-left-2 duration-300">
                                                <span className="text-[8px] font-black uppercase tracking-widest text-muted-foreground/50 ml-1">Отправитель:</span>
                                                <select 
                                                    value={selectedProfileId || ''} 
                                                    onChange={(e) => setSelectedProfileId(e.target.value)}
                                                    className="h-11 px-4 rounded-xl border border-border/50 bg-muted/40 text-[10px] font-bold focus:ring-1 focus:ring-primary/30 outline-none appearance-none cursor-pointer hover:bg-muted/60 transition-colors"
                                                >
                                                    {availableProfiles[selectedChannelForOutbound].map((p: any) => (
                                                        <option key={p.id} value={p.id}>{p.name}</option>
                                                    ))}
                                                </select>
                                            </div>
                                        )}
                                        <Button variant="ghost" size="icon" className="h-10 w-10 text-muted-foreground hover:text-primary/70 transition-colors rounded-xl"><ClipIcon size={20} /></Button>
                                    </div>
                                    
                                    <textarea
                                        rows={1}
                                        value={newMessage}
                                        onChange={(e) => {
                                            setNewMessage(e.target.value)
                                            e.target.style.height = 'auto'
                                            e.target.style.height = Math.min(e.target.scrollHeight, 200) + 'px'
                                        }}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter' && !e.shiftKey) {
                                                e.preventDefault()
                                                handleSendMessage()
                                            }
                                        }}
                                        placeholder="Напишите ответ..."
                                        className="flex-1 bg-transparent border-none focus:ring-0 text-md py-3 resize-none max-h-[200px] custom-scrollbar font-medium"
                                    />
                                    
                                    <Button 
                                        onClick={handleSendMessage}
                                        disabled={!newMessage.trim()}
                                        className="h-12 w-12 rounded-[1.2rem] bg-primary hover:bg-primary/90 shadow-xl shadow-primary/20 shrink-0 transition-transform active:scale-90 group"
                                    >
                                        <SendHorizonal size={22} className="group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
                                    </Button>
                                </div>
                            </div>
                        </div>
                    </>
                ) : (
                    <div className="flex-1 flex flex-col items-center justify-center text-center p-12 animate-in fade-in zoom-in-95 duration-1000">
                        <div className="relative mb-12">
                            <div className="h-44 w-44 rounded-[3.5rem] bg-gradient-to-br from-primary/20 to-primary/5 shadow-2xl flex items-center justify-center rotate-3 scale-110">
                                <MessageSquare size={72} className="text-primary opacity-80 -rotate-3" />
                            </div>
                            <div className="absolute -top-4 -right-4 h-16 w-16 rounded-[1.5rem] bg-background shadow-xl border border-border/50 flex items-center justify-center animate-bounce">
                                <PlusCircle size={32} className="text-primary" />
                            </div>
                        </div>
                        <h3 className="text-4xl font-black tracking-tight text-foreground leading-tight">Ваш Unified Inbox</h3>
                        <p className="text-muted-foreground/60 max-w-sm mt-4 text-lg font-medium leading-relaxed">
                            Выберите водителя слева, чтобы начать продуктивное общение через Telegram, WhatsApp или Yandex.Pro.
                        </p>
                        <div className="mt-12 grid grid-cols-2 gap-4">
                            <div className="flex items-center gap-3 bg-muted/40 border border-border/40 rounded-3xl px-6 py-4 shadow-sm grayscale opacity-50"><Phone size={20} className="text-emerald-500" /> WhatsApp</div>
                            <div className="flex items-center gap-3 bg-muted/40 border border-border/40 rounded-3xl px-6 py-4 shadow-sm grayscale opacity-50"><Zap size={20} className="text-blue-500" /> Telegram</div>
                        </div>
                    </div>
                )}
            </div>

            {/* New Chat Modal */}
            {isNewChatModalOpen && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 animate-in fade-in duration-300">
                    <div className="absolute inset-0 bg-black/70 backdrop-blur-xl" onClick={() => setIsNewChatModalOpen(false)} />
                    <div className="relative bg-white w-full max-w-lg rounded-[2.5rem] shadow-[0_20px_70px_rgba(0,0,0,0.5)] border border-white/20 overflow-hidden flex flex-col max-h-[85vh] animate-in zoom-in-95 duration-300">
                        <div className="p-8 border-b bg-slate-50 flex items-center justify-between">
                            <div>
                                <h3 className="text-2xl font-black tracking-tighter text-slate-900">Новый чат</h3>
                                <p className="text-[10px] text-slate-500 font-black uppercase tracking-widest mt-1">Найдите водителя и выберите канал</p>
                            </div>
                            <Button variant="ghost" size="icon" onClick={() => setIsNewChatModalOpen(false)} className="rounded-2xl h-12 w-12 hover:bg-slate-200 font-bold text-lg text-slate-900">×</Button>
                        </div>
                        
                        <div className="p-8 space-y-6 overflow-y-auto">
                            <div className="relative group">
                                <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground/40 group-focus-within:text-primary transition-colors" size={20} />
                                <Input 
                                    placeholder="Имя или номер телефона водитея..." 
                                    className="h-14 pl-12 rounded-2xl bg-slate-100 border-none ring-1 ring-slate-200 focus-visible:ring-primary text-md font-bold text-slate-900 placeholder:text-slate-400"
                                    value={searchDriverQuery}
                                    onChange={(e) => setSearchDriverQuery(e.target.value)}
                                    autoFocus
                                />
                            </div>

                            <div className="space-y-2">
                                {foundDrivers.length > 0 ? (
                                    foundDrivers.map(driver => (
                                        <div key={driver.id} className="space-y-4">
                                            <button 
                                                onClick={() => setSelectedDriverForNewChat(driver)}
                                                className={`w-full flex items-center justify-between p-4 rounded-3xl transition-all border ${
                                                    selectedDriverForNewChat?.id === driver.id 
                                                    ? 'bg-primary/5 border-primary/30 ring-2 ring-primary/10' 
                                                    : 'hover:bg-muted/50 border-transparent bg-muted/20'
                                                }`}
                                            >
                                                <div className="flex items-center gap-4">
                                                    <div className="h-12 w-12 rounded-2xl bg-muted border flex items-center justify-center font-black text-xs">
                                                        {driver.fullName.substring(0, 2).toUpperCase()}
                                                    </div>
                                                    <div className="text-left">
                                                        <p className="font-bold text-foreground leading-tight">{driver.fullName}</p>
                                                        <p className="text-[11px] text-muted-foreground font-mono opacity-60">{driver.phone || 'Нет номера'}</p>
                                                    </div>
                                                </div>
                                                <div className="flex items-center gap-2">
                                                    <Badge variant="outline" className="text-[9px] uppercase tracking-tighter opacity-50 font-black">{driver.segment}</Badge>
                                                </div>
                                            </button>

                                            {selectedDriverForNewChat?.id === driver.id && (
                                                <div className="p-6 bg-muted/30 rounded-3xl border border-border/50 grid grid-cols-2 gap-4 animate-in slide-in-from-top-2 duration-300">
                                                    <Button 
                                                        disabled={isStartingChat || !driver.phone} 
                                                        onClick={() => {
                                                            console.log("[Messenger] Clicked WhatsApp button")
                                                            handleStartNewChat(driver.id, 'whatsapp')
                                                        }}
                                                        className="h-14 rounded-2xl bg-emerald-500 hover:bg-emerald-600 text-white font-bold flex flex-col items-center justify-center gap-0.5 shadow-lg shadow-emerald-500/20"
                                                    >
                                                        <span className="text-lg">WhatsApp</span>
                                                        <span className="text-[9px] opacity-70 uppercase tracking-widest font-black">{driver.phone || 'Нет номера'}</span>
                                                    </Button>
                                                    <Button 
                                                        disabled={isStartingChat} 
                                                        onClick={() => {
                                                            console.log("[Messenger] Clicked Telegram button")
                                                            handleStartNewChat(driver.id, 'telegram')
                                                        }}
                                                        className="h-14 rounded-2xl bg-blue-500 hover:bg-blue-600 text-white font-bold flex flex-col items-center justify-center gap-0.5 shadow-lg shadow-blue-500/20"
                                                    >
                                                        <span className="text-lg">Telegram</span>
                                                        <span className="text-[9px] opacity-70 uppercase tracking-widest font-black">По ID/Username</span>
                                                    </Button>
                                                    <Button 
                                                        disabled={isStartingChat || !driver.phone} 
                                                        onClick={() => {
                                                            console.log("[Messenger] Clicked MAX button")
                                                            handleStartNewChat(driver.id, 'max')
                                                        }}
                                                        className="h-14 rounded-2xl col-span-2 bg-purple-500 hover:bg-purple-600 text-white font-bold flex flex-col items-center justify-center gap-0.5 shadow-lg shadow-purple-500/20"
                                                    >
                                                        <span className="text-lg">MAX Messenger</span>
                                                        <span className="text-[9px] opacity-70 uppercase tracking-widest font-black">Через Scraper</span>
                                                    </Button>
                                                </div>
                                            )}
                                        </div>
                                    ))
                                ) : searchDriverQuery.length >= 2 ? (
                                    <div className="p-12 text-center text-muted-foreground opacity-40 font-bold uppercase tracking-widest text-xs">Ничего не найдено</div>
                                ) : (
                                    <div className="p-12 text-center text-muted-foreground opacity-40 font-bold uppercase tracking-widest text-xs">Введите имя для поиска</div>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}
