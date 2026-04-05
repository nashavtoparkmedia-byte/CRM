"use client"

import { useState, useEffect, useMemo } from "react"
import { MessageSquare } from "lucide-react"
import ChatHeader from "./ChatHeader"
import ChatChannelTabs from "./ChatChannelTabs"
import MessageFeed from "./MessageFeed"
import MessageInputArea, { ReplyContextType } from "./MessageInputArea"
import { useConversations } from "../hooks/useConversations"
import { useMessages, Message } from "../hooks/useMessages"
import TaskCreateModal from "@/app/tasks/components/TaskCreateModal"

export default function ChatWorkspace({
    chatId,
    activeChannelTab,
    isProfileOpen,
    initialMessageId
}: {
    chatId: string | null
    activeChannelTab: string
    isProfileOpen: boolean
    initialMessageId?: string | null
}) {
    const { conversations } = useConversations()

    const chat = conversations.find(c => c.id === chatId || c.allChatIds?.includes(chatId!))

    // Compute effective chatId — determines the remount boundary.
    // When effectiveChatId changes, ChatWorkspaceInner is fully remounted
    // via key={effectiveChatId}, ensuring clean state (no stale refs/data).
    const effectiveChatId = useMemo(() => {
        if (!chatId || !chat) return chatId

        if (activeChannelTab === 'all' && chat.allChatIds && chat.allChatIds.length > 1) {
            return chat.allChatIds.join(',')
        }

        if (activeChannelTab !== 'all' && chat.channelMap) {
            const normalizedChannel = activeChannelTab === 'wa' ? 'whatsapp' : activeChannelTab === 'tg' ? 'telegram' : activeChannelTab === 'ypro' ? 'yandex_pro' : activeChannelTab
            const channelChatId = chat.channelMap[normalizedChannel]
            if (channelChatId) return channelChatId
            return `empty:${normalizedChannel}`
        }

        return chatId
    }, [chatId, chat, activeChannelTab])

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

    // key={effectiveChatId} — remount boundary.
    // Full unmount/mount on chat switch → clean useMessages state, clean refs, clean DOM.
    return (
        <ChatWorkspaceInner
            key={effectiveChatId}
            chatId={chatId}
            effectiveChatId={effectiveChatId}
            activeChannelTab={activeChannelTab}
            isProfileOpen={isProfileOpen}
            initialMessageId={initialMessageId}
            chat={chat}
            conversations={conversations}
        />
    )
}

// ── Inner component: remounted on every effectiveChatId change ──────────────
function ChatWorkspaceInner({
    chatId,
    effectiveChatId,
    activeChannelTab,
    isProfileOpen,
    initialMessageId,
    chat,
    conversations,
}: {
    chatId: string
    effectiveChatId: string | null
    activeChannelTab: string
    isProfileOpen: boolean
    initialMessageId?: string | null
    chat: any
    conversations: any[]
}) {
    const { messages, uiItems, isLoading, hasMoreHistory, loadMoreHistory, sendMessage } = useMessages(effectiveChatId)

    const [replyContext, setReplyContext] = useState<ReplyContextType | null>(null)
    const [manualSendChannelMode, setManualSendChannelMode] = useState<string>('whatsapp')
    const [isSearchActive, setIsSearchActive] = useState(false)
    const [searchQuery, setSearchQuery] = useState("")
    const [searchResults, setSearchResults] = useState<string[]>([])
    const [activeSearchIndex, setActiveSearchIndex] = useState(-1)
    const [lastSentAt, setLastSentAt] = useState<number>(0)
    const [taskModalContext, setTaskModalContext] = useState<Message | null>(null)
    const [isTaskModalOpenForChat, setIsTaskModalOpenForChat] = useState(false)

    // No need for chatId-based reset useEffect — remount handles it

    useEffect(() => {
        if (!isSearchActive || !searchQuery.trim()) {
            setSearchResults([])
            setActiveSearchIndex(-1)
            return
        }

        const query = searchQuery.toLowerCase()
        const matches = messages
            .filter(m => (activeChannelTab === 'all' || m.channel === activeChannelTab) && m.content.toLowerCase().includes(query))
            .map(m => m.id)
            .reverse()

        setSearchResults(matches)
        setActiveSearchIndex(matches.length > 0 ? 0 : -1)
    }, [searchQuery, isSearchActive, messages, activeChannelTab])

    const handleSearchNavigate = (direction: 'up' | 'down') => {
        if (searchResults.length === 0) return
        if (direction === 'up') {
            setActiveSearchIndex(prev => (prev < searchResults.length - 1 ? prev + 1 : prev))
        } else {
            setActiveSearchIndex(prev => (prev > 0 ? prev - 1 : prev))
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
            authorLabel: msg.direction === 'outbound' ? 'Вы' : (conversations.find((c: any) => c.id === chatId)?.name || 'Водитель'),
            snippet: msg.content.substring(0, 60),
            timestamp: new Date(msg.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        })
    }

    const isEmptyChannel = effectiveChatId?.startsWith('empty:')

    return (
        <div className="flex-1 flex flex-col overflow-hidden z-10">
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
                onOpenCreateTask={() => setIsTaskModalOpenForChat(true)}
            />

            <ChatChannelTabs activeChannelTab={activeChannelTab} chat={chat} />

            {isEmptyChannel ? (
                <div className="flex-1 flex flex-col items-center justify-center messenger-bg">
                    <div className="flex flex-col items-center">
                        <div className="w-12 h-12 rounded-full bg-white/60 flex items-center justify-center mb-3 text-[#B0B5BA]">
                            <MessageSquare size={22} />
                        </div>
                        <p className="text-[13px] text-[#8A9099] text-center">
                            Нет переписки в этом канале
                        </p>
                        <p className="text-[11px] text-[#B0B5BA] mt-1">
                            Используйте кнопку «Написать» в карточке контакта
                        </p>
                    </div>
                </div>
            ) : (
                <MessageFeed
                    chatId={chatId}
                    channelTab={activeChannelTab}
                    uiItems={uiItems}
                    isLoading={isLoading}
                    hasMoreHistory={hasMoreHistory}
                    onLoadMore={loadMoreHistory}
                    onReply={handleReply}
                    onCreateTask={setTaskModalContext}
                    activeSearchMessageId={activeSearchIndex >= 0 ? searchResults[activeSearchIndex] : (initialMessageId ?? null)}
                    onFocusComposer={() => document.getElementById('message-composer')?.focus()}
                    lastSentAt={lastSentAt}
                />
            )}

            <MessageInputArea
                chatId={chatId}
                activeChannelTab={activeChannelTab}
                replyContext={replyContext}
                onClearReply={() => setReplyContext(null)}
                manualSendChannelMode={manualSendChannelMode}
                setManualSendChannelMode={setManualSendChannelMode}
                onSendMessage={handleSendMessage}
            />

            {(taskModalContext || isTaskModalOpenForChat) && chat.driver?.id && (
                <TaskCreateModal
                    driverId={chat.driver.id}
                    driverName={chat.name || 'Водитель'}
                    source="chat"
                    chatContext={{
                        chatId,
                        ...(taskModalContext ? {
                            messageId: taskModalContext.id,
                            excerpt: taskModalContext.content.substring(0, 150),
                            createdAt: taskModalContext.sentAt
                        } : {})
                    }}
                    onClose={() => {
                        setTaskModalContext(null)
                        setIsTaskModalOpenForChat(false)
                    }}
                />
            )}
        </div>
    )
}
