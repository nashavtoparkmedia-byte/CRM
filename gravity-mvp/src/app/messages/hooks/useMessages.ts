import { useState, useEffect, useRef, useMemo } from "react"
import { prepareMessagesForUI, UIItem } from "../utils/message-utils"
import { patchConversation } from "./useConversations"

export interface MessageAttachment {
    id: string
    type: string
    /**
     * Phase 2: API no longer returns url here. UI fetches the binary from
     * /api/attachments/{id} on demand. Kept as optional only for the few
     * legacy callsites that still reference it; new code should derive
     * the URL from id.
     */
    url?: string
    fileName?: string | null
    fileSize?: number | null
    mimeType?: string | null
}

export interface Message {
    id: string
    direction: 'inbound' | 'outbound'
    type: 'text' | 'image' | 'video' | 'voice' | 'audio' | 'document' | 'sticker' | 'system' | 'call'
    content: string
    sentAt: string
    status: 'queued' | 'sent' | 'delivered' | 'read' | 'failed'
    channel: string
    origin?: 'operator' | 'ai' | 'auto' | 'system'
    account?: string
    metadata?: Record<string, any>
    attachments?: MessageAttachment[]
}

const messageCache = new Map<string, Message[]>()

// In-flight prefetch promises so two callers don't fire two requests
// for the same chat on a fast hover. Cleared when the request settles.
const prefetchInFlight = new Map<string, Promise<void>>()

/**
 * Prefetch messages for a chat into the shared messageCache. Called by
 * ChatList on hover (Phase 3). Returns a promise but most callers ignore
 * it — fire-and-forget. Safe to call repeatedly: dedupes via in-flight map.
 */
export function prefetchMessages(chatId: string): Promise<void> {
    if (!chatId || chatId.startsWith('empty:')) return Promise.resolve()
    if (messageCache.has(chatId)) return Promise.resolve() // already warm
    const existing = prefetchInFlight.get(chatId)
    if (existing) return existing

    const p = fetch(`/api/messages?chatId=${chatId}`)
        .then(r => r.json())
        .then((data: any) => {
            if (Array.isArray(data)) {
                const enriched = data.map((m: any) => ({ ...m, channel: m.channel || 'whatsapp' }))
                messageCache.set(chatId, enriched)
            }
        })
        .catch(() => { /* fire-and-forget */ })
        .finally(() => { prefetchInFlight.delete(chatId) })

    prefetchInFlight.set(chatId, p)
    return p
}

/**
 * Seed an empty message list for a chat. Call this right after creating
 * a new chat via start-conversation — the user will switch to this id
 * and useMessages will see a "warm" cache (empty array), so no spinner
 * appears while the real fetch confirms it's still empty.
 */
export function seedEmptyChat(chatId: string): void {
    if (!chatId || chatId.startsWith('empty:')) return
    if (!messageCache.has(chatId)) messageCache.set(chatId, [])
}

