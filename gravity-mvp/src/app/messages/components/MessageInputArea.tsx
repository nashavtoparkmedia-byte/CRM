"use client"

import { useState, useRef, useEffect, useMemo } from "react"
import { SendHorizonal, Paperclip, X, ChevronDown, Plus, Zap } from "lucide-react"
import QuickReplySuggestions from "./QuickReplySuggestions"
import type { QuickReplyTemplate } from "./QuickReplySuggestions"
import QuickReplyPopover from "./QuickReplyPopover"

// In-memory Draft cache globally preserved across mounts (by chatId + channel)
const draftCache = new Map<string, string>()

// Default quick reply templates (seed data)
const DEFAULT_TEMPLATES: QuickReplyTemplate[] = [
    { id: 'qr-1', name: 'Приветствие', text: 'Здравствуйте! Чем могу помочь?', group: 'Общие' },
    { id: 'qr-2', name: 'Напоминание', text: 'Напоминаю о нашем разговоре. Пожалуйста, ответьте когда будет удобно.', group: 'Общие' },
    { id: 'qr-3', name: 'Регистрация выход', text: 'Для завершения регистрации, пожалуйста, отправьте фото документов.', group: 'Регистрация' },
    { id: 'qr-4', name: 'Регистрация курьер', text: 'Добро пожаловать! Для регистрации курьером, пожалуйста, заполните анкету.', group: 'Регистрация' },
    { id: 'qr-5', name: 'Спасибо', text: 'Спасибо за обращение! Если будут вопросы — пишите.', group: 'Общие' },
    { id: 'qr-6', name: 'Документы', text: 'Пришлите, пожалуйста, фото паспорта (главная страница + прописка) и фото водительского удостоверения.', group: 'Регистрация' },
]

export interface ReplyContextType {
    messageId: string
    channel: string
    authorLabel: string
    snippet: string
    timestamp: string
}

interface MessageInputAreaProps {
    chatId: string
    activeChannelTab: string
    replyContext: ReplyContextType | null
    onClearReply: () => void
    manualSendChannelMode: string | null
    setManualSendChannelMode: (channel: string) => void
    onSendMessage: (content: string, effectiveChannel: string) => void
}

const CHANNELS = [
    { id: 'whatsapp', label: 'WhatsApp', short: 'WA', color: 'text-emerald-600', bg: 'bg-emerald-50', activeBg: 'bg-emerald-500' },
    { id: 'telegram', label: 'Telegram', short: 'TG', color: 'text-blue-600', bg: 'bg-blue-50', activeBg: 'bg-blue-500' },
    { id: 'max', label: 'MAX', short: 'MAX', color: 'text-purple-600', bg: 'bg-purple-50', activeBg: 'bg-purple-500' },
    { id: 'yandex_pro', label: 'Yandex Pro', short: 'YP', color: 'text-yellow-600', bg: 'bg-yellow-50', activeBg: 'bg-yellow-500' },
]

