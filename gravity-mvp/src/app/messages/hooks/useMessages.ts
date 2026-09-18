import { useState, useEffect, useRef, useMemo } from "react"
import { prepareMessagesForUI, UIItem } from "../utils/message-utils"
import { patchConversation } from "./useConversations"
import {
    applySendAnswer,
    applySendFailure,
    findSendRow,
    isLocalSendFailure,
    mergeCanonicalRow,
    mergeHistorySnapshot,
    updateSendRow,
    type SendAnswer,
} from "./outbound-send-state"

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
    /** 'sending' is local only: this device's request for the row is in flight. */
    status: 'sending' | 'queued' | 'sent' | 'delivered' | 'read' | 'failed'
    channel: string
    origin?: 'operator' | 'ai' | 'auto' | 'system'
    account?: string
    externalId?: string
    clientMessageId?: string
    metadata?: Record<string, any>
    attachments?: MessageAttachment[]
}

// Holds only histories that were loaded successfully (or seeded as known-empty
// right after a chat was created). useMessages trusts an entry here as usable
// history, so a failed request must never write to it.
const messageCache = new Map<string, Message[]>()

// In-flight prefetch promises so two callers don't fire two requests
// for the same chat on a fast hover. Cleared when the request settles.
const prefetchInFlight = new Map<string, Promise<void>>()

// Every mounted view of a chat, keyed by that chat. A send, a retry or an SSE
// push changes the chat it belongs to, captured when it started — never the
// chat on screen when it finishes. Going through here updates that chat's
// cache and whichever view of it is mounted now (including one remounted
// after a switch away and back), and nothing else.
const chatListeners = new Map<string, Set<(messages: Message[]) => void>>()

function commitChatMessages(chatId: string, update: (current: Message[]) => Message[]): Message[] {
    const next = update(messageCache.get(chatId) || [])
    messageCache.set(chatId, next)
    chatListeners.get(chatId)?.forEach(listener => listener(next))
    return next
}

// One logical send is one clientMessageId. While a request for it is in
// flight a second request for it is never started; a persisted retry is
// likewise single-flight per message id.
const sendsInFlight = new Set<string>()
const retriesInFlight = new Set<string>()

interface SendIntent {
    clientMessageId: string
    content: string
    channel: string
    quotedMsgId?: string
}

/**
 * POST one send intent for the chat it was started in. Repeating an intent
 * (after a lost answer) repeats its clientMessageId, so the server answers with
 * the row it already has instead of dispatching again.
 */
async function postSendIntent(chatKey: string, intent: SendIntent): Promise<void> {
    if (sendsInFlight.has(intent.clientMessageId)) return
    sendsInFlight.add(intent.clientMessageId)
    const key = { clientMessageId: intent.clientMessageId }
    const fail = (errorText: string) => commitChatMessages(chatKey, list =>
        updateSendRow(list, key, row => applySendFailure(row, errorText)))

    // If chatKey is a comma-separated list (unified view), use the first one for sending
    const primaryChatId = chatKey.split(',')[0]
    try {
        const res = await fetch('/api/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chatId: primaryChatId,
                content: intent.content,
                channel: intent.channel,
                clientMessageId: intent.clientMessageId,
                quotedMsgId: intent.quotedMsgId,
            }),
        })
        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: 'Unknown error' }))
            console.error('[SEND] API Error:', err)
            fail(err?.error || err?.message || 'Ошибка отправки')
            return
        }
        const answer: SendAnswer | null = await res.json().catch(() => null)
        if (!answer || typeof answer !== 'object') {
            fail('Некорректный ответ сервера')
            return
        }
        commitChatMessages(chatKey, list => updateSendRow(list, key, row => applySendAnswer(row, answer)))
    } catch (err) {
        console.error('[SEND] Network Error:', err)
        fail('Нет связи с сервером')
    } finally {
        sendsInFlight.delete(intent.clientMessageId)
    }
}

/** The persisted-message retry the composition root supplies (a Messaging server action). */
export type RetryPersistedDelivery = (messageId: string) => Promise<{
    ok: boolean
    error: string | null
    message: {
        id: string
        status: string
        externalId: string | null
        error: string | null
        retryable: boolean
        deliveryOutcome: string | null
    } | null
}>

