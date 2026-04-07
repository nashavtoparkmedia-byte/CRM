"use client"

import { useState, useRef, useEffect, useLayoutEffect, useCallback } from "react"
import { Message } from "../hooks/useMessages"
import { UIItem, MessageUIItem, DateSeparatorUIItem } from "../utils/message-utils"
import { ArrowDown, Reply, MessageSquare, Copy, ClipboardList, Check, AlertCircle, RotateCcw } from "lucide-react"

// ── Anchor-based scroll memory (module-level, survives remounts) ──
// Primary: anchor msgId + offset from viewport top
// Fallback: raw scrollTop (pixel-based, less stable)
interface ScrollAnchor {
    msgId: string          // data-msg-id of first visible message
    offsetFromTop: number  // px from scroller top to that message's top
    scrollTop: number      // fallback pixel position
    wasAtBottom: boolean
}
const scrollAnchorMemory = new Map<string, ScrollAnchor>()

export default function MessageFeed({
    chatId,
    channelTab,
    uiItems,
    isLoading,
    hasMoreHistory,
    onLoadMore,
    onReply,
    onRetry,
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
    onRetry?: (msg: Message) => void
    onCreateTask?: (msg: Message) => void
    activeSearchMessageId?: string | null
    onFocusComposer?: () => void
    lastSentAt?: number
}) {
    // Ссылка на scrollable div (заменяет VirtuosoHandle)
    const scrollerRef = useRef<HTMLDivElement>(null)
    const [atBottom, setAtBottom] = useState(true)
    const [showNewMessagesBadge, setShowNewMessagesBadge] = useState(false)
    const seenMessageIds = useRef<Set<string>>(new Set())
    const prevItemCount = useRef(uiItems.length)
    const isInitialLoad = useRef(true)

    // Всегда актуальная ссылка на uiItems (без добавления в deps useEffect)
    const uiItemsRef = useRef(uiItems)
    uiItemsRef.current = uiItems

    // Единый источник истины для текущей позиции скролла
    const currentScrollTopRef = useRef(0)

    // ── Anchor measurement: find first visible message in viewport ──
    const measureAnchor = useCallback((el: HTMLDivElement): { msgId: string; offsetFromTop: number } | null => {
        const scrollerRect = el.getBoundingClientRect()
        const msgElements = el.querySelectorAll<HTMLElement>('[data-msg-id]')
        // Find first message whose top is at or below scroller top
        for (const msgEl of msgElements) {
            const rect = msgEl.getBoundingClientRect()
            if (rect.top >= scrollerRect.top - 1) {
                return {
                    msgId: msgEl.getAttribute('data-msg-id')!,
                    offsetFromTop: rect.top - scrollerRect.top,
                }
            }
        }
        // Fallback: first message partially visible (top above viewport, bottom inside)
        for (const msgEl of msgElements) {
            const rect = msgEl.getBoundingClientRect()
            if (rect.bottom > scrollerRect.top) {
                return {
                    msgId: msgEl.getAttribute('data-msg-id')!,
                    offsetFromTop: rect.top - scrollerRect.top,
                }
            }
        }
        return null
    }, [])

    // ── Save anchor: called from scroll handler and cleanup ──
    const saveAnchor = useCallback((el: HTMLDivElement) => {
        const anchor = measureAnchor(el)
        const sh = el.scrollHeight, ch = el.clientHeight, st = el.scrollTop
        scrollAnchorMemory.set(chatId, {
            msgId: anchor?.msgId ?? '',
            offsetFromTop: anchor?.offsetFromTop ?? 0,
            scrollTop: st,
            wasAtBottom: sh - ch - st <= 120,
        })
    }, [chatId, measureAnchor])

    // Стабильные ссылки на пропсы для использования внутри scroll-хэндлера
    const hasMoreHistoryRef = useRef(hasMoreHistory)
    hasMoreHistoryRef.current = hasMoreHistory
    const isLoadingRef = useRef(isLoading)
    isLoadingRef.current = isLoading
    const onLoadMoreRef = useRef(onLoadMore)
    onLoadMoreRef.current = onLoadMore

    // ──────────────────────────────────────────────────────────
    // Утилиты скролла
    // ──────────────────────────────────────────────────────────

    // Снап вниз: устанавливаем scrollTop в максимум.
    // rAF-loop на 3 сек. — scrollHeight может расти по мере загрузки изображений.
    const runSnapToBottom = (el: HTMLDivElement) => {
        const deadline = Date.now() + 3000
        const snap = () => {
            el.scrollTop = el.scrollHeight
            if (Date.now() < deadline) requestAnimationFrame(snap)
        }
        requestAnimationFrame(snap)
    }

    // ──────────────────────────────────────────────────────────
    // Layout Effect A: mount lifecycle (runs once per remount).
    // With key={effectiveChatId} on ChatWorkspaceInner, this fires
    // once on mount and cleanup fires on unmount. No stale data.
    // ──────────────────────────────────────────────────────────
    useLayoutEffect(() => {
        const saved = scrollAnchorMemory.get(chatId)
        const isFirstVisit = !saved

        if (isFirstVisit) {
            isInitialLoad.current = true
            setAtBottom(true)
        } else {
            isInitialLoad.current = false

            // Mark all current items as seen (sync cache provides them at mount)
            uiItemsRef.current.forEach(item => {
                if (item.type === 'message') seenMessageIds.current.add((item as any).message.id)
            })

            const el = scrollerRef.current
            if (el && saved && el.scrollHeight > el.clientHeight) {
                if (saved.wasAtBottom) {
                    el.scrollTop = el.scrollHeight
                    currentScrollTopRef.current = el.scrollTop
                    setAtBottom(true)
                } else {
                    // Anchor-based restore (primary)
                    let restored = false
                    if (saved.msgId) {
                        const anchorEl = el.querySelector(`[data-msg-id="${saved.msgId}"]`) as HTMLElement
                        if (anchorEl) {
                            el.scrollTop = Math.max(0, anchorEl.offsetTop - saved.offsetFromTop)
                            currentScrollTopRef.current = el.scrollTop
                            restored = true
                        }
                    }
                    // Pixel fallback
                    if (!restored) {
                        el.scrollTop = saved.scrollTop
                        currentScrollTopRef.current = el.scrollTop
                    }
                    setAtBottom(false)
                }
            }
        }

        const el = scrollerRef.current
        const onScroll = () => {
            if (scrollerRef.current) {
                currentScrollTopRef.current = scrollerRef.current.scrollTop
                saveAnchor(scrollerRef.current)
            }
        }
        el?.addEventListener('scroll', onScroll, { passive: true })

        return () => {
            // Save anchor on unmount — skip if DOM is empty (Strict Mode safety)
            if (scrollerRef.current && scrollerRef.current.scrollHeight > scrollerRef.current.clientHeight) {
                saveAnchor(scrollerRef.current)
            }
            el?.removeEventListener('scroll', onScroll)
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [chatId])

    // ──────────────────────────────────────────────────────────
    // Layout Effect B: Initial snap — когда items впервые
    // появляются в DOM для первого визита.
    // Срабатывает синхронно до paint → пользователь не видит top=0.
    // ──────────────────────────────────────────────────────────
    useLayoutEffect(() => {
        if (!isInitialLoad.current || uiItems.length === 0) return
        const el = scrollerRef.current
        if (!el || el.scrollHeight <= el.clientHeight) return

        isInitialLoad.current = false
        uiItems.forEach(item => {
            if (item.type === 'message') seenMessageIds.current.add((item as any).message.id)
        })
        el.scrollTop = el.scrollHeight
        currentScrollTopRef.current = el.scrollTop
    }, [uiItems.length])

    // ──────────────────────────────────────────────────────────
    // Эффект 3: Initial snap + Реакция на новые сообщения
    //
    // Срабатывает когда uiItems или atBottom меняются.
    // Первый визит: когда items придут (isInitialLoad=true) — snap to bottom.
    // Повторный визит: seenMessageIds уже заполнен — не трактуем как "новые".
    // ──────────────────────────────────────────────────────────

    // Render-phase: badge suppression + counter для исходящих
    if (uiItems.length > prevItemCount.current) {
        const lastItem = uiItems[uiItems.length - 1]
        if (lastItem.type === 'message' && lastItem.message.direction === 'outbound') {
            setShowNewMessagesBadge(false)
        }
        prevItemCount.current = uiItems.length
    }

    useEffect(() => {
        if (uiItems.length === 0) return

        const el = scrollerRef.current

        if (isInitialLoad.current) {
            uiItems.forEach(item => {
                if (item.type === 'message') seenMessageIds.current.add(item.message.id)
            })
            if (el) {
                isInitialLoad.current = false
                runSnapToBottom(el)
            }
            return
        }

        const lastItem = uiItems[uiItems.length - 1]
        if (lastItem.type === 'message') {
            const msgId = lastItem.message.id
            const isNew = !seenMessageIds.current.has(msgId)

            if (isNew) {
                seenMessageIds.current.add(msgId)
                const isOwn = lastItem.message.direction === 'outbound'
                const el = scrollerRef.current

                if (isOwn) {
                    if (el) {
                        el.scrollTop = el.scrollHeight
                        requestAnimationFrame(() => { if (el) el.scrollTop = el.scrollHeight })
                        requestAnimationFrame(() => { requestAnimationFrame(() => { if (el) el.scrollTop = el.scrollHeight }) })
                    }
                } else {
                    if (atBottom && el) {
                        el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
                        setShowNewMessagesBadge(false)
                    } else {
                        setShowNewMessagesBadge(true)
                    }
                }
            }
        }
    }, [uiItems, atBottom])

    // ──────────────────────────────────────────────────────────
    // Эффект 4: Прокрутка к результату поиска
    // ──────────────────────────────────────────────────────────
    useEffect(() => {
        if (!activeSearchMessageId) return
        const el = scrollerRef.current
        if (!el) return
        const target = el.querySelector(`[data-msg-id="${activeSearchMessageId}"]`) as HTMLElement
        if (target) {
            const offset = target.offsetTop - el.clientHeight / 2 + target.offsetHeight / 2
            el.scrollTo({ top: Math.max(0, offset), behavior: 'smooth' })
        }
    }, [activeSearchMessageId])

    // ──────────────────────────────────────────────────────────
    // onScroll: atBottom + история + позиция
    // ──────────────────────────────────────────────────────────
    const handleScroll = useCallback(() => {
        const el = scrollerRef.current
        if (!el) return

        currentScrollTopRef.current = el.scrollTop

        const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120
        setAtBottom(prev => {
            if (prev !== isAtBottom) return isAtBottom
            return prev
        })
        if (isAtBottom) setShowNewMessagesBadge(false)

        // Загрузка истории при прокрутке вверх
        if (el.scrollTop < 150 && hasMoreHistoryRef.current && !isLoadingRef.current) {
            onLoadMoreRef.current()
        }
    }, [])

    // ──────────────────────────────────────────────────────────
    // scrollToBottom
    // ──────────────────────────────────────────────────────────
    const scrollToBottom = () => {
        const el = scrollerRef.current
        if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
        setShowNewMessagesBadge(false)
    }

    // ──────────────────────────────────────────────────────────
    // Рендер элементов
    // ──────────────────────────────────────────────────────────

    const renderDateSeparator = (item: DateSeparatorUIItem) => (
        <div className="flex justify-center my-4 sticky top-2 z-10 pointer-events-none">
            <div className="bg-[#DFE3E7]/80 backdrop-blur-md px-4 py-1 rounded-full border border-white/40 shadow-sm">
                <span className="text-[11px] font-bold text-[#546574]">{item.label}</span>
            </div>
        </div>
    )

    const renderMessage = (item: MessageUIItem) => {
        const { message: msg, position, showAvatar, showName, showTail, spacingTop, statusPlacement } = item
        const isOutbound = msg.direction === 'outbound'
        const timeString = new Date(msg.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        const isSearchMatch = activeSearchMessageId === msg.id

        const radius = {
            start: isOutbound ? '18px 18px 4px 18px' : '18px 18px 18px 4px',
            middle: isOutbound ? '18px 4px 4px 18px' : '4px 18px 18px 4px',
            end: isOutbound ? '18px 4px 18px 18px' : '4px 18px 18px 18px',
            single: '18px'
        }

        return (
            <div
                className={`flex w-full px-4 ${isOutbound ? 'justify-end' : 'justify-start'} group/msg transition-all duration-200 ${isSearchMatch ? 'bg-[#3390EC]/10' : ''}`}
                style={{ marginTop: spacingTop }}
                data-msg-id={msg.id}
            >
                {/* Avatar для входящих */}
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

                        {/* Изображения */}
                        {msg.type === 'image' && msg.attachments && msg.attachments.length > 0 && (
                            <div className="mb-1">
                                {msg.attachments.filter(a => a.url).map(att => (
                                    <a key={att.id} href={att.url} target="_blank" rel="noopener noreferrer">
                                        <img
                                            src={att.url}
                                            alt="фото"
                                            className="max-w-[280px] max-h-[320px] rounded-lg object-cover cursor-pointer hover:opacity-90 transition-opacity"
                                            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                                        />
                                    </a>
                                ))}
                            </div>
                        )}

                        {/* Аудио / Голосовые */}
                        {(msg.type === 'voice' || msg.type === 'audio') && msg.attachments && msg.attachments.length > 0 && (
                            <div className="mb-1">
                                {msg.attachments.filter(a => a.url).map(att => (
                                    <audio key={att.id} controls className="max-w-[260px] h-10" style={{ minWidth: 200 }}>
                                        <source src={att.url} />
                                    </audio>
                                ))}
                            </div>
                        )}

                        <div className="text-[14.5px] leading-[20px] whitespace-pre-wrap text-[#000] relative">
                            {msg.type !== 'image' && msg.content}
                            <span className={`inline-block h-[10px] ${msg.status === 'failed' && isOutbound ? 'w-[105px]' : 'w-[52px]'}`} />
                        </div>

                        {/* Статус (время + галочки) */}
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
                                msg.status === 'failed' ? (
                                    <div className="flex items-center gap-1 translate-y-[1px]">
                                        <div className="group/fail relative">
                                            <AlertCircle size={14} strokeWidth={2.5} className="text-red-500" />
                                            {msg.metadata?.error && (
                                                <div className="absolute bottom-full right-0 mb-1.5 hidden group-hover/fail:block z-50 pointer-events-none">
                                                    <div className="bg-[#333] text-white text-[10px] leading-tight rounded-lg px-2.5 py-1.5 max-w-[220px] whitespace-pre-wrap shadow-lg">
                                                        {msg.metadata.error.length > 120 ? msg.metadata.error.substring(0, 120) + '…' : msg.metadata.error}
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                        {onRetry && (
                                            <button
                                                onClick={() => onRetry(msg)}
                                                className="text-[10px] text-red-500 hover:text-red-700 font-medium transition-colors leading-none"
                                            >
                                                Повторить
                                            </button>
                                        )}
                                    </div>
                                ) : (
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
                                )
                            )}
                        </div>

                        {/* Кнопки действий (hover) */}
                        <div className={`absolute top-0 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 z-20 ${isOutbound ? 'right-full mr-2' : 'left-full ml-2'}`}>
                           <button onClick={() => onReply && onReply(msg)} className="w-8 h-8 rounded-full bg-white/90 shadow flex items-center justify-center text-gray-500 hover:text-[#3390EC] transition-colors"><Reply size={14} /></button>
                           <button onClick={() => navigator.clipboard.writeText(msg.content)} className="w-8 h-8 rounded-full bg-white/90 shadow flex items-center justify-center text-gray-500 hover:text-[#3390EC] transition-colors"><Copy size={13} /></button>
                           <button onClick={() => onCreateTask?.(msg)} className="w-8 h-8 rounded-full bg-white/90 shadow flex items-center justify-center text-gray-500 hover:text-[#3390EC] transition-colors"><ClipboardList size={14} /></button>
                        </div>
                    </div>
                </div>
            </div>
        )
    }

    // ──────────────────────────────────────────────────────────
    // Render
    // ──────────────────────────────────────────────────────────
    return (
        <div className="flex-1 messenger-bg relative flex justify-center">
            {/* Относительный контейнер — якорь для absolute-позиционированных детей.
                flex-1 + min-h-0 предотвращают бесконечный рост в flex-col родителе. */}
            <div className="flex-1 min-h-0 relative w-full">

                {/* Overlay: загрузка */}
                {isLoading && uiItems.length === 0 && (
                    <div className="absolute inset-0 flex items-center justify-center messenger-bg text-[#8A9099] text-[13px] font-medium z-10">
                        Загрузка сообщений...
                    </div>
                )}

                {/* Overlay: нет сообщений */}
                {!isLoading && uiItems.length === 0 && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center messenger-bg px-6 text-center z-10">
                        <div className="w-14 h-14 rounded-full bg-white/60 flex items-center justify-center mb-4 text-[#B0B5BA]">
                            <MessageSquare size={22} />
                        </div>
                        <h3 className="text-[#474B50] text-[16px] font-semibold tracking-tight">Нет сообщений</h3>
                        <p className="text-[#8A9099] text-[13px] mt-1 max-w-[280px]">Новое сообщение начнет диалог.</p>
                    </div>
                )}

                {/* Основной скроллер — absolute inset-0, чтобы точно занять
                    всю высоту родителя независимо от flex-вычислений. */}
                <div
                    ref={scrollerRef}
                    className="message-scroller custom-scrollbar absolute inset-0 overflow-y-auto"
                    onScroll={handleScroll}
                >
                    <div className="flex flex-col py-2">
                        {uiItems.map((item) => (
                            <div key={item.key} className="max-w-[720px] mx-auto w-full">
                                {item.type === 'date_separator'
                                    ? renderDateSeparator(item)
                                    : renderMessage(item)
                                }
                            </div>
                        ))}
                    </div>
                </div>

                {/* Бейдж новых сообщений */}
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
