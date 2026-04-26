import { useState, useEffect, useCallback } from "react"

export interface Conversation {
    id: string
    name: string
    channel: string
    chatType?: 'private' | 'group' | 'supergroup' | 'channel'
    externalChatId: string
    lastMessageAt: string
    unreadCount: number
    requiresResponse: boolean
    status: 'new' | 'open' | 'waiting_customer' | 'waiting_internal' | 'resolved'
    assignedToUserId?: string | null
    lastInboundAt?: string | null
    lastOutboundAt?: string | null
    driver?: {
        id: string
        fullName: string
        phone: string | null
        segment: string
        lastOrderAt?: string | null
        dismissedAt?: string | null
    }
    contact?: {
        id: string
        displayName: string | null
    }
    messages?: { content: string; type?: string; metadata?: Record<string, any> | null }[]
    metadata?: Record<string, any> | null
    // Contact Model (MVP)
    contactId?: string | null
    contactIdentityId?: string | null
    // Multi-channel aggregation fields (from merged driver chats)
    allChatIds?: string[]
    channelMap?: Record<string, string> // { whatsapp: chatId, telegram: chatId, max: chatId }
    channelUnread?: Record<string, number> // { whatsapp: 3, telegram: 1, ... }
    allChannels?: string[]
    allProfiles?: { channel: string, profileId: string }[]
}

// SHARED STATE (outside the hook) to keep all ChatList/Workspace instances in sync
let globalConversations: Conversation[] = []
let globalListeners: ((convs: Conversation[]) => void)[] = []

// Locally marked as read: chatIds whose unreadCount was optimistically zeroed.
// Used to prevent polling from overwriting back to old count before mark-read API completes.
// Entry is removed when we confirm via polling that server-side unreadCount is also 0.
const markedAsReadLocally = new Set<string>()

// "Sticky unread for sort" — chats that were just marked read while user is viewing them.
// For SORT purposes they're treated as still unread so they don't fly out from under the cursor.
// Cleared when user navigates away (selectedChatId changes).
const stickyUnreadForSort = new Set<string>()

export function isStickyUnread(chatId: string): boolean {
    return stickyUnreadForSort.has(chatId)
}

/**
 * Release the sort-only "sticky unread" flag for a chat.
 * Call this when user navigates away from a chat so it can drop to the "read" section naturally.
 */
export function releaseStickyUnread(chatId: string) {
    let changed = stickyUnreadForSort.delete(chatId)
    // Also release all merged chatIds (same driver/contact)
    const conv = globalConversations.find(c => c.id === chatId || c.allChatIds?.includes(chatId))
    if (conv?.allChatIds) {
        for (const id of conv.allChatIds) {
            if (stickyUnreadForSort.delete(id)) changed = true
        }
    }
    if (changed) {
        globalConversations = sortConversations(globalConversations)
        globalListeners.forEach(l => l([...globalConversations]))
    }
}

/**
 * Sort: unread chats first (by lastMessageAt desc), then read chats (by lastMessageAt desc).
 * Produces a stable, Telegram-like ordering where attention items bubble up.
 */
function sortConversations(list: Conversation[]): Conversation[] {
    return [...list].sort((a, b) => {
        // "Effectively unread" = actually unread OR sticky-unread (just-read chat kept in place)
        const aUnread = (a.unreadCount || 0) > 0 || stickyUnreadForSort.has(a.id) ? 1 : 0
        const bUnread = (b.unreadCount || 0) > 0 || stickyUnreadForSort.has(b.id) ? 1 : 0
        if (aUnread !== bUnread) return bUnread - aUnread
        const ta = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0
        const tb = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0
        return tb - ta
    })
}

/**
 * Apply "marked as read locally" overlay on fresh data from API.
 * For any chat in the local set, force unreadCount: 0 and clear channelUnread.
 */
function applyLocalReadOverlay(list: Conversation[]): Conversation[] {
    if (markedAsReadLocally.size === 0) return list
    return list.map(c => {
        const idMatches = markedAsReadLocally.has(c.id) ||
                          (c.allChatIds && c.allChatIds.some(id => markedAsReadLocally.has(id)))
        if (!idMatches) return c
        // If API already reports 0, we can safely drop the overlay entry
        if ((c.unreadCount || 0) === 0) {
            markedAsReadLocally.delete(c.id)
            if (c.allChatIds) c.allChatIds.forEach(id => markedAsReadLocally.delete(id))
            return c
        }
        // Otherwise keep overlay
        return { ...c, unreadCount: 0, channelUnread: c.channelUnread ? {} : c.channelUnread }
    })
}