export type MessageHistoryResult =
    | { ok: true; messages: Message[] }
    | { ok: false; reason: 'network' | 'http' | 'malformed'; status?: number }

/**
 * One read of a chat's history, classified. An empty conversation and a
 * failed load must never look alike: the old code read any non-array body as
 * "no messages", so an HTTP 500 rendered as «Нет сообщений».
 *
 *   network rejection      -> failure
 *   non-2xx status         -> failure (its body is not interpreted as a list)
 *   2xx with a non-array   -> failure
 *   2xx with an array      -> success, and [] is a genuine empty conversation
 */
export async function fetchMessageHistory(chatId: string): Promise<MessageHistoryResult> {
    let res: Response
    try {
        res = await fetch(`/api/messages?chatId=${chatId}`)
    } catch {
        return { ok: false, reason: 'network' }
    }
    if (!res.ok) return { ok: false, reason: 'http', status: res.status }

    let data: unknown
    try {
        data = await res.json()
    } catch {
        return { ok: false, reason: 'malformed', status: res.status }
    }
    if (!Array.isArray(data)) return { ok: false, reason: 'malformed', status: res.status }

    return {
        ok: true,
        messages: data.map((m: any) => ({ ...m, channel: m.channel || 'whatsapp' })),
    }
}

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

    const p = fetchMessageHistory(chatId)
        .then((result) => {
            // Only a successful read may warm the cache; a warm cache is
            // rendered as real history, including as a real empty state.
            if (result.ok) messageCache.set(chatId, result.messages)
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

export function useMessages(
    chatId: string | null,
    options: { retryPersistedDelivery?: RetryPersistedDelivery } = {},
) {
    // Sync cache: при remount (key change) сразу инициализируем из кэша.
    // Без этого первый рендер = messages=[] → пустой DOM → anchor restore невозможен.
    const [messages, setMessages] = useState<Message[]>(() => {
        if (!chatId || chatId.startsWith('empty:')) return []
        return messageCache.get(chatId) || []
    })
    const [isLoading, setIsLoading] = useState(false)
    const [hasMoreHistory, setHasMoreHistory] = useState(true)
    // True once this chat has usable history: a successful read, or a cache
    // entry (which only a successful read or a known-empty seed can create).
    // «Нет сообщений» may only be shown when this is true.
    const [hasLoadedHistory, setHasLoadedHistory] = useState<boolean>(() => {
        if (!chatId || chatId.startsWith('empty:')) return true
        return messageCache.has(chatId)
    })
    // The first read failed and there is nothing usable to show.
    const [historyLoadFailed, setHistoryLoadFailed] = useState(false)
    const [isRetryingHistory, setIsRetryingHistory] = useState(false)
    const retryInFlight = useRef(false)

    const lastFetchTime = useRef(0)
    const loadInFlight = useRef(false)
    const loadMessagesRef = useRef<(opts?: { silent?: boolean; force?: boolean }) => Promise<void>>(
        async () => {},
    )

    // Prepare UI items (grouping, separators, etc.)
    const uiItems = useMemo(() => prepareMessagesForUI(messages), [messages]);

    useEffect(() => {
        if (!chatId || chatId.startsWith('empty:')) {
            setMessages([])
            setHasLoadedHistory(true)
            setHistoryLoadFailed(false)
            return
        }

        // Everything below describes THIS chat only. ChatWorkspace remounts the
        // hook per chat, so in that path these are no-ops; they keep the hook
        // from ever presenting another conversation's history as this one's.
        const cached = messageCache.get(chatId)
        // Keep the same array when nothing changes, so uiItems and the feed's
        // scroll effects are not re-run on mount.
        setMessages(prev => cached ?? (prev.length === 0 ? prev : []))
        setHasLoadedHistory(cached !== undefined)
        setHistoryLoadFailed(false)

        let isMounted = true

        // This view shows exactly this chat's cache, whoever changes it.
        const showCommitted = (next: Message[]) => {
            if (isMounted) setMessages(next)
        }
        if (!chatListeners.has(chatId)) chatListeners.set(chatId, new Set())
        chatListeners.get(chatId)!.add(showCommitted)

        // Phase 1: stale-while-revalidate.
        // - On chat open, if we have anything in messageCache, the chat
        //   renders INSTANTLY from it (already done above + initial state).
        // - The fetch below runs WITHOUT setIsLoading(true) on first load
        //   when cache exists, so the UI never flashes a spinner over
        //   already-shown content.
        // - We dropped the `_t=${now}` cache buster so the browser HTTP
        //   cache + any future ETag/Last-Modified can de-duplicate
        //   identical responses.
        const loadMessages = async (opts: { silent?: boolean; force?: boolean } = {}) => {
            // Avoid overlapping requests
            const now = Date.now()
            if (loadInFlight.current) return
            if (!opts.force && now - lastFetchTime.current < 2000) return
            lastFetchTime.current = now
            loadInFlight.current = true

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
                const result = await fetchMessageHistory(chatId)

                if (isMounted && !result.ok) {
                    console.error("Failed to load messages", result)
                    // A failed refresh never takes away history the operator can
                    // already see. If usable history exists it stays (or is
                    // adopted, when a prefetch filled the cache meanwhile); only a
                    // foreground read with nothing usable becomes a failure.
                    const usable = messageCache.get(chatId)
                    if (usable) {
                        setMessages(usable)
                        setHasLoadedHistory(true)
                    } else if (!opts.silent) {
                        setHistoryLoadFailed(true)
                    }
                }

                if (isMounted && result.ok) {
                    const enrichedData = result.messages

                    // MERGE by clientMessageId: server rows are canonical, sends
                    // this device has in flight or left unanswered stay, and a
                    // settled row is never moved backwards by an older read.
                    commitChatMessages(chatId, local => mergeHistorySnapshot(enrichedData, local))
                    setHasMoreHistory(enrichedData.length >= 50)
                    setHasLoadedHistory(true)
                    setHistoryLoadFailed(false)
                }
            } catch (error) {
                console.error("Failed to load messages", error)
                if (isMounted && !opts.silent && !messageCache.has(chatId)) setHistoryLoadFailed(true)
            } finally {
                loadInFlight.current = false
                if (spinnerTimer) clearTimeout(spinnerTimer)
                if (isMounted && shouldShowSpinner) setIsLoading(false)
            }
        }
        loadMessagesRef.current = loadMessages

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
                // Handle deletion broadcast
                if (incoming.deleted === true) {
                    commitChatMessages(chatId, prev => prev.filter(m => m.id !== incoming.id))
                    return
                }
                // Append (or fold into the existing entry without a refetch).
                // The entry is found by:
                //   1. id                    — a later push for the same row
                //                              (the settled row after the created one)
                //   2. clientMessageId       — the optimistic row of this device's
                //                              own send, whatever its local id; the
                //                              canonical row replaces it, so the two
                //                              are never both shown
                //   3. content + direction + ±10s sentAt window — last resort, only
                //      for outbound that carries no clientMessageId (legacy paths).
                // Folding never moves a row backwards: a created row arriving after
                // the settled answer cannot turn 'delivered' back into 'sent'.
                commitChatMessages(chatId, prev => {
                    const cmid = (incoming as any).clientMessageId as string | undefined
                    let existing = findSendRow(prev, { id: incoming.id, clientMessageId: cmid })
                    if (existing < 0 && !cmid && incoming.direction === 'outbound') {
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
                        next[existing] = mergeCanonicalRow(next[existing], incoming)
                    } else {
                        next = [...prev, { ...incoming, channel: incoming.channel || 'whatsapp' }]
                        // Keep the list sorted by sentAt
                        next.sort((a, b) => new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime())
                    }
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
        const refreshActiveChat = () => {
            void loadMessages({ silent: true, force: true })
        }
        const refreshOnVisibility = () => {
            if (document.visibilityState === 'visible') refreshActiveChat()
        }

        window.addEventListener('focus', refreshActiveChat)
        document.addEventListener('visibilitychange', refreshOnVisibility)

        const interval = setInterval(refreshActiveChat, 30000)
        return () => {
            isMounted = false
            const listeners = chatListeners.get(chatId)
            listeners?.delete(showCommitted)
            if (listeners && listeners.size === 0) chatListeners.delete(chatId)
            clearInterval(interval)
            window.removeEventListener('focus', refreshActiveChat)
            document.removeEventListener('visibilitychange', refreshOnVisibility)
            loadMessagesRef.current = async () => {}
            if (eventSource) eventSource.close()
        }
    }, [chatId])

    // Explicit retry after a failed first read. A second tap while one is
    // pending does nothing, and the button is disabled for the same window.
    const retryHistoryLoad = async () => {
        if (!chatId || chatId.startsWith('empty:') || retryInFlight.current) return
        retryInFlight.current = true
        setIsRetryingHistory(true)
        try {
            await loadMessagesRef.current({ force: true })
        } finally {
            retryInFlight.current = false
            setIsRetryingHistory(false)
        }
    }

    const loadMoreHistory = async () => {
        if (!chatId || !hasMoreHistory || isLoading) return
        
        // Placeholder for upward pagination
        // In real impl: fetch(`/api/messages?chatId=${chatId}&before=${messages[0].id}`)
        console.log("Loading more history upwards...")
        setHasMoreHistory(false) 
    }

    const sendMessage = async (content: string, channel: string, quotedMsgId?: string) => {
        // The conversation this intent belongs to, fixed now. Its answer lands
        // here even if the operator has switched to another chat meanwhile.
        const sendChatId = chatId
        if (!sendChatId) return

        // Normalize channel for API (wa→whatsapp, tg→telegram)
        const normalizeForApi = (ch: string) => ch === 'wa' ? 'whatsapp' : ch === 'tg' ? 'telegram' : ch
        const apiChannel = normalizeForApi(channel)

        // One logical send intent, one idempotency key, for its whole life:
        // every repeat of this intent carries the same clientMessageId.
        const clientMessageId = `cmid-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`

        // Optimistic UI update (<50ms local echo contract)
        const optimisticMsg: Message = {
            id: clientMessageId,  // Use clientMessageId as optimistic ID
            direction: 'outbound',
            type: 'text',
            content,
            sentAt: new Date().toISOString(),
            status: 'sending',
            channel: apiChannel,
            origin: 'operator',
            clientMessageId,
            metadata: quotedMsgId ? { quotedMsgId } : undefined,
        }
        commitChatMessages(sendChatId, list => [...list, optimisticMsg])

        // Optimistic Sorting: move chat to top instantly
        patchConversation(sendChatId, {
            lastMessageAt: optimisticMsg.sentAt,
            messages: [{ content: optimisticMsg.content }]
        })

        await postSendIntent(sendChatId, { clientMessageId, content, channel: apiChannel, quotedMsgId })
    }

    /**
     * «Повторить». Never a new send intent:
     * - an intent whose request got no answer is sent again with its OWN
     *   clientMessageId, so a server that already has it answers with that row;
     * - a persisted failure the owner marked safe to redeliver is retried as
     *   that same Message row through the Messaging retry capability.
     * Anything else — a terminal failure, an unknown delivery outcome — is not
     * retried at all.
     */
    const retryMessage = async (message: Message) => {
        const retryChatId = chatId
        if (!retryChatId || message.direction !== 'outbound' || message.status !== 'failed') return

        if (isLocalSendFailure(message)) {
            const clientMessageId = message.clientMessageId || message.id
            const key = { id: message.id, clientMessageId }
            commitChatMessages(retryChatId, list => updateSendRow(list, key, row => ({
                ...row,
                status: 'sending',
                metadata: row.metadata?.quotedMsgId ? { quotedMsgId: row.metadata.quotedMsgId } : undefined,
            })))
            await postSendIntent(retryChatId, {
                clientMessageId,
                content: message.content,
                channel: message.channel,
                quotedMsgId: typeof message.metadata?.quotedMsgId === 'string' ? message.metadata.quotedMsgId : undefined,
            })
            return
        }

        const retryPersisted = options.retryPersistedDelivery
        if (message.metadata?.retryable !== true || !retryPersisted || retriesInFlight.has(message.id)) return
        retriesInFlight.add(message.id)
        const key = { id: message.id }
        const previous = message
        commitChatMessages(retryChatId, list => updateSendRow(list, key, row => ({ ...row, status: 'sending' })))
        try {
            const result = await retryPersisted(message.id)
            commitChatMessages(retryChatId, list => updateSendRow(list, key, row => result.message
                ? applySendAnswer(row, {
                    success: result.message.status !== 'failed',
                    id: result.message.id,
                    status: result.message.status,
                    externalId: result.message.externalId,
                    error: result.message.error ?? result.error,
                    retryable: result.message.retryable,
                    deliveryOutcome: result.message.deliveryOutcome,
                })
                : { ...previous, metadata: { ...previous.metadata, error: result.error || previous.metadata?.error } }))
        } catch (err) {
            console.error('[RETRY] Network Error:', err)
            // The attempt's fate is unknown here; the row is still the persisted
            // failure it was, and the server's lease stops a second dispatch.
            commitChatMessages(retryChatId, list => updateSendRow(list, key, row =>
                row.status === 'sending' ? previous : row))
        } finally {
            retriesInFlight.delete(message.id)
        }
    }

    const sendMedia = async (file: File, dataUrl: string, caption: string, channel: string) => {
        if (!chatId) return

        const mimeType = file.type || 'application/octet-stream'
        let msgType: Message['type'] = 'document'
        let contentLabel = caption || ''
        if (mimeType.startsWith('image/'))       { msgType = 'image';    contentLabel = contentLabel || '[Фото]' }
        else if (mimeType.startsWith('video/'))  { msgType = 'video';    contentLabel = contentLabel || '[Видео]' }
        else if (mimeType === 'audio/ogg' || mimeType.includes('opus')) { msgType = 'voice'; contentLabel = contentLabel || '[Голосовое]' }
        else if (mimeType.startsWith('audio/'))  { msgType = 'audio';    contentLabel = contentLabel || '[Аудио]' }
        else                                     { msgType = 'document'; contentLabel = contentLabel || file.name || '[Файл]' }

        const clientMessageId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`

        const optimisticMsg: Message = {
            id: `cmid-${clientMessageId}`,
            direction: 'outbound',
            type: msgType,
            content: contentLabel,
            sentAt: new Date().toISOString(),
            status: 'sent',
            channel,
            origin: 'operator',
            clientMessageId,
        }

        const currentMsgs = messageCache.get(chatId) || []
        const newMsgs = [...currentMsgs, optimisticMsg]
        messageCache.set(chatId, newMsgs)
        setMessages(newMsgs)

        try {
            const base64 = dataUrl.split(',')[1]
            const res = await fetch('/api/messages/send-media', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chatId: chatId.split(',')[0],
                    base64,
                    filename: file.name,
                    mimeType,
                    caption,
                    clientMessageId,
                }),
            })
            if (!res.ok) {
                const failedMsgs = (messageCache.get(chatId) || []).map(m =>
                    m.id === `cmid-${clientMessageId}` ? { ...m, status: 'failed' as const } : m
                )
                messageCache.set(chatId, failedMsgs)
                setMessages(failedMsgs)
            } else {
                const result = await res.json().catch(() => null)
                const allowedStatuses = new Set<Message['status']>(['queued', 'sent', 'delivered', 'read', 'failed'])
                const finalStatus = result?.success === false
                    ? 'failed' as const
                    : (allowedStatuses.has(result?.status) ? result.status : 'sent') as Message['status']
                const updatedMsgs = (messageCache.get(chatId) || []).map(m =>
                    m.id === `cmid-${clientMessageId}`
                        ? { ...m, id: result?.messageId || m.id, clientMessageId, status: finalStatus }
                        : m
                )
                messageCache.set(chatId, updatedMsgs)
                setMessages(updatedMsgs)
                await loadMessagesRef.current({ silent: true, force: true })
            }
        } catch {
            const failedMsgs = (messageCache.get(chatId) || []).map(m =>
                m.id === `cmid-${clientMessageId}` ? { ...m, status: 'failed' as const } : m
            )
            messageCache.set(chatId, failedMsgs)
            setMessages(failedMsgs)
        }
    }

    const deleteMessage = async (messageId: string, deleteForEveryone: boolean) => {
        if (!chatId) return
        // Optimistic: remove instantly from local state
        setMessages(prev => {
            const next = prev.filter(m => m.id !== messageId)
            messageCache.set(chatId, next)
            return next
        })
        await fetch('/api/messages/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messageId, deleteForEveryone }),
        }).catch(() => {})
    }

    return {
        messages,
        uiItems,
        isLoading,
        hasLoadedHistory,
        historyLoadFailed,
        isRetryingHistory,
        retryHistoryLoad,
        loadMoreHistory,
        hasMoreHistory,
        sendMessage,
        retryMessage,
        sendMedia,
        deleteMessage,
    }
}