export default function MessageInputArea({
    chatId,
    activeChannelTab,
    replyContext,
    onClearReply,
    manualSendChannelMode,
    setManualSendChannelMode,
    onSendMessage
}: MessageInputAreaProps) {
    const cacheKey = `${chatId}-${activeChannelTab}`
    const [text, setText] = useState(() => draftCache.get(cacheKey) || "")
    const [channelDropdownOpen, setChannelDropdownOpen] = useState(false)
    const [showQuickReplyPopover, setShowQuickReplyPopover] = useState(false)
    const [showSuggestions, setShowSuggestions] = useState(false)
    const [suggestionIndex, setSuggestionIndex] = useState(-1)
    const [templates, setTemplates] = useState<QuickReplyTemplate[]>(DEFAULT_TEMPLATES)
    const textareaRef = useRef<HTMLTextAreaElement>(null)
    const dropdownRef = useRef<HTMLDivElement>(null)

    // Restore draft on chat/channel change
    useEffect(() => {
        const draft = draftCache.get(cacheKey) || ""
        setText(draft)
        setTimeout(() => {
            if (textareaRef.current) {
                textareaRef.current.style.height = 'auto'
                const scrollHeight = textareaRef.current.scrollHeight
                textareaRef.current.style.height = `${Math.min(scrollHeight, 120)}px`
            }
        }, 10)
    }, [cacheKey])

    // Close channel dropdown on outside click
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
                setChannelDropdownOpen(false)
            }
        }
        document.addEventListener('mousedown', handleClickOutside)
        return () => document.removeEventListener('mousedown', handleClickOutside)
    }, [])

    // Auto-suggestions: show when 2+ chars match templates
    const suggestionsMatches = useMemo(() => {
        if (!text || text.length < 2 || showQuickReplyPopover) return []
        const query = text.toLowerCase()
        return templates
            .filter(t => t.name.toLowerCase().includes(query) || t.text.toLowerCase().includes(query))
            .slice(0, 6)
    }, [text, templates, showQuickReplyPopover])

    useEffect(() => {
        setShowSuggestions(suggestionsMatches.length > 0)
        setSuggestionIndex(-1)
    }, [suggestionsMatches.length])

    const handleTextChange = (val: string) => {
        setText(val)
        draftCache.set(cacheKey, val)
    }

    // Effective send channel hierarchy
    const effectiveSendChannel = replyContext?.channel 
                                 || (activeChannelTab !== 'all' ? activeChannelTab : null) 
                                 || manualSendChannelMode 
                                 || 'whatsapp'

    const normalizeChannel = (ch: string) => ch === 'wa' ? 'whatsapp' : ch === 'tg' ? 'telegram' : ch === 'ypro' ? 'yandex_pro' : ch
    const effectiveNormalized = normalizeChannel(effectiveSendChannel)
    const currentChannelInfo = CHANNELS.find(c => c.id === effectiveNormalized) || CHANNELS[0]

    const handleInput = () => {
        if (textareaRef.current) {
            textareaRef.current.style.height = 'auto'
            const scrollHeight = textareaRef.current.scrollHeight
            textareaRef.current.style.height = `${Math.min(scrollHeight, 120)}px`
        }
    }

    const handleSend = () => {
        if (!text.trim()) return
        onSendMessage(text.trim(), effectiveSendChannel)
        setText("")
        draftCache.delete(cacheKey)
        onClearReply()
        setShowSuggestions(false)
        if (textareaRef.current) textareaRef.current.style.height = 'auto'
    }

    const handleQuickReplySelect = (templateText: string) => {
        setText(templateText)
        draftCache.set(cacheKey, templateText)
        setShowSuggestions(false)
        setShowQuickReplyPopover(false)
        // Focus textarea and set cursor at end
        setTimeout(() => {
            if (textareaRef.current) {
                textareaRef.current.focus()
                textareaRef.current.style.height = 'auto'
                const scrollHeight = textareaRef.current.scrollHeight
                textareaRef.current.style.height = `${Math.min(scrollHeight, 120)}px`
            }
        }, 50)
    }

    const handleKeyDown = (e: React.KeyboardEvent) => {
        // Quick reply suggestion navigation
        if (showSuggestions && suggestionsMatches.length > 0) {
            if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSuggestionIndex(prev => prev <= 0 ? suggestionsMatches.length - 1 : prev - 1)
                return
            }
            if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSuggestionIndex(prev => prev >= suggestionsMatches.length - 1 ? 0 : prev + 1)
                return
            }
            if (e.key === 'Enter' && !e.shiftKey && suggestionIndex >= 0) {
                e.preventDefault()
                handleQuickReplySelect(suggestionsMatches[suggestionIndex].text)
                return
            }
            if (e.key === 'Escape') {
                e.preventDefault()
                setShowSuggestions(false)
                return
            }
        }

        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            handleSend()
        }
        if (e.key === 'Escape') {
            e.preventDefault()
            if (replyContext) {
                onClearReply()
            } else if (text) {
                setText("")
                draftCache.delete(cacheKey)
                if (textareaRef.current) textareaRef.current.style.height = '36px'
            } else {
                textareaRef.current?.blur()
            }
        }
    }

    const isChannelLocked = activeChannelTab !== 'all' || !!replyContext
    const hasText = text.trim().length > 0

    return (
        <div className="shrink-0 bg-white z-10 flex flex-col relative">
            
            {/* Quick Reply Suggestions (auto-suggest above input) */}
            <QuickReplySuggestions
                inputText={text}
                templates={templates}
                selectedIndex={suggestionIndex}
                onSelect={handleQuickReplySelect}
                visible={showSuggestions && !showQuickReplyPopover}
            />

            {/* Quick Reply Popover (⚡ menu) */}
            {showQuickReplyPopover && (
                <QuickReplyPopover
                    templates={templates}
                    onSelect={handleQuickReplySelect}
                    onUpdateTemplates={setTemplates}
                    onClose={() => setShowQuickReplyPopover(false)}
                />
            )}

            {/* Reply Context Badge */}
            {replyContext && (
                <div className="px-3 pt-2 pb-1 flex items-center gap-3 border-t border-[#E8E8E8]">
                    <div className="w-[3px] h-8 bg-[#3390EC] rounded-full shrink-0" />
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                            <span className="text-[12px] font-bold text-[#3390EC]">{replyContext.authorLabel}</span>
                            <span className="text-[10px] text-gray-400">{replyContext.timestamp}</span>
                        </div>
                        <div className="text-[13px] text-gray-500 truncate leading-tight mt-0.5">
                            {replyContext.snippet}
                        </div>
                    </div>
                    <button 
                        onClick={onClearReply}
                        className="w-6 h-6 flex text-gray-400 hover:text-gray-900 justify-center items-center hover:bg-gray-100 rounded-full transition-colors"
                    >
                        <X size={14} />
                    </button>
                </div>
            )}

            <div className={`flex items-end gap-1.5 px-2 py-1.5 ${!replyContext ? 'border-t border-[#E8E8E8]' : ''}`}>
                <button className="h-[36px] w-[36px] rounded-full hover:bg-gray-100 flex items-center justify-center text-gray-400 hover:text-gray-600 transition-colors shrink-0">
                    <Paperclip size={17} />
                </button>

                {/* ⚡ Quick Reply button */}
                <button 
                    onClick={() => setShowQuickReplyPopover(!showQuickReplyPopover)}
                    className={`h-[36px] w-[36px] rounded-full flex items-center justify-center transition-colors shrink-0 ${
                        showQuickReplyPopover 
                        ? 'bg-amber-100 text-amber-600' 
                        : 'hover:bg-gray-100 text-gray-400 hover:text-amber-500'
                    }`}
                    title="Быстрые ответы"
                >
                    <Zap size={16} />
                </button>

                {/* Channel + Account selector */}
                <div className="relative" ref={dropdownRef}>
                    <button 
                        onClick={() => !isChannelLocked && setChannelDropdownOpen(!channelDropdownOpen)}
                        disabled={isChannelLocked}
                        className={`h-[32px] px-2 rounded-lg flex items-center gap-1 text-[11px] font-bold transition-colors shrink-0 ${
                            isChannelLocked 
                            ? `${currentChannelInfo.bg} ${currentChannelInfo.color} cursor-default`
                            : `${currentChannelInfo.bg} ${currentChannelInfo.color} hover:opacity-80 cursor-pointer`
                        }`}
                    >
                        {currentChannelInfo.short}
                        {!isChannelLocked && <ChevronDown size={10} className="opacity-50" />}
                    </button>

                    {/* Dropdown popover */}
                    {channelDropdownOpen && (
                        <div className="absolute bottom-full left-0 mb-1 bg-white rounded-lg shadow-lg border border-[#E0E0E0] py-1 min-w-[160px] z-50 animate-in fade-in slide-in-from-bottom-1 duration-150">
                            <div className="px-3 py-1.5 text-[10px] font-bold text-gray-400 uppercase tracking-wider">Канал</div>
                            {CHANNELS.map(ch => (
                                <button
                                    key={ch.id}
                                    onClick={() => {
                                        setManualSendChannelMode(ch.id)
                                        setChannelDropdownOpen(false)
                                    }}
                                    className={`w-full px-3 h-[30px] flex items-center gap-2 text-[12px] font-medium hover:bg-gray-50 transition-colors ${
                                        effectiveNormalized === ch.id ? `${ch.color} bg-gray-50` : 'text-[#111]'
                                    }`}
                                >
                                    <span className={`w-2 h-2 rounded-full ${ch.activeBg}`} />
                                    {ch.label}
                                    {effectiveNormalized === ch.id && <span className="ml-auto text-[10px]">✓</span>}
                                </button>
                            ))}
                            <div className="h-px bg-[#E8E8E8] mx-2 my-1" />
                            <div className="px-3 py-1.5 text-[10px] font-bold text-gray-400 uppercase tracking-wider">Аккаунт</div>
                            <button className="w-full px-3 h-[30px] flex items-center gap-2 text-[12px] font-medium text-[#111] hover:bg-gray-50 transition-colors">
                                <div className="w-4 h-4 rounded-full bg-gray-200 flex items-center justify-center text-[8px] font-bold text-gray-500">Ю</div>
                                Основной аккаунт
                                <span className="ml-auto text-[10px] text-[#3390EC]">✓</span>
                            </button>
                        </div>
                    )}
                </div>

                <div className={`flex-1 bg-[#F4F5F7] rounded-[18px] flex items-end min-h-[36px] border border-transparent transition-colors ${
                    hasText ? 'focus-within:border-[#3390EC]/30 focus-within:bg-white' : 'focus-within:bg-[#EEEFF1]'
                } relative`}>
                    <textarea 
                        id="message-composer"
                        ref={textareaRef}
                        value={text}
                        onChange={(e) => {
                            handleTextChange(e.target.value)
                            handleInput()
                        }}
                        onKeyDown={handleKeyDown}
                        placeholder="Написать сообщение..." 
                        className="bg-transparent outline-none flex-1 text-[14px] placeholder-gray-400 py-[7px] px-4 resize-none w-full max-h-[120px] custom-scrollbar overflow-y-auto"
                        rows={1}
                    />
                </div>

                {/* Send button with clear state differentiation */}
                <button 
                    onClick={handleSend}
                    disabled={!hasText}
                    className={`h-[36px] w-[36px] rounded-full flex items-center justify-center transition-all shrink-0 ${
                        hasText 
                        ? 'bg-[#3390EC] text-white hover:bg-[#2B7FD4] active:scale-95 shadow-sm shadow-[#3390EC]/30' 
                        : 'bg-transparent text-gray-300 cursor-default'
                    }`}
                >
                    <SendHorizonal size={hasText ? 17 : 16} className="translate-x-[1px]" />
                </button>
            </div>
        </div>
    )
}
