import { useState, useEffect, useRef, useMemo } from "react"
import { prepareMessagesForUI, UIItem } from "../utils/message-utils"
import { patchConversation } from "./useConversations"

export interface MessageAttachment {
    id: string
    type: string
    url: string
    fileName?: string | null
    fileSize?: number | null
    mimeType?: string | null
}

export interface Message {
    id: string
    direction: 'inbound' | 'outbound'
    type: 'text' | 'image' | 'video' | 'voice' | 'audio' | 'document' | 'system'
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

        const loadMessages = async () => {
            // Avoid overlapping requests
            const now = Date.now()
            if (now - lastFetchTime.current < 2000) return
            lastFetchTime.current = now

            setIsLoading(true)
            
            try {
                // Fetch fresh messages with cache busting
                const res = await fetch(`/api/messages?chatId=${chatId}&_t=${now}`)
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
                if (isMounted) setIsLoading(false)
            }
        }

        loadMessages()
        
        const interval = setInterval(loadMessages, 3000) // Poll every 3s
        return () => {
            isMounted = false
            clearInterval(interval)
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
