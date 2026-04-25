"use client"

import { useState, useRef, useEffect } from "react"
import { X, Search, Send, Loader2, AlertTriangle } from "lucide-react"
import { useContactSearch, ContactSearchResult } from "../hooks/useContactSearch"
import { useStartConversation } from "../hooks/useStartConversation"

const CHANNELS = [
    { id: 'wa', label: 'WA', dbChannel: 'whatsapp', color: 'bg-emerald-500', activeBg: 'bg-emerald-50 ring-emerald-500 text-emerald-700', inactiveBg: 'bg-gray-100 text-gray-500 hover:bg-gray-200' },
    { id: 'tg', label: 'TG', dbChannel: 'telegram', color: 'bg-blue-500', activeBg: 'bg-blue-50 ring-blue-500 text-blue-700', inactiveBg: 'bg-gray-100 text-gray-500 hover:bg-gray-200' },
    { id: 'max', label: 'MAX', dbChannel: 'max', color: 'bg-purple-500', activeBg: 'bg-purple-50 ring-purple-500 text-purple-700', inactiveBg: 'bg-gray-100 text-gray-500 hover:bg-gray-200' },
    { id: 'ypro', label: 'YP', dbChannel: 'yandex_pro', color: 'bg-yellow-500', activeBg: 'bg-yellow-50 ring-yellow-500 text-yellow-700', inactiveBg: 'bg-gray-100 text-gray-500 hover:bg-gray-200' },
]

const CHANNEL_BADGE: Record<string, { label: string; cls: string }> = {
    whatsapp: { label: 'WA', cls: 'bg-emerald-50 text-emerald-600' },
    telegram: { label: 'TG', cls: 'bg-blue-50 text-blue-600' },
    max: { label: 'MAX', cls: 'bg-purple-50 text-purple-600' },
    yandex_pro: { label: 'YP', cls: 'bg-yellow-50 text-yellow-600' },
}

interface NewChatPopoverProps {
    onClose: () => void
    onSelectChat: (chatId: string) => void
    initialQuery?: string
}

