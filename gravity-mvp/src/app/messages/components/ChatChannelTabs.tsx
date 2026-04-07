"use client"

import { useState, useRef, useEffect } from "react"
import { useChatNavigation } from "../hooks/useChatNavigation"
import { useConversations, Conversation } from "../hooks/useConversations"

// Initial defaults (overwritten by dynamic fetch)
const SELECTED_ACCOUNTS_KEY = 'chat-selected-accounts-v1'

export default function ChatChannelTabs({ activeChannelTab, chat, failedChannels }: { activeChannelTab: string, chat: Conversation, failedChannels?: Set<string> }) {
    const { conversations } = useConversations()
    const { updateQuery } = useChatNavigation()
    const [expandedChannel, setExpandedChannel] = useState<string | null>(null)
    const [channelAccounts, setChannelAccounts] = useState<Record<string, any[]>>({})
    const [selectedAccounts, setSelectedAccounts] = useState<Record<string, string>>({})
    const dropdownRef = useRef<HTMLDivElement>(null)

    // 1. Fetch real accounts
    useEffect(() => {
        const fetchAccounts = async () => {
            try {
                const res = await fetch('/api/channels/accounts')
                const data = await res.json()
                setChannelAccounts(data)

                // Load saved selections from localStorage
                const saved = localStorage.getItem(SELECTED_ACCOUNTS_KEY)
                const initialSelections: Record<string, string> = saved ? JSON.parse(saved) : {}

                // Ensure defaults are set for all channels
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
        { id: 'all', label: 'Все', short: 'Все' },
        { id: 'wa', label: 'WhatsApp', short: 'WA', dot: 'bg-emerald-500' },
        { id: 'tg', label: 'Telegram', short: 'TG', dot: 'bg-blue-500' },
        { id: 'max', label: 'MAX', short: 'MAX', dot: 'bg-purple-500' },
        { id: 'ypro', label: 'Yandex Pro', short: 'YP', dot: 'bg-yellow-500' }
    ]

    // ONE CLICK = switch channel AND open account dropdown
    const handleChannelClick = (chId: string) => {
        if (chId === 'all') {
            updateQuery({ channel: null })
            setExpandedChannel(null)
            return
        }
        
        // Use channelMap from the merged conversation to find the chatId for the target channel
        const normalizedChannel = chId === 'wa' ? 'whatsapp' : chId === 'tg' ? 'telegram' : chId === 'ypro' ? 'yandex_pro' : chId
        const targetChatId = chat.channelMap?.[normalizedChannel]
        
        // Atomic update: switch channel AND chatId if we have a specific chat for that channel
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

    return (
        <div className="h-[30px] flex items-center px-4 shrink-0 bg-[#FAFAFA] border-b border-[#E8E8E8] gap-0 relative" ref={dropdownRef}>
            {channels.map((ch, idx) => {
                const isActive = activeChannelTab === ch.id
                const activeAccount = ch.id !== 'all' ? getActiveAccount(ch.id) : null
                
                return (
                    <div key={ch.id} className="relative flex items-center">
                        {idx > 0 && <span className="text-gray-300 text-[10px] mx-1.5">·</span>}
                        <button
                            onClick={() => handleChannelClick(ch.id)}
                            className={`text-[12px] transition-all whitespace-nowrap px-0.5 relative ${
                                isActive
                                ? 'text-[#111] font-bold'
                                : 'text-gray-400 hover:text-gray-600 font-medium'
                            }`}
                        >
                            {ch.short || ch.label}
                            {ch.id !== 'all' && failedChannels?.has(
                                ch.id === 'wa' ? 'whatsapp' : ch.id === 'tg' ? 'telegram' : ch.id === 'ypro' ? 'yandex_pro' : ch.id
                            ) && (
                                <span className="absolute -top-0.5 -right-1.5 w-1.5 h-1.5 rounded-full bg-red-500" />
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
            {activeChannelTab !== 'all' && (
                <div className="flex items-center gap-1.5 ml-2.5 text-[10px] text-gray-400 border-l border-[#E0E0E0] pl-2.5">
                    <span className="font-semibold text-gray-500">{getActiveAccount(activeChannelTab)?.label}</span>
                    {getActiveAccount(activeChannelTab)?.phone && (
                        <span className="font-mono text-[9px] bg-gray-100 px-1 rounded">
                            {getActiveAccount(activeChannelTab)?.phone}
                        </span>
                    )}
                </div>
            )}
        </div>
    )
}
