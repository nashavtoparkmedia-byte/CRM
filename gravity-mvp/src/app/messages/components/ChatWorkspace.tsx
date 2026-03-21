"use client"

import { useState, useEffect, useMemo } from "react"
import { MessageSquare } from "lucide-react"
import ChatHeader from "./ChatHeader"
import ChatChannelTabs from "./ChatChannelTabs"
import MessageFeed from "./MessageFeed"
import MessageInputArea, { ReplyContextType } from "./MessageInputArea"
import { useConversations } from "../hooks/useConversations"
import { useMessages, Message } from "../hooks/useMessages"

export default function ChatWorkspace({ 
    chatId, 
    activeChannelTab, 
    isProfileOpen 
}: { 
    chatId: string | null
    activeChannelTab: string
    isProfileOpen: boolean
}) {
    const { conversations } = useConversations()
    
    // Find chat — search both by primary id AND within allChatIds (for merged multi-channel conversations)
    const chat = conversations.find(c => c.id === chatId || c.allChatIds?.includes(chatId!))
    
    // Compute effective chatId(s) for message fetching:
    // - "All" tab → pass ALL driver's chatIds (comma-separated)
    // - Specific channel tab → pass that channel's chatId from channelMap
    const effectiveChatId = useMemo(() => {
        if (!chatId || !chat) return chatId
        
        if (activeChannelTab === 'all' && chat.allChatIds && chat.allChatIds.length > 1) {
            // Fetch messages from ALL driver's channel-specific conversations
            return chat.allChatIds.join(',')
        }
        
        // Specific channel tab: if the driver has a chat for that channel, use that chatId
        if (activeChannelTab !== 'all' && chat.channelMap) {
            const normalizedChannel = activeChannelTab === 'wa' ? 'whatsapp' : activeChannelTab === 'tg' ? 'telegram' : activeChannelTab === 'ypro' ? 'yandex_pro' : activeChannelTab
            const channelChatId = chat.channelMap[normalizedChannel]
            if (channelChatId) return channelChatId
        }
        
        return chatId
    }, [chatId, chat, activeChannelTab])
    
    const { messages, uiItems, isLoading, hasMoreHistory, loadMoreHistory, sendMessage } = useMessages(effectiveChatId)
    
    // Phase 5 States 
    const [replyContext, setReplyContext] = useState<ReplyContextType | null>(null)
    const [manualSendChannelMode, setManualSendChannelMode] = useState<string>('whatsapp')

    // Phase 6 States (In-Chat Search)
    const [isSearchActive, setIsSearchActive] = useState(false)
    const [searchQuery, setSearchQuery] = useState("")
    const [searchResults, setSearchResults] = useState<string[]>([]) // Array of message IDs
    const [activeSearchIndex, setActiveSearchIndex] = useState(-1) // 0-based index
    const [lastSentAt, setLastSentAt] = useState<number>(0)

    // Reset ephemeral state when chat changes
    useEffect(() => {
        setReplyContext(null)
        setManualSendChannelMode('whatsapp') // Or fallback
        setIsSearchActive(false)
        setSearchQuery("")
        setSearchResults([])
        setActiveSearchIndex(-1)
    }, [chatId])

    // Mock Search Logic (Phase 6)
    useEffect(() => {
        if (!isSearchActive || !searchQuery.trim()) {
            setSearchResults([])
            setActiveSearchIndex(-1)
            return
        }

        const query = searchQuery.toLowerCase()
        // In real app: server-side search fetch(`/api/search?q=${query}&chatId=${chatId}&channel=${activeChannelTab}`)
        const matches = messages
            .filter(m => (activeChannelTab === 'all' || m.channel === activeChannelTab) && m.content.toLowerCase().includes(query))
            .map(m => m.id)
            .reverse() // Telegram usually searches newest to oldest

        setSearchResults(matches)
        setActiveSearchIndex(matches.length > 0 ? 0 : -1)
    }, [searchQuery, isSearchActive, messages, activeChannelTab])

    const handleSearchNavigate = (direction: 'up' | 'down') => {
        if (searchResults.length === 0) return
        if (direction === 'up') {
            setActiveSearchIndex(prev => (prev < searchResults.length - 1 ? prev + 1 : prev)) // Older
        } else {
            setActiveSearchIndex(prev => (prev > 0 ? prev - 1 : prev)) // Newer
        }
    }

    const handleSendMessage = (content: string, effectiveChannel: string) => {
        setLastSentAt(Date.now())
        sendMessage(content, effectiveChannel)
    }

    const handleReply = (msg: Message) => {
        setReplyContext({
            messageId: msg.id,
            channel: msg.channel,
            authorLabel: msg.direction === 'outbound' ? 'Вы' : (conversations.find(c => c.id === chatId)?.name || 'Водитель'),
            snippet: msg.content.substring(0, 60),
            timestamp: new Date(msg.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        })
    }


    if (!chatId || !chat) {
        return (
            <div className="flex-1 flex flex-col items-center justify-center messenger-bg animate-in fade-in duration-500">
                <div className="flex flex-col items-center">
                    <div className="w-16 h-16 rounded-full bg-white/60 flex items-center justify-center mb-4 text-[#B0B5BA]">
                        <MessageSquare size={28} />
                    </div>
                    <h3 className="text-[18px] font-semibold text-[#474B50] tracking-tight">Выберите диалог</h3>
                    <p className="text-[13px] text-[#8A9099] mt-1.5 max-w-[320px] text-center leading-snug">
                        Нажмите на контакт слева для переписки
                    </p>
                </div>
            </div>
        )
    }

    return (
        <div className="flex-1 flex flex-col overflow-hidden z-10">
            {/* Header Area */}
            <ChatHeader 
                chat={chat} 
                isProfileOpen={isProfileOpen} 
                isSearchActive={isSearchActive}
                setIsSearchActive={setIsSearchActive}
                searchQuery={searchQuery}
                setSearchQuery={setSearchQuery}
                searchResultsCount={searchResults.length}
                activeSearchIndex={activeSearchIndex}
                onSearchNavigate={handleSearchNavigate}
            />
            
            {/* Context/Channel Tabs */}
            <ChatChannelTabs activeChannelTab={activeChannelTab} chat={chat} />

            {/* Core Message Feed */}
            <MessageFeed 
                chatId={chatId}
                channelTab={activeChannelTab}
                uiItems={uiItems}
                isLoading={isLoading}
                hasMoreHistory={hasMoreHistory}
                onLoadMore={loadMoreHistory}
                onReply={handleReply}
                activeSearchMessageId={activeSearchIndex >= 0 ? searchResults[activeSearchIndex] : null}
                onFocusComposer={() => document.getElementById('message-composer')?.focus()}
                lastSentAt={lastSentAt}
            />

            {/* Input Area */}
            <MessageInputArea 
                chatId={chatId}
                activeChannelTab={activeChannelTab}
                replyContext={replyContext}
                onClearReply={() => setReplyContext(null)}
                manualSendChannelMode={manualSendChannelMode}
                setManualSendChannelMode={setManualSendChannelMode}
                onSendMessage={handleSendMessage}
            />
        </div>
    )
}