export function useMessages(chatId: string | null) {
    // Sync cache: при remount (key change) сразу инициализируем из кэша.
    // Без этого первый рендер = messages=[] → пустой DOM → anchor restore невозможен.
    const [messages, setMessages] = useState<Message[]>(() => {
        if (!chatId || chatId.startsWith('empty:')) return []
        return messageCache.get(chatId) || []
    })
    const [isLoading, setIsLoading] = useState(false)
    const [hasMoreHistory, setHasMoreHistory] = useState(true)

    const lastFetchTime = useRef(0)

    // Prepare UI items (grouping, separators, etc.)
    const uiItems = useMemo(() => prepareMessagesForUI(messages), [messages]);

    useEffect(() => {
        if (!chatId || chatId.startsWith('empty:')) {
            setMessages([])
            return
        }

        const cached = messageCache.get(chatId)
        if (cached) {
            setMessages(cached)
        }

        let isMounted = true

        // Phase 1: stale-while-revalidate.
        // - On chat open, if we have anything in messageCache, the chat
        //   renders INSTANTLY from it (already done above + initial state).
        // - The fetch below runs WITHOUT setIsLoading(true) on first load
        //   when cache exists, so the UI never flashes a spinner over
        //   already-shown content.
        // - We dropped the `_t=${now}` cache buster so the browser HTTP
        //   cache + any future ETag/Last-Modified can de-duplicate
        //   identical responses.
        const loadMessages = async (opts: { silent?: boolean } = {}) => {
            // Avoid overlapping requests
            const now = Date.now()
            if (now - lastFetchTime.current < 2000) return
            lastFetchTime.current = now

            // Defer the spinner: only show it if the fetch takes >300ms.
            // For most opens the API responds in 20-50ms, well below the
            // threshold, so the user sees a brief blank pane and then
            // messages — never a flash of "Загрузка сообщений..." that
            // appears just to disappear a tick later.
            const shouldShowSpinner = !opts.silent && !messageCache.get(chatId)
            let spinnerTimer: ReturnType<typeof setTimeout> | null = null
            if (shouldShowSpinner) {
                spinnerTimer = setTimeout(() => {
                    if (isMounted) setIsLoading(true)
                }, 300)
            }

            try {
                const res = await fetch(`/api/messages?chatId=${chatId}`)
                const data = await res.json()

                if (isMounted && Array.isArray(data)) {
                    // Enrich messages with channel fallback
                    const enrichedData = data.map((m: any) => ({
                        ...m,
                        channel: m.channel || 'whatsapp'
                    }))

                    // MERGE: Keep optimistic messages that server doesn't know about yet
                    // Optimistic IDs start with 'cmid-' (clientMessageId)
                    const existingOptimistic = (messageCache.get(chatId) || [])
                        .filter(m => m.id.startsWith('cmid-'))

                    const pendingOptimistic = existingOptimistic.filter(opt => {
                        // Remove optimistic if server returned a message with matching content+time
                        return !enrichedData.some((srv: Message) =>
                            srv.direction === 'outbound' &&
                            srv.content === opt.content &&
                            Math.abs(new Date(srv.sentAt).getTime() - new Date(opt.sentAt).getTime()) < 60000
                        )
                    })

                    const merged = [...enrichedData, ...pendingOptimistic]
                    messageCache.set(chatId, merged)
                    setMessages(merged)
                    setHasMoreHistory(enrichedData.length >= 50)
                }
            } catch (error) {
                console.error("Failed to load messages", error)
            } finally {
                if (spinnerTimer) clearTimeout(spinnerTimer)
                if (isMounted && shouldShowSpinner) setIsLoading(false)
            }
        }

        // First load: silent=true if we already have cache (instant render),
        // otherwise spinner while we fetch the very first batch.
        loadMessages({ silent: !!cached })

        // Phase 4 SSE: subscribe to live message push for this chat.
        // EventSource auto-reconnects on network blip, no manual retry.
        let eventSource: EventSource | null = null
        try {
            eventSource = new EventSource(`/api/messages/stream/${chatId}`)
            eventSource.onmessage = (e) => {
                if (!isMounted) return
                let payload: any
                try { payload = JSON.parse(e.data) } catch { return }
                if (!payload || payload.type !== 'message' || !payload.data) return
                const incoming = payload.data
                // Append (or REPLACE existing entry without forcing a refetch).
                // Replace happens on three keys to avoid the optimistic /
                // server "mirror" effect:
                //   1. id match              — second SSE push for same row
                //   2. clientMessageId       — optimistic UI message has
                //                              id="cmid-<clientMessageId>" or
                //                              an internal cuid; server's
                //                              broadcast carries the real
                //                              clientMessageId field. Either
                //                              flavor of optimistic row gets
                //                              swapped for the canonical one.
                //   3. content + direction + ±10s sentAt window — last-resort
                //      match for outbound that went through MessageService
                //      without a clientMessageId (legacy paths).
                setMessages(prev => {
                    const cmid = (incoming as any).clientMessageId as string | undefined
                    let existing = prev.findIndex(m => m.id === incoming.id)
                    if (existing < 0 && cmid) {
                        existing = prev.findIndex(m =>
                            (m as any).clientMessageId === cmid ||
                            m.id === `cmid-${cmid}` ||
                            m.id === cmid
                        )
                    }
                    if (existing < 0 && incoming.direction === 'outbound') {
                        const incTs = new Date(incoming.sentAt).getTime()
                        existing = prev.findIndex(m =>
                            m.direction === 'outbound' &&
                            m.id.startsWith('cmid-') &&
                            m.content === incoming.content &&
                            Math.abs(new Date(m.sentAt).getTime() - incTs) < 10_000
                        )
                    }
                    let next: Message[]
                    if (existing >= 0) {
                        next = [...prev]
                        next[existing] = { ...next[existing], ...incoming, channel: incoming.channel || 'whatsapp' }
                    } else {
                        next = [...prev, { ...incoming, channel: incoming.channel || 'whatsapp' }]
                        // Keep the list sorted by sentAt
                        next.sort((a, b) => new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime())
                    }
                    messageCache.set(chatId, next)
                    return next
                })
            }
            eventSource.onerror = () => {
                // Auto-reconnect by EventSource. The 30s polling below covers
                // any messages that landed during the outage.
            }
        } catch (err) {
            console.warn('[useMessages] SSE init failed, polling-only:', err)
        }

        // Polling stays as a slow fallback (was 3s, now 30s) — covers
        // anything SSE missed during reconnects, or environments where
        // SSE is blocked by a corporate proxy.
        const interval = setInterval(() => loadMessages({ silent: true }), 30000)
        return () => {
            isMounted = false
            clearInterval(interval)
            if (eventSource) eventSource.close()
        }
    }, [chatId])

    const loadMoreHistory = async () => {
        if (!chatId || !hasMoreHistory || isLoading) return
        
        // Placeholder for upward pagination
        // In real impl: fetch(`/api/messages?chatId=${chatId}&before=${messages[0].id}`)
        console.log("Loading more history upwards...")
        setHasMoreHistory(false) 
    }

    const sendMessage = async (content: string, channel: string) => {
        if (!chatId) return

        // Normalize channel for API (wa→whatsapp, tg→telegram, ypro→yandex_pro)
        const normalizeForApi = (ch: string) => ch === 'wa' ? 'whatsapp' : ch === 'tg' ? 'telegram' : ch === 'ypro' ? 'yandex_pro' : ch
        const apiChannel = normalizeForApi(channel)

        // Generate stable idempotency key for duplicate prevention
        const clientMessageId = `cmid-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`

        // Optimistic UI update (<50ms local echo contract)
        const optimisticMsg: Message = {
            id: clientMessageId,  // Use clientMessageId as optimistic ID
            direction: 'outbound',
            type: 'text',
            content,
            sentAt: new Date().toISOString(),
            status: 'sent', // Single ✓ — sending
            channel: apiChannel,
            origin: 'operator'
        }

        const currentMsgs = messageCache.get(chatId) || []
        const newMsgs = [...currentMsgs, optimisticMsg]
        messageCache.set(chatId, newMsgs)
        setMessages(newMsgs)

        // Optimistic Sorting: move chat to top instantly
        patchConversation(chatId, {
            lastMessageAt: optimisticMsg.sentAt,
            messages: [{ content: optimisticMsg.content }]
        })

        // If chatId is a comma-separated list (unified view), use the first one for sending
        const primaryChatId = chatId.split(',')[0]

        // Actual API call — includes clientMessageId for idempotency
        try {
            const res = await fetch('/api/messages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chatId: primaryChatId, content, channel: apiChannel, clientMessageId })
            })
            
            if (res.ok) {
                const result = await res.json()
                // Update optimistic message with server ID and final status
                const finalStatus = result.success === false ? 'failed' as const : 'delivered' as const
                const updatedMsgs = (messageCache.get(chatId) || []).map(m =>
                    m.id === clientMessageId
                        ? { ...m, id: result.id || m.id, status: finalStatus, ...(result.error ? { metadata: { error: result.error } } : {}) }
                        : m
                )
                messageCache.set(chatId, updatedMsgs)
                setMessages(updatedMsgs)
            } else {
                const err = await res.json().catch(() => ({ error: 'Unknown error' }))
                console.error('[SEND] API Error:', err)
                const errorText = err.error || err.message || 'Ошибка отправки'
                const failedMsgs = (messageCache.get(chatId) || []).map(m =>
                    m.id === clientMessageId
                        ? { ...m, status: 'failed' as const, metadata: { error: errorText } }
                        : m
                )
                messageCache.set(chatId, failedMsgs)
                setMessages(failedMsgs)
            }
        } catch (err) {
            console.error('[SEND] Network Error:', err)
            const errorText = err instanceof Error ? err.message : 'Ошибка сети'
            const failedMsgs = (messageCache.get(chatId) || []).map(m =>
                m.id === clientMessageId
                    ? { ...m, status: 'failed' as const, metadata: { error: errorText } }
                    : m
            )
            messageCache.set(chatId, failedMsgs)
            setMessages(failedMsgs)
        }
    }

    return { messages, uiItems, isLoading, loadMoreHistory, hasMoreHistory, sendMessage }
}
