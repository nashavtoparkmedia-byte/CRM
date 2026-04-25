"use client"

import { useState, useRef, useEffect } from "react"
import { useChatNavigation } from "../hooks/useChatNavigation"
import { useConversations, Conversation } from "../hooks/useConversations"

const SELECTED_ACCOUNTS_KEY = 'chat-selected-accounts-v1'

export default function ChatChannelTabs({ activeChannelTab, chat, failedChannels }: { activeChannelTab: string, chat: Conversation, failedChannels?: Set<string> }) {
    const { conversations } = useConversations()
    const { updateQuery } = useChatNavigation()
    const [expandedChannel, setExpandedChannel] = useState<string | null>(null)
    const [channelAccounts, setChannelAccounts] = useState<Record<string, any[]>>({})
    const [selectedAccounts, setSelectedAccounts] = useState<Record<string, string>>({})
    const dropdownRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        const fetchAccounts = async () => {
            try {
                const res = await fetch('/api/channels/accounts')
                const data = await res.json()
                setChannelAccounts(data)
                const saved = localStorage.getItem(SELECTED_ACCOUNTS_KEY)
                const initialSelections: Record<string, string> = saved ? JSON.parse(saved) : {}
                Object.entries(data).forEach(([ch, accs]: [string, any]) => {
                    if (!initialSelections[ch] && accs.length > 0) {
                        const def = accs.find((a: any) => a.isDefault) || accs[0]
                        initialSelections[ch] = def.id
                    }
                })
                setSelectedAccounts(initialSelections)
            } catch (err) {
                console.error("Failed to fetch channel accounts", err)
            }
        }
        fetchAccounts()
    }, [])

    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
                setExpandedChannel(null)
            }
        }
        document.addEventListener('mousedown', handleClickOutside)
        return () => document.removeEventListener('mousedown', handleClickOutside)
    }, [])

    const channels = [
        { id: 'all', label: 'Все', short: 'All', channelKey: '' },
        { id: 'wa', label: 'WhatsApp', short: 'WhatsApp', dot: 'bg-emerald-500', channelKey: 'whatsapp' },
        { id: 'tg', label: 'Telegram', short: 'Telegram', dot: 'bg-blue-500', channelKey: 'telegram' },
        { id: 'max', label: 'MAX', short: 'MAX', dot: 'bg-purple-500', channelKey: 'max' },
        { id: 'ypro', label: 'Yandex Pro', short: 'Yandex Pro', dot: 'bg-yellow-500', channelKey: 'yandex_pro' },
        { id: 'phone', label: 'Телефон', short: 'Телефон', dot: 'bg-orange-500', channelKey: 'phone' }
    ]

    // Get unread count for a channel
    const getChannelUnread = (channelKey: string): number => {
        if (!channelKey) {
            // "All" tab — total unread
            return chat.unreadCount || 0
        }
        return chat.channelUnread?.[channelKey] || 0
    }

    const handleChannelClick = (chId: string) => {
        if (chId === 'all') {
            updateQuery({ channel: null })
            setExpandedChannel(null)
            return
        }
        const normalizedChannel = chId === 'wa' ? 'whatsapp' : chId === 'tg' ? 'telegram' : chId === 'ypro' ? 'yandex_pro' : chId
        const targetChatId = chat.channelMap?.[normalizedChannel]
        const updates: Record<string, string | null> = { channel: chId }
        if (targetChatId && targetChatId !== chat.id) {
            updates.id = targetChatId
        }
        updateQuery(updates)
        setExpandedChannel(chId === expandedChannel ? null : chId)
    }

    const handleSelectAccount = (channelId: string, accountId: string) => {
        const newSelections = { ...selectedAccounts, [channelId]: accountId }
        setSelectedAccounts(newSelections)
        localStorage.setItem(SELECTED_ACCOUNTS_KEY, JSON.stringify(newSelections))
        setExpandedChannel(null)
    }

    const getActiveAccount = (chId: string) => {
        const accs = channelAccounts[chId]
        if (!accs || accs.length === 0) return null
        return accs.find(a => a.id === selectedAccounts[chId]) || accs[0]
    }

    // Channels where this contact actually has an identity / chat. We
    // dim tabs for the others so the operator instantly sees "TG yes, WA
    // no" — they can still click (the system will route by phone) but
    // visual cue prevents the "messages aren't going through" surprise.
    const availableChannels = new Set<string>(chat.allChannels || [])
    // 'all' is always available. 'phone' is technically always available
    // (any phone can be called) — keep it neutral.
    const channelAlwaysAvailable = (key: string) => key === '' || key === 'phone'

    return (
        <div className="h-[40px] flex items-center px-4 shrink-0 bg-white border-b border-[#E8E8E8] gap-1 relative" ref={dropdownRef}>
            {channels.map((ch) => {
                const isActive = activeChannelTab === ch.id
                const unread = getChannelUnread(ch.channelKey)
                const hasFailed = ch.id !== 'all' && failedChannels?.has(ch.channelKey)
                const isReachable = channelAlwaysAvailable(ch.channelKey) || availableChannels.has(ch.channelKey)

                // Visual indicator priority: failed > unreachable > reachable
                //   reachable+not-active   → green dot ("есть chat в этом канале")
                //   unreachable+not-active → red ⊘   ("канал не активен у контакта")
                //   active                 → no extra mark (full color speaks for itself)
                const showGreenDot = !isActive && isReachable && !channelAlwaysAvailable(ch.channelKey)
                const showRedBlocked = !isActive && !isReachable
                return (
                    <div key={ch.id} className="relative flex items-center">
                        <button
                            onClick={() => handleChannelClick(ch.id)}
                            title={
                                isReachable
                                    ? `${ch.label}${channelAlwaysAvailable(ch.channelKey) ? '' : ': канал активен у контакта'}`
                                    : `${ch.label}: контакт НЕ найден в этом канале — сообщение может не дойти`
                            }
                            className={`h-[32px] px-3 rounded-lg text-[13px] font-semibold transition-all whitespace-nowrap flex items-center gap-1.5 ${
                                isActive
                                ? 'bg-[#3390EC] text-white'
                                : showRedBlocked
                                    ? 'text-red-400 hover:bg-red-50'
                                    : 'text-[#8A9099] hover:bg-[#F0F2F5] hover:text-[#474B50]'
                            }`}
                        >
                            {ch.short}
                            {unread > 0 && (
                                <span className={`h-[18px] min-w-[18px] px-1 rounded-full text-[11px] font-bold flex items-center justify-center leading-none ${
                                    isActive
                                    ? 'bg-white/25 text-white'
                                    : 'bg-[#3390EC] text-white'
                                }`}>
                                    {unread > 99 ? '99+' : unread}
                                </span>
                            )}
                            {hasFailed && !unread && (
                                <span className="w-1.5 h-1.5 rounded-full bg-red-500" title="последняя отправка не удалась" />
                            )}
                            {showGreenDot && !unread && !hasFailed && (
                                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" title="канал активен" />
                            )}
                            {showRedBlocked && !unread && !hasFailed && (
                                <span className="text-red-400 text-[12px] leading-none" title="нет в этом канале">⊘</span>
                            )}
                        </button>

                        {/* Account dropdown */}
                        {expandedChannel === ch.id && channelAccounts[ch.id] && (
                            <div className="absolute top-full left-0 mt-1.5 bg-white rounded-xl shadow-xl border border-[#E0E0E0] py-1.5 min-w-[220px] z-50 animate-in fade-in slide-in-from-top-1 duration-150">
                                <div className="px-3 py-1 text-[10px] font-bold text-gray-400 uppercase tracking-wider">
                                    {ch.label} · Аккаунт отправки
                                </div>
                                {channelAccounts[ch.id].map((acc: any) => {
                                    const isSelected = selectedAccounts[ch.id] === acc.id
                                    return (
                                        <button
                                            key={acc.id}
                                            onClick={(e) => {
                                                e.stopPropagation()
                                                handleSelectAccount(ch.id, acc.id)
                                            }}
                                            className={`w-full px-3 h-[38px] flex items-center gap-2.5 text-[12px] hover:bg-gray-50 transition-colors ${
                                                isSelected ? 'bg-[#3390EC]/5' : ''
                                            }`}
                                        >
                                            <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${ch.dot} ${isSelected ? '' : 'opacity-30'}`} />
                                            <div className="flex-1 text-left min-w-0">
                                                <div className={`font-semibold text-[13px] ${isSelected ? 'text-[#3390EC]' : 'text-[#111]'}`}>
                                                    {acc.label}
                                                </div>
                                                <div className="text-[10px] text-gray-400 font-mono italic">{acc.phone}</div>
                                            </div>
                                            {isSelected && <span className="text-[#3390EC] text-[12px] font-bold">✓</span>}
                                        </button>
                                    )
                                })}
                            </div>
                        )}
                    </div>
                )
            })}

            {/* Active channel's selected account info */}
            {activeChannelTab !== 'all' && getActiveAccount(activeChannelTab) && (
                <div className="flex items-center gap-1.5 ml-auto text-[11px] text-gray-400">
                    <span className="font-medium text-gray-500">{getActiveAccount(activeChannelTab)?.label}</span>
                    {getActiveAccount(activeChannelTab)?.phone && (
                        <span className="font-mono text-[10px] bg-gray-100 px-1.5 py-0.5 rounded">
                            {getActiveAccount(activeChannelTab)?.phone}
                        </span>
                    )}
                </div>
            )}
        </div>
    )
}
