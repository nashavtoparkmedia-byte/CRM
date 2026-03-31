import { useState, useEffect, useCallback } from "react"

export interface Conversation {
    id: string
    name: string
    channel: string
    externalChatId: string
    lastMessageAt: string
    unreadCount: number
    requiresResponse: boolean
    status: 'new' | 'active' | 'waiting'
    driver?: {
        id: string
        fullName: string
        phone: string | null
        segment: string
    }
    messages?: { content: string }[]
    metadata?: Record<string, any> | null
    // Multi-channel aggregation fields (from merged driver chats)
    allChatIds?: string[]
    channelMap?: Record<string, string> // { whatsapp: chatId, telegram: chatId, max: chatId }
    allChannels?: string[]
    allProfiles?: { channel: string, profileId: string }[]
}

// SHARED STATE (outside the hook) to keep all ChatList/Workspace instances in sync
let globalConversations: Conversation[] = []
let globalListeners: ((convs: Conversation[]) => void)[] = []

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
    
    // Sort by lastMessageAt immediately for optimistic sorting
    globalConversations.sort((a, b) => {
        const ta = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0
        const tb = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0
        return tb - ta
    })

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
                        globalConversations = data
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

    return { conversations, setConversations, isLoading }
}
