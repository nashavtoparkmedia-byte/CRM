"use client"

import { useState, useRef, useEffect, useMemo } from "react"
import { X, Search, Send } from "lucide-react"
import { useConversations, Conversation } from "../hooks/useConversations"
import { useChatNavigation } from "../hooks/useChatNavigation"

const CHANNELS = [
    { id: 'wa', label: 'WA', color: 'bg-emerald-500', activeBg: 'bg-emerald-50 ring-emerald-500 text-emerald-700', inactiveBg: 'bg-gray-100 text-gray-500 hover:bg-gray-200' },
    { id: 'tg', label: 'TG', color: 'bg-blue-500', activeBg: 'bg-blue-50 ring-blue-500 text-blue-700', inactiveBg: 'bg-gray-100 text-gray-500 hover:bg-gray-200' },
    { id: 'max', label: 'MAX', color: 'bg-purple-500', activeBg: 'bg-purple-50 ring-purple-500 text-purple-700', inactiveBg: 'bg-gray-100 text-gray-500 hover:bg-gray-200' },
    { id: 'ypro', label: 'YP', color: 'bg-yellow-500', activeBg: 'bg-yellow-50 ring-yellow-500 text-yellow-700', inactiveBg: 'bg-gray-100 text-gray-500 hover:bg-gray-200' },
]