export default function NewChatPopover({ onClose, onSelectChat, initialQuery }: NewChatPopoverProps) {
    const [query, setQuery] = useState(initialQuery || "")
    const [selectedChannel, setSelectedChannel] = useState(initialQuery ? "wa" : "tg")
    const [autoStarted, setAutoStarted] = useState(false)
    const [showSuggestions, setShowSuggestions] = useState(false)
    // Phase: when the operator hovers a search result row, channel
    // buttons below preview availability for THAT contact specifically.
    const [hoveredContactId, setHoveredContactId] = useState<string | null>(null)
    const inputRef = useRef<HTMLInputElement>(null)
    const popoverRef = useRef<HTMLDivElement>(null)

    const { results, loading } = useContactSearch(query)
    const { loading: starting, error: startError, startByContact, startByPhone, clearError } = useStartConversation()

    // Pre-check reachability for new phone numbers on TG/WA
    const [reachability, setReachability] = useState<{ reachable: boolean; error?: string } | null>(null)
    const [checking, setChecking] = useState(false)

    useEffect(() => {
        const channelDef = CHANNELS.find(c => c.id === selectedChannel)
        const dbChannel = channelDef?.dbChannel
        const isCheckable = dbChannel === 'telegram' || dbChannel === 'whatsapp'
        const phoneValue = query.trim()
        const isPhoneInput = /^[\d\s\+\-\(\)]{7,}$/.test(phoneValue)

        // Reset if not checkable or not a phone
        if (!isCheckable || !isPhoneInput) {
            setReachability(null)
            setChecking(false)
            return
        }

        setChecking(true)
        setReachability(null)

        const controller = new AbortController()
        const timer = setTimeout(async () => {
            try {
                const res = await fetch('/api/channels/check-reachability', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ phone: phoneValue, channel: dbChannel }),
                    signal: controller.signal,
                })
                const data = await res.json()
                if (!controller.signal.aborted) {
                    // Only show warning when explicitly unreachable
                    setReachability(data.reachable === false ? data : null)
                }
            } catch (err: any) {
                // Aborted or network error — don't show warning
                if (err.name !== 'AbortError') {
                    console.error('[NewChat] Reachability check error:', err.message)
                }
            } finally {
                if (!controller.signal.aborted) setChecking(false)
            }
        }, 600) // debounce 600ms

        return () => {
            clearTimeout(timer)
            controller.abort()
            setChecking(false)
        }
    }, [query, selectedChannel])

    useEffect(() => {
        setTimeout(() => inputRef.current?.focus(), 50)
    }, [])

    // Auto-start chat when opened from tasks with a phone number
    useEffect(() => {
        if (initialQuery && !autoStarted && !starting) {
            setAutoStarted(true)
            // Small delay to let contact search finish first
            const timer = setTimeout(async () => {
                if (results.length > 0) {
                    // Contact found — open existing or create chat
                    await handleSelectContact(results[0])
                } else {
                    // No contact — create new chat by phone
                    const result = await startByPhone(initialQuery, selectedChannel)
                    if (result) {
                        onSelectChat(result.chatId)
                        onClose()
                        setTimeout(() => document.getElementById('message-composer')?.focus(), 300)
                    }
                }
            }, 800)
            return () => clearTimeout(timer)
        }
    }, [initialQuery, autoStarted, results, starting])

    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
                onClose()
            }
        }
        document.addEventListener('mousedown', handleClickOutside)
        return () => document.removeEventListener('mousedown', handleClickOutside)
    }, [onClose])

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [onClose])

    const isPhone = /^[\d\s\+\-\(\)]{4,}$/.test(query.trim())

    const handleSelectContact = async (contact: ContactSearchResult) => {
        const channelDef = CHANNELS.find(c => c.id === selectedChannel)
        const dbChannel = channelDef?.dbChannel || 'telegram'

        const existingChatId = contact.hasChat[dbChannel]

        if (existingChatId) {
            onSelectChat(existingChatId)
            onClose()
            setTimeout(() => document.getElementById('message-composer')?.focus(), 300)
        } else {
            // Contact exists but no chat in this channel — create it directly
            const result = await startByContact(contact.id, selectedChannel)
            if (result) {
                onSelectChat(result.chatId)
                onClose()
                setTimeout(() => document.getElementById('message-composer')?.focus(), 300)
            }
        }
    }

    const handleStartChat = async () => {
        if (!query.trim() || starting) return

        if (results.length > 0) {
            await handleSelectContact(results[0])
            return
        }

        // No contact found — new phone number flow
        if (isPhone) {
            const result = await startByPhone(query.trim(), selectedChannel)
            if (result) {
                onSelectChat(result.chatId)
                onClose()
                setTimeout(() => document.getElementById('message-composer')?.focus(), 300)
            }
        }
    }

    const primaryPhone = (c: ContactSearchResult) =>
        c.phones.find(p => p.isPrimary)?.phone || c.phones[0]?.phone || null

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
                    {(loading || checking) && (
                        <Loader2 size={14} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 animate-spin" />
                    )}
                    <input
                        ref={inputRef}
                        type="text"
                        value={query}
                        onChange={(e) => { setQuery(e.target.value); setShowSuggestions(true) }}
                        onKeyDown={(e) => { if (e.key === 'Enter') handleStartChat() }}
                        placeholder="Телефон или имя..."
                        className="w-full h-[36px] bg-[#F4F5F7] rounded-lg pl-8 pr-8 text-[13px] outline-none placeholder:text-gray-400 font-medium text-[#111] focus:bg-[#EEF0F3] transition-colors"
                    />
                </div>

                {/* Contact search results */}
                {showSuggestions && results.length > 0 && (
                    <div className="mt-1.5 bg-white border border-[#E8E8E8] rounded-lg shadow-sm max-h-[220px] overflow-y-auto">
                        {results.map(contact => {
                            const phone = primaryPhone(contact)
                            const channelDef = CHANNELS.find(c => c.id === selectedChannel)
                            const dbChannel = channelDef?.dbChannel || 'telegram'
                            const hasChatInChannel = !!contact.hasChat[dbChannel]

                            return (
                                <button
                                    key={contact.id}
                                    onClick={() => handleSelectContact(contact)}
                                    onMouseEnter={() => setHoveredContactId(contact.id)}
                                    onMouseLeave={() => setHoveredContactId(prev => prev === contact.id ? null : prev)}
                                    className="w-full px-3 py-2 flex items-center gap-2.5 hover:bg-gray-50 transition-colors text-left group"
                                >
                                    <div className="w-[32px] h-[32px] rounded-full bg-[#3390EC] text-white flex items-center justify-center text-[11px] font-bold shrink-0">
                                        {(contact.displayName || "?").substring(0, 2).toUpperCase()}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="text-[13px] font-medium text-[#111] truncate">
                                            {contact.displayName || "Без имени"}
                                        </div>
                                        <div className="text-[11px] text-gray-400 truncate flex items-center gap-1">
                                            {phone && <span className="font-mono">{phone}</span>}
                                            {!hasChatInChannel && (
                                                <span className="text-[9px] text-orange-500 font-medium">новый</span>
                                            )}
                                        </div>
                                    </div>
                                    {/* Channel badges */}
                                    <div className="flex gap-0.5 shrink-0">
                                        {contact.channels.map(ch => {
                                            const badge = CHANNEL_BADGE[ch]
                                            if (!badge) return null
                                            return (
                                                <span
                                                    key={ch}
                                                    className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${badge.cls}`}
                                                >
                                                    {badge.label}
                                                </span>
                                            )
                                        })}
                                    </div>
                                </button>
                            )
                        })}
                    </div>
                )}

                {/* No results hints */}
                {showSuggestions && query.trim().length >= 2 && !loading && results.length === 0 && (
                    <div className="mt-1.5 px-1 text-[11px] text-gray-400">
                        {isPhone
                            ? <span>Новый номер: <span className="font-mono text-[#111]">{query.trim()}</span></span>
                            : <span>Контакт не найден: <span className="font-medium text-[#111]">{query.trim()}</span></span>
                        }
                    </div>
                )}
            </div>

            {/* Channel selection. Availability comes from the focused
                contact: hovered row > single result > none. Channels with
                an identity get a green dot, channels without get a red
                ⊘. The buttons stay clickable (operator may want to start
                fresh in a new channel). */}
            {(() => {
                const focusedContact =
                    results.find(c => c.id === hoveredContactId) ||
                    (results.length === 1 ? results[0] : null)
                const focusedChannels = new Set<string>(focusedContact?.channels || [])
                return (
                    <div className="px-3.5 pb-2.5">
                        <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1.5 flex items-center justify-between">
                            <span>Канал</span>
                            {focusedContact && (
                                <span className="flex items-center gap-2 text-[9px] font-medium normal-case">
                                    <span className="flex items-center gap-1 text-emerald-600">
                                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />активен
                                    </span>
                                    <span className="flex items-center gap-1 text-red-500">
                                        ⊘ нет
                                    </span>
                                </span>
                            )}
                        </div>
                        <div className="flex gap-1.5">
                            {CHANNELS.map(ch => {
                                const hasIdentity = !focusedContact || focusedChannels.has(ch.dbChannel)
                                return (
                                    <button
                                        key={ch.id}
                                        onClick={() => setSelectedChannel(ch.id)}
                                        title={hasIdentity ? `${ch.label}: канал активен у контакта` : `${ch.label}: контакт НЕ найден — будет создан новый, доставка не гарантирована`}
                                        className={`flex-1 h-[34px] text-[11px] font-bold rounded-lg transition-all relative flex items-center justify-center gap-1 ${
                                            selectedChannel === ch.id
                                                ? `${ch.activeBg} ring-1 ring-inset`
                                                : ch.inactiveBg
                                        }`}
                                    >
                                        <span>{ch.label}</span>
                                        {focusedContact && (
                                            hasIdentity
                                                ? <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" title="активен" />
                                                : <span className="text-red-500 text-[12px] leading-none" title="нет">⊘</span>
                                        )}
                                    </button>
                                )
                            })}
                        </div>
                    </div>
                )
            })()}

            {/* Reachability warning */}
            {reachability && !reachability.reachable && (
                <div className="px-3.5 pb-1.5">
                    <div className="flex items-start gap-1.5 bg-amber-50 text-amber-700 rounded-lg px-2.5 py-1.5">
                        <AlertTriangle size={12} className="shrink-0 mt-0.5" />
                        <span className="text-[11px] leading-tight">{reachability.error}</span>
                    </div>
                </div>
            )}

            {/* Error */}
            {startError && (
                <div className="px-3.5 pb-1">
                    <div className="text-[11px] text-red-500 bg-red-50 rounded-lg px-2.5 py-1.5 flex items-center justify-between">
                        <span>{startError}</span>
                        <button onClick={clearError} className="text-red-400 hover:text-red-600 ml-2">
                            <X size={10} />
                        </button>
                    </div>
                </div>
            )}

            {/* Action */}
            <div className="px-3.5 pb-3">
                <button
                    onClick={handleStartChat}
                    disabled={!query.trim() || starting}
                    className={`w-full h-[36px] rounded-lg text-[13px] font-semibold flex items-center justify-center gap-1.5 transition-all ${
                        !query.trim() || starting
                            ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                            : 'bg-[#3390EC] text-white hover:bg-[#2B7FD4] active:scale-[0.98] shadow-md shadow-[#3390EC]/20'
                    }`}
                >
                    {starting ? (
                        <><Loader2 size={13} className="animate-spin" /> Создаём...</>
                    ) : (
                        <><Send size={13} /> Написать</>
                    )}
                </button>
            </div>
        </div>
    )
}
