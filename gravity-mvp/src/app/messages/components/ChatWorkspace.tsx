"use client"

import { useState, useEffect, useMemo, useCallback } from "react"
import { MessageSquare } from "lucide-react"
import ChatHeader from "./ChatHeader"
import ChatChannelTabs from "./ChatChannelTabs"
import MessageFeed from "./MessageFeed"
import MessageInputArea, { ReplyContextType } from "./MessageInputArea"
import AiProposedReplyBubble from "./AiProposedReplyBubble"
import AiCoachModal from "./AiCoachModal"
import LearnFromReplyBanner from "./LearnFromReplyBanner"
import { learnFromOutboundAction } from "../learn-from-outbound-actions"
import { useConversations, refreshConversations } from "../hooks/useConversations"
import { useMessages, Message } from "../hooks/useMessages"
import { useProposedReply } from "../hooks/useProposedReply"
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
            const normalizedChannel = activeChannelTab === 'wa' ? 'whatsapp' : activeChannelTab === 'tg' ? 'telegram' : activeChannelTab
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

    // A3: Compute channels that have failed outbound messages
    const failedChannels = useMemo(() => {
        const failed = new Set<string>()
        for (const msg of messages) {
            if (msg.direction === 'outbound' && msg.status === 'failed') {
                failed.add(msg.channel)
            }
        }
        return failed
    }, [messages])

    const [replyContext, setReplyContext] = useState<ReplyContextType | null>(null)
    const [manualSendChannelMode, setManualSendChannelMode] = useState<string>('whatsapp')
    const [isSearchActive, setIsSearchActive] = useState(false)
    const [searchQuery, setSearchQuery] = useState("")
    const [searchResults, setSearchResults] = useState<string[]>([])
    const [activeSearchIndex, setActiveSearchIndex] = useState(-1)
    const [lastSentAt, setLastSentAt] = useState<number>(0)
    const [taskModalContext, setTaskModalContext] = useState<Message | null>(null)
    const [isTaskModalOpenForChat, setIsTaskModalOpenForChat] = useState(false)

    // PR9.46 «AI стажёр»: hook генерирует proposed reply on-demand, когда
    // менеджер фокусится в textarea. По «Взять в работу» возвращает текст
    // — мы кладём его в MessageInputArea через prefillText + prefillToken.
    const ai = useProposedReply(effectiveChatId)
    const [aiPrefillText, setAiPrefillText] = useState<string>('')
    const [aiPrefillToken, setAiPrefillToken] = useState<number>(0)
    // PR9.55: «Поправить» теперь открывает Coach modal вместо простого copy
    const [coachOpen, setCoachOpen] = useState<{
        proposalId:    string
        draft:         string
        initialText?:  string  // PR-С: для autoStart при обучении из outbound
        autoStart?:    boolean
    } | null>(null)
    // PR-С: banner после отправки, когда AI-черновик отличается от выбора оператора
    const [learnBanner, setLearnBanner] = useState<{
        proposalId:    string
        aiText:        string
        sentText:      string
        similarityPct: number
    } | null>(null)
    const handleAiTake = useCallback(async () => {
        // proposal нужен ДО take() — после take() он становится null
        if (!ai.proposal) return
        setCoachOpen({
            proposalId: ai.proposal.id,
            draft:      ai.proposal.text,
        })
        // Mark proposal as taken (для analytics — менеджер начал редактировать)
        await ai.take()
    }, [ai])
    // PR9.54: 👍 «Правильно» — confirmCorrect + copy в input + toast.
    const handleAiConfirmCorrect = useCallback(async () => {
        const res = await ai.confirmCorrect()
        if (!res) return
        // Копируем в input (как take)
        setAiPrefillText(res.text)
        setAiPrefillToken(t => t + 1)
        // Toast — менеджер видит сколько фактов подтверждено в Ядре
        const n = res.result.verifiedCount
        if (n > 0) {
            const word = n === 1 ? 'факт' : n < 5 ? 'факта' : 'фактов'
            console.log(`[ai-intern] ✓ Подтверждено в Ядре: ${n} ${word}`)
        } else {
            console.log(`[ai-intern] ✓ Ответ одобрен (новых фактов для verify не было)`)
        }
    }, [ai])

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

        // Auto-assign on first reply: if chat is unassigned, assign to current user
        if (!chat.assignedToUserId) {
            const userId = typeof document !== 'undefined'
                ? document.cookie.split(';').map((c: string) => c.trim()).find((c: string) => c.startsWith('crm_user_id='))?.split('=')[1]
                : undefined
            if (userId) {
                fetch(`/api/chats/${chatId}/assign`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId }),
                }).catch(() => {})
            }
        }

        // PR-С: «AI учится из ответа оператора».
        // Сравниваем sent с активным AI-черновиком (если был).
        // — similarity ≥ 80% → оператор взял AI-черновик (auto-verify, без UI)
        // — similarity < 80% → показываем banner «Обучить AI»
        // Async — не блокирует основной flow отправки.
        learnFromOutboundAction(chatId, content)
            .then(result => {
                if (result.mode === 'show_banner') {
                    setLearnBanner({
                        proposalId:    result.proposalId,
                        aiText:        result.aiText,
                        sentText:      content,
                        similarityPct: result.similarityPct,
                    })
                }
                // 'auto_verified', 'no_proposal', 'error' — silent
            })
            .catch(err => console.warn('[learnFromOutbound] non-blocking:', err))
    }

    const handleRetry = (msg: Message) => {
        sendMessage(msg.content, msg.channel)
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

    const handleReaction = useCallback(async (msgId: string, emoji: string) => {
        try {
            const res = await fetch('/api/messages/reaction', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messageId: msgId, emoji })
            })
            if (!res.ok) return
            // Optimistic: will be refreshed on next poll
        } catch (e) {
            console.error('[Reaction] error:', e)
        }
    }, [])

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
                onConversationUpdate={refreshConversations}
            />

            <ChatChannelTabs activeChannelTab={activeChannelTab} chat={chat} failedChannels={failedChannels} />

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
                    chatType={chat?.chatType}
                    uiItems={uiItems}
                    isLoading={isLoading}
                    hasMoreHistory={hasMoreHistory}
                    onLoadMore={loadMoreHistory}
                    onReply={handleReply}
                    onRetry={handleRetry}
                    onCreateTask={setTaskModalContext}
                    onReaction={handleReaction}
                    activeSearchMessageId={activeSearchIndex >= 0 ? searchResults[activeSearchIndex] : (initialMessageId ?? null)}
                    onFocusComposer={() => document.getElementById('message-composer')?.focus()}
                    lastSentAt={lastSentAt}
                />
            )}

            {/* PR9.46 «AI стажёр»: призрачное сообщение между MessageFeed и input.
                Появляется когда менеджер фокусится в textarea (см. onTextareaFocus
                пропс ниже). Не загромождает timeline — позиция фиксирована
                выше input bar, после последнего сообщения. */}
            <AiProposedReplyBubble
                proposal={ai.proposal}
                loading={ai.loading}
                silent={ai.silent}
                silentMessage={ai.silentMessage}
                onTake={handleAiTake}
                onConfirmCorrect={handleAiConfirmCorrect}
                onDismiss={ai.dismiss}
            />

            {/* PR9.55: AI Coach modal — открывается по «Поправить». User правит
                draft, AI понимает diff vs Ядро, предлагает обновить items.
                После apply (или skip) — корректный текст копируется в input. */}
            {coachOpen && (
                <AiCoachModal
                    proposalId={coachOpen.proposalId}
                    originalDraft={coachOpen.draft}
                    initialCorrectedText={coachOpen.initialText}
                    autoStart={coachOpen.autoStart}
                    onClose={() => setCoachOpen(null)}
                    onApply={(correctedText, applyRes) => {
                        // Текст идёт в input bar для отправки. PR-С: если модал
                        // открыт из banner после уже отправленного сообщения —
                        // initialText был = sent message, в input копировать не надо.
                        if (!coachOpen.autoStart) {
                            setAiPrefillText(correctedText)
                            setAiPrefillToken(t => t + 1)
                        }
                        if (applyRes && applyRes.applied.length > 0) {
                            console.log(`[ai-coach] обновлено в Ядре: ${applyRes.applied.length}`)
                        }
                        setCoachOpen(null)
                    }}
                />
            )}

            {/* PR-С: banner «Обучить AI» после отправки если sent != AI-черновик. */}
            {learnBanner && !coachOpen && (
                <LearnFromReplyBanner
                    similarityPct={learnBanner.similarityPct}
                    onTrain={() => {
                        // Открываем Coach modal с pre-filled correctedText = sentText, autoStart
                        setCoachOpen({
                            proposalId:    learnBanner.proposalId,
                            draft:         learnBanner.aiText,
                            initialText:   learnBanner.sentText,
                            autoStart:     true,
                        })
                        setLearnBanner(null)
                    }}
                    onDismiss={() => setLearnBanner(null)}
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
                onTextareaFocus={ai.trigger}
                prefillText={aiPrefillText}
                prefillToken={aiPrefillToken}
            />

            {(taskModalContext || isTaskModalOpenForChat) && (
                <TaskCreateModal
                    driverId={chat.driver?.id}
                    contactId={chat.contactId ?? chat.contact?.id ?? undefined}
                    driverName={chat.driver?.fullName || chat.contact?.displayName || chat.name || 'Контакт'}
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