export default function NewChatPopover({ onClose }: { onClose: () => void }) {
    const { conversations } = useConversations()
    const { setChatId, setChannel, updateQuery } = useChatNavigation()
    const [query, setQuery] = useState("")
    const [selectedChannel, setSelectedChannel] = useState("tg")
    const [showSuggestions, setShowSuggestions] = useState(false)
    const inputRef = useRef<HTMLInputElement>(null)
    const popoverRef = useRef<HTMLDivElement>(null)

    // Auto-focus input on mount
    useEffect(() => {
        setTimeout(() => inputRef.current?.focus(), 50)
    }, [])

    // Close on click outside
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
                onClose()
            }
        }
        document.addEventListener('mousedown', handleClickOutside)
        return () => document.removeEventListener('mousedown', handleClickOutside)
    }, [onClose])

    // Close on Escape
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [onClose])

    // Contact suggestions — fuzzy match by name or phone
    const suggestions = useMemo(() => {
        if (!query || query.length < 2) return []
        const q = query.toLowerCase()
        return conversations.filter(c =>
            c.name?.toLowerCase().includes(q) ||
            c.driver?.phone?.includes(q) ||
            c.externalChatId?.toLowerCase().includes(q)
        ).slice(0, 5)
    }, [query, conversations])

    const isPhone = /^[\d\s\+\-\(\)]{4,}$/.test(query.trim())

    const handleSelectContact = (chat: Conversation) => {
        // Map conversation channel to URL channel param
        const channelMap: Record<string, string> = { whatsapp: 'wa', telegram: 'tg', max: 'max', yandex_pro: 'ypro' }
        const channelParam = channelMap[chat.channel] || 'all'
        // Atomic update: set both id and channel in a single URL push (prevents race condition)
        updateQuery({ id: chat.id, channel: channelParam === 'all' ? null : channelParam })
        onClose()
        // Focus composer after navigation
        setTimeout(() => {
            document.getElementById('message-composer')?.focus()
        }, 300)
    }

    const handleStartChat = () => {
        if (!query.trim()) return

        // If we have a matching suggestion, open it
        if (suggestions.length > 0) {
            handleSelectContact(suggestions[0])
            return
        }

        // Otherwise: create new chat (in production — POST /api/messages/conversations)
        // For now, we'll create an optimistic entry and navigate
        const tempId = `new-${Date.now()}`
        const channelMap: Record<string, string> = { wa: 'whatsapp', tg: 'telegram', max: 'max', ypro: 'yandex_pro' }

        // Navigate with channel set
        setChannel(selectedChannel as any)
        setChatId(tempId)
        onClose()

        setTimeout(() => {
            document.getElementById('message-composer')?.focus()
        }, 300)
    }

    return (
        <div
            ref={popoverRef}
            className="absolute top-[48px] right-0 w-[300px] bg-white rounded-xl shadow-2xl border border-[#E0E0E0] z-50 animate-in fade-in slide-in-from-top-2 duration-150 overflow-hidden"
        >
            {/* Header */}
            <div className="flex items-center justify-between px-3.5 h-[40px] border-b border-[#E8E8E8]">
                <span className="text-[13px] font-bold text-[#111]">Новый диалог</span>
                <button
                    onClick={onClose}
                    className="w-5 h-5 rounded-full hover:bg-gray-100 flex items-center justify-center text-gray-400 hover:text-gray-700 transition-colors"
                >
                    <X size={12} />
                </button>
            </div>

            {/* Input */}
            <div className="px-3.5 pt-3 pb-2">
                <div className="relative">
                    <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                    <input
                        ref={inputRef}
                        type="text"
                        value={query}
                        onChange={(e) => { setQuery(e.target.value); setShowSuggestions(true) }}
                        onKeyDown={(e) => { if (e.key === 'Enter') handleStartChat() }}
                        placeholder="Телефон или имя..."
                        className="w-full h-[36px] bg-[#F4F5F7] rounded-lg pl-8 pr-3 text-[13px] outline-none placeholder:text-gray-400 font-medium text-[#111] focus:bg-[#EEF0F3] transition-colors"
                    />
                </div>

                {/* Suggestions dropdown */}
                {showSuggestions && suggestions.length > 0 && (
                    <div className="mt-1.5 bg-white border border-[#E8E8E8] rounded-lg shadow-sm max-h-[180px] overflow-y-auto">
                        {suggestions.map(s => (
                            <button
                                key={s.id}
                                onClick={() => handleSelectContact(s)}
                                className="w-full px-3 py-2 flex items-center gap-2.5 hover:bg-gray-50 transition-colors text-left"
                            >
                                <div className="w-[32px] h-[32px] rounded-full bg-[#3390EC] text-white flex items-center justify-center text-[11px] font-bold shrink-0">
                                    {s.name?.substring(0, 2).toUpperCase() || "DR"}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="text-[13px] font-medium text-[#111] truncate">{s.name || "Водитель"}</div>
                                    <div className="text-[11px] text-gray-400 truncate">
                                        {s.driver?.phone || s.externalChatId}
                                    </div>
                                </div>
                                <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                                    s.channel === 'whatsapp' ? 'bg-emerald-50 text-emerald-600' :
                                    s.channel === 'telegram' ? 'bg-blue-50 text-blue-600' :
                                    s.channel === 'max' ? 'bg-purple-50 text-purple-600' :
                                    'bg-yellow-50 text-yellow-600'
                                }`}>
                                    {s.channel === 'whatsapp' ? 'WA' : s.channel === 'telegram' ? 'TG' : s.channel === 'max' ? 'MAX' : 'YP'}
                                </span>
                            </button>
                        ))}
                    </div>
                )}

                {/* New contact hint */}
                {query.trim().length >= 2 && suggestions.length === 0 && (
                    <div className="mt-1.5 px-1 text-[11px] text-gray-400">
                        {isPhone
                            ? <span>📱 Новый контакт: <span className="font-mono text-[#111]">{query.trim()}</span></span>
                            : <span>👤 Поиск: <span className="font-medium text-[#111]">{query.trim()}</span></span>
                        }
                    </div>
                )}
            </div>

            {/* Channel selection */}
            <div className="px-3.5 pb-2.5">
                <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1.5">Канал</div>
                <div className="flex gap-1.5">
                    {CHANNELS.map(ch => (
                        <button
                            key={ch.id}
                            onClick={() => setSelectedChannel(ch.id)}
                            className={`flex-1 h-[30px] text-[11px] font-bold rounded-lg transition-all ${
                                selectedChannel === ch.id
                                    ? `${ch.activeBg} ring-1 ring-inset`
                                    : ch.inactiveBg
                            }`}
                        >
                            {ch.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* Action */}
            <div className="px-3.5 pb-3">
                <button
                    onClick={handleStartChat}
                    disabled={!query.trim()}
                    className={`w-full h-[36px] rounded-lg text-[13px] font-semibold flex items-center justify-center gap-1.5 transition-all ${
                        query.trim()
                            ? 'bg-[#3390EC] text-white hover:bg-[#2B7FD4] active:scale-[0.98] shadow-md shadow-[#3390EC]/20'
                            : 'bg-gray-100 text-gray-400 cursor-not-allowed'
                    }`}
                >
                    <Send size={13} />
                    Написать
                </button>
            </div>
        </div>
    )
}
