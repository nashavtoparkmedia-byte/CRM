"use client"

import { useState, useRef, useEffect, useMemo, useLayoutEffect } from "react"
import { Virtuoso, VirtuosoHandle } from "react-virtuoso"
import { Message } from "../hooks/useMessages"
import { UIItem, MessageUIItem, DateSeparatorUIItem } from "../utils/message-utils"
import { ArrowDown, Reply, MessageSquare, Copy, ClipboardList, X, Bot, Zap, Check } from "lucide-react"

// In-memory task storage (would be backend in production)
export default function MessageFeed({ 
    chatId, 
    channelTab, 
    uiItems, 
    isLoading,
    hasMoreHistory,
    onLoadMore,
    onReply,
    onCreateTask,
    activeSearchMessageId,
    onFocusComposer,
    lastSentAt
}: { 
    chatId: string
    channelTab: string
    uiItems: UIItem[]
    isLoading: boolean
    hasMoreHistory: boolean
    onLoadMore: () => void
    onReply?: (msg: Message) => void
    onCreateTask?: (msg: Message) => void
    activeSearchMessageId?: string | null
    onFocusComposer?: () => void
    lastSentAt?: number
}) {
    const virtuoso = useRef<VirtuosoHandle>(null)
    const [atBottom, setAtBottom] = useState(true)
    const [showNewMessagesBadge, setShowNewMessagesBadge] = useState(false)
    const seenMessageIds = useRef<Set<string>>(new Set())
    const scrollTimeout = useRef<NodeJS.Timeout | null>(null)
    const previousSentAt = useRef<number>(0)
    const prevItemCount = useRef(uiItems.length)
    const forceFollowAtBottomOnce = useRef(false)

    // 1. Render-Phase: Badge suppression + counter update for Outbound
    if (uiItems.length > prevItemCount.current) {
        const lastItem = uiItems[uiItems.length - 1];
        if (lastItem.type === 'message' && lastItem.message.direction === 'outbound') {
            setShowNewMessagesBadge(false);
        }
        prevItemCount.current = uiItems.length;
    }

    // 2. Centralized Effect Trigger for both Inbound & Outbound Paths
    useEffect(() => {
        if (uiItems.length === 0) return;

        const lastItem = uiItems[uiItems.length - 1];
        if (lastItem.type === 'message') {
            const msgId = lastItem.message.id;
            const isNew = !seenMessageIds.current.has(msgId);
            
            if (isNew) {
                seenMessageIds.current.add(msgId);
                const isOwn = lastItem.message.direction === 'outbound';
                if (isOwn) {
                    // 📜 Outbound: Frame-precise snap — sole scroll mechanism
                     const snap = () => {
                        const scroller = document.querySelector('.message-scroller') as HTMLDivElement;
                        if (scroller) {
                            // Slight padding fix if needed, but keeping original logic
                            scroller.scrollTop = scroller.scrollHeight;
                        }
                    };
                    snap();                              // 0ms: immediate
                    requestAnimationFrame(() => {         // ~16ms
                        snap();
                        requestAnimationFrame(() => {     // ~32ms
                            snap();
                            requestAnimationFrame(snap);  // ~48ms: final safety
                        });
                    });
                } else {
                    // Inbound: Conditional
                    if (atBottom) {
                        virtuoso.current?.scrollToIndex({ index: uiItems.length - 1, align: 'end', behavior: 'auto' });
                    } else {
                        setShowNewMessagesBadge(true);
                    }
                }
            }
        }
    }, [uiItems, atBottom]);

    const scrollToBottom = () => {
        virtuoso.current?.scrollToIndex({ index: uiItems.length - 1, align: 'end', behavior: 'smooth' })
        setShowNewMessagesBadge(false)
    }

    const handleAtBottomChange = (bottom: boolean) => {
        setAtBottom(bottom)
        if (bottom) setShowNewMessagesBadge(false)
    }

    useEffect(() => {
        if (activeSearchMessageId && virtuoso.current) {
            const index = uiItems.findIndex(item => item.type === 'message' && item.message.id === activeSearchMessageId)
            if (index !== -1) {
                virtuoso.current.scrollToIndex({ index, align: 'center', behavior: 'smooth' })
            }
        }
    }, [activeSearchMessageId, uiItems])

    const handleCopyMessage = (text: string) => {
        navigator.clipboard.writeText(text)
    }

    // Mock functions removed. Tasks creation is now handled by onCreateTask prop.

    if (isLoading && uiItems.length === 0) {
        return <div className="flex-1 flex items-center justify-center messenger-bg text-[#8A9099] text-[13px] font-medium">Загрузка сообщений...</div>
    }

    if (uiItems.length === 0) {
        return (
            <div className="flex-1 flex flex-col items-center justify-center messenger-bg px-6 text-center">
                <div className="w-14 h-14 rounded-full bg-white/60 flex items-center justify-center mb-4 text-[#B0B5BA]">
                    <MessageSquare size={22} />
                </div>
                <h3 className="text-[#474B50] text-[16px] font-semibold tracking-tight">Нет сообщений</h3>
                <p className="text-[#8A9099] text-[13px] mt-1 max-w-[280px]">Новое сообщение начнет диалог.</p>
            </div>
        )
    }

    const renderDateSeparator = (item: DateSeparatorUIItem) => (
        <div key={item.key} className="flex justify-center my-4 sticky top-2 z-10 pointer-events-none">
            <div className="bg-[#DFE3E7]/80 backdrop-blur-md px-4 py-1 rounded-full border border-white/40 shadow-sm">
                <span className="text-[11px] font-bold text-[#546574]">{item.label}</span>
            </div>
        </div>
    )

    const renderMessage = (item: MessageUIItem) => {
        const { message: msg, position, showAvatar, showName, showTail, spacingTop, statusPlacement } = item;
        const isOutbound = msg.direction === 'outbound'
        const timeString = new Date(msg.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        const isSearchMatch = activeSearchMessageId === msg.id

        // Adaptive radii logic
        const radius = {
            start: isOutbound ? '18px 18px 4px 18px' : '18px 18px 18px 4px',
            middle: isOutbound ? '18px 4px 4px 18px' : '4px 18px 18px 4px',
            end: isOutbound ? '18px 4px 18px 18px' : '4px 18px 18px 18px',
            single: '18px'
        }

        return (
            <div 
                key={item.key} 
                className={`flex w-full px-4 ${isOutbound ? 'justify-end' : 'justify-start'} group/msg transition-all duration-200 ${isSearchMatch ? 'bg-[#3390EC]/10' : ''}`}
                style={{ marginTop: spacingTop }}
            >
                {/* Avatar Placeholder for Inbound */}
                {!isOutbound && (
                    <div className="w-8 mr-2 flex-shrink-0 flex items-end">
                        {showAvatar && (
                            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-[10px] font-bold border ${
                                msg.channel === 'telegram' || msg.channel === 'tg' ? 'bg-[#3390EC]/10 border-[#3390EC]/20 text-[#3390EC]' :
                                msg.channel === 'whatsapp' || msg.channel === 'wa' ? 'bg-[#25D366]/10 border-[#25D366]/20 text-[#25D366]' :
                                msg.channel === 'max' ? 'bg-[#8E24AA]/10 border-[#8E24AA]/20 text-[#8E24AA]' :
                                'bg-[#3390EC]/10 border-[#3390EC]/20 text-[#3390EC]'
                            }`}>
                                {msg.account?.substring(0, 1).toUpperCase() || (
                                    msg.channel === 'telegram' || msg.channel === 'tg' ? 'T' :
                                    msg.channel === 'whatsapp' || msg.channel === 'wa' ? 'W' :
                                    msg.channel === 'max' ? 'M' :
                                    msg.channel === 'yandex' || msg.channel === 'yp' ? 'Y' : 'U'
                                )}
                            </div>
                        )}
                    </div>
                )}
                
                <div className={`flex flex-col max-w-[70%] ${isOutbound ? 'items-end' : 'items-start'}`}>
                    <div 
                        className={`relative group px-3 pt-1.5 pb-1.5 shadow-sm transition-shadow ${
                            isOutbound ? 'bg-[#D1F7B6]' : 'bg-white'
                        }`}
                        style={{ 
                            borderRadius: radius[position],
                            minWidth: '60px'
                        }}
                    >
                        {/* Name (for Group Start / Single incoming) */}
                        {showName && (
                            <div className="flex items-center gap-1.5 mb-1 px-0.5">
                                <span className="text-[13px] font-bold text-[#3390EC]">
                                    {msg.account || (
                                        msg.channel === 'telegram' || msg.channel === 'tg' ? 'Telegram' :
                                        msg.channel === 'whatsapp' || msg.channel === 'wa' ? 'WhatsApp' :
                                        msg.channel === 'max' ? 'MAX' : 
                                        msg.channel === 'yandex' || msg.channel === 'yp' ? 'Yandex' : 'Сообщение'
                                    )}
                                </span>
                            </div>
                        )}

                        {/* Tail Component */}
                        {showTail && (
                            <div className={`absolute bottom-0 w-3 h-4 ${isOutbound ? '-right-1.5' : '-left-1.5'}`}>
                                <svg viewBox="0 0 12 16" className={`w-full h-full ${isOutbound ? 'text-[#D1F7B6]' : 'text-white'}`} fill="currentColor">
                                    {isOutbound 
                                        ? <path d="M0 16h12V0C10 8 0 14 0 16z" />
                                        : <path d="M12 16H0V0C2 8 12 14 12 16z" />
                                    }
                                </svg>
                            </div>
                        )}
                        
                        <div className="text-[14.5px] leading-[20px] whitespace-pre-wrap text-[#000] relative">
                            {msg.content}
                            {/* Robust Ghost Spacer to reserve space for absolute status in the corner */}
                            <span className="inline-block w-[52px] h-[10px]" />
                        </div>

                        {/* Telegram-style Status Block (Pin to corner) */}
                        <div className={`absolute bottom-[3px] right-[7px] flex items-baseline gap-[3px] select-none leading-none ${
                            statusPlacement === 'overlay' && msg.type !== 'text' ? 'bg-black/20 backdrop-blur-sm rounded-full px-2 py-1 text-white' : ''
                        }`}>
                            <span className={`text-[11px] font-medium tracking-tight ${
                                statusPlacement === 'overlay' && msg.type !== 'text' ? 'text-white' : 
                                (isOutbound ? 'text-[#5EB25E]' : 'text-[#8A9099]')
                            }`}>
                                {timeString}
                            </span>
                            {isOutbound && (
                                <div className="flex items-baseline scale-x-[0.9] -space-x-[11px] translate-y-[2px]">
                                    {msg.status === 'read' ? (
                                        <>
                                            <Check size={16} strokeWidth={2.5} className={statusPlacement === 'overlay' && msg.type !== 'text' ? 'text-white' : 'text-[#48A5E3]'} />
                                            <Check size={16} strokeWidth={2.5} className={statusPlacement === 'overlay' && msg.type !== 'text' ? 'text-white' : 'text-[#48A5E3]'} />
                                        </>
                                    ) : msg.status === 'delivered' ? (
                                        <>
                                            <Check size={16} strokeWidth={2.5} className={statusPlacement === 'overlay' && msg.type !== 'text' ? 'text-white/60' : 'text-[#8ECB8E]'} />
                                            <Check size={16} strokeWidth={2.5} className={statusPlacement === 'overlay' && msg.type !== 'text' ? 'text-white/60' : 'text-[#8ECB8E]'} />
                                        </>
                                    ) : (
                                        <Check size={16} strokeWidth={2.5} className={statusPlacement === 'overlay' && msg.type !== 'text' ? 'text-white/40' : 'text-[#8ECB8E]/60'} />
                                    )}
                                </div>
                            )}
                        </div>
                        
                        {/* Action Buttons (visible on hover) */}
                        <div className={`absolute top-0 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 z-20 ${isOutbound ? 'right-full mr-2' : 'left-full ml-2'}`}>
                           <button onClick={() => onReply && onReply(msg)} className="w-8 h-8 rounded-full bg-white/90 shadow flex items-center justify-center text-gray-500 hover:text-[#3390EC] transition-colors"><Reply size={14} /></button>
                           <button onClick={() => handleCopyMessage(msg.content)} className="w-8 h-8 rounded-full bg-white/90 shadow flex items-center justify-center text-gray-500 hover:text-[#3390EC] transition-colors"><Copy size={13} /></button>
                           <button onClick={() => onCreateTask?.(msg)} className="w-8 h-8 rounded-full bg-white/90 shadow flex items-center justify-center text-gray-500 hover:text-[#3390EC] transition-colors"><ClipboardList size={14} /></button>
                        </div>
                    </div>
                </div>
            </div>
        )
    }

    const renderItem = (index: number, item: UIItem) => {
        const content = item.type === 'date_separator' ? renderDateSeparator(item) : renderMessage(item);
        return (
            <div className="max-w-[720px] mx-auto w-full px-4">
                {content}
            </div>
        )
    }

    return (
        <div className="flex-1 messenger-bg relative flex justify-center">
            <div className="flex-1 relative flex flex-col w-full h-full">
                <Virtuoso
                    ref={virtuoso}
                    className="message-scroller custom-scrollbar w-full h-full"
                    data={uiItems}
                    itemContent={renderItem}
                    initialTopMostItemIndex={Math.max(0, uiItems.length - 1)}
                    atBottomStateChange={handleAtBottomChange}
                    followOutput={(isAtBottom) => {
                        return isAtBottom ? 'auto' : false;
                    }}
                    atBottomThreshold={100}
                    increaseViewportBy={1000}
                />

                {showNewMessagesBadge && (
                    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 animate-in fade-in slide-in-from-bottom-2 duration-300">
                        <button 
                            onClick={scrollToBottom}
                            className="bg-[#111]/90 backdrop-blur-md text-white text-[12px] font-black px-5 py-2 rounded-full shadow-2xl flex items-center gap-2 hover:bg-black transition-all hover:scale-105"
                        >
                            <ArrowDown size={14} strokeWidth={3} /> НОВЫЕ СООБЩЕНИЯ
                        </button>
                    </div>
                )}
            </div>
        </div>
    )
}