/**
 * Optimistically mark a chat as read:
 * - Zeroes unreadCount + channelUnread locally (instant UI feedback)
 * - Tracks chatId in markedAsReadLocally so polling doesn't overwrite
 * - Calls /api/chats/{id}/read; on success, removes local overlay entry
 */
export async function markChatRead(chatId: string): Promise<void> {
    markedAsReadLocally.add(chatId)
    // Also track all allChatIds for merged driver/contact conversations
    const conv = globalConversations.find(c => c.id === chatId || c.allChatIds?.includes(chatId))
    if (conv?.allChatIds) conv.allChatIds.forEach(id => markedAsReadLocally.add(id))

    // Pin chat in its current sort group (unread) until user navigates away.
    // Only pin if chat WAS unread before this call — don't promote already-read chats.
    const wasUnread = conv && (conv.unreadCount || 0) > 0
    if (wasUnread) {
        stickyUnreadForSort.add(chatId)
        if (conv?.allChatIds) conv.allChatIds.forEach(id => stickyUnreadForSort.add(id))
    }

    globalConversations = globalConversations.map(c => {
        if (c.id === chatId || c.allChatIds?.includes(chatId)) {
            return { ...c, unreadCount: 0, channelUnread: {} }
        }
        return c
    })
    globalConversations = sortConversations(globalConversations)
    globalListeners.forEach(l => l([...globalConversations]))

    try {
        await fetch(`/api/chats/${chatId}/read`, { method: 'POST' })
    } catch (e) {
        // Non-fatal — polling will eventually re-sync
        console.error('[markChatRead] API call failed:', e)
    }
}

/**
 * Optimistically update a conversation and notify all listeners.
 */
export function patchConversation(chatId: string, patch: Partial<Conversation>) {
    globalConversations = globalConversations.map(c => {
        if (c.id === chatId || c.allChatIds?.includes(chatId)) {
            return { ...c, ...patch }
        }
        return c
    })

    globalConversations = sortConversations(globalConversations)
    globalListeners.forEach(listener => listener([...globalConversations]))
}

export function useConversations() {
    const [conversations, setConversationsState] = useState<Conversation[]>(globalConversations)
    const [isLoading, setIsLoading] = useState(globalConversations.length === 0)

    useEffect(() => {
        const listener = (convs: Conversation[]) => {
            setConversationsState(convs)
        }
        globalListeners.push(listener)
        
        let isMounted = true

        const loadChats = async () => {
            try {
                const res = await fetch('/api/messages/conversations')
                const data = await res.json()
                if (isMounted) {
                    if (Array.isArray(data)) {
                        globalConversations = sortConversations(applyLocalReadOverlay(data))
                        globalListeners.forEach(l => l([...globalConversations]))
                    } else {
                        console.error("Invalid conversations data format", data)
                    }
                    setIsLoading(false)
                }
            } catch (err) {
                console.error("Failed to load conversations", err)
                if (isMounted) setIsLoading(false)
            }
        }

        if (globalConversations.length === 0) {
            loadChats()
        }

        const interval = setInterval(loadChats, 10000) // Poll every 10s
        return () => {
            isMounted = false
            clearInterval(interval)
            globalListeners = globalListeners.filter(l => l !== listener)
        }
    }, [])

    const setConversations = useCallback((setter: any) => {
        if (typeof setter === 'function') {
            globalConversations = setter(globalConversations)
        } else {
            globalConversations = setter
        }
        globalListeners.forEach(l => l([...globalConversations]))
    }, [])

    return { conversations, setConversations, isLoading, refreshConversations }
}

/**
 * Force an immediate refetch of conversations (shared across all hook instances).
 */
export async function refreshConversations() {
    try {
        const res = await fetch('/api/messages/conversations')
        const data = await res.json()
        if (Array.isArray(data)) {
            globalConversations = sortConversations(applyLocalReadOverlay(data))
            globalListeners.forEach(l => l([...globalConversations]))
        }
    } catch (err) {
        console.error('[refreshConversations] Failed:', err)
    }
}
