"use client"

import { useState, useRef, useEffect, useMemo } from "react"
import { SendHorizonal, Paperclip, X, ChevronDown, Plus, Zap, Mic, Camera } from "lucide-react"
import QuickReplySuggestions from "./QuickReplySuggestions"
import type { QuickReplyTemplate } from "./QuickReplySuggestions"
import QuickReplyPopover from "./QuickReplyPopover"
import ImproveDraftPopover from "./ImproveDraftPopover"

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
    externalId?: string
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
    /**
     * PR9.46 «AI стажёр»: триггер при фокусе в textarea. Родитель
     * (ChatWorkspace) дёргает proposed-reply generation. Дёшево и
     * безопасно — hook сам дедуплицирует повторные вызовы.
     */
    onTextareaFocus?: () => void
    /**
     * PR9.46: текст для предзаполнения textarea. Когда менеджер
     * нажимает «Взять в работу» в AiProposedReplyBubble, родитель
     * передаёт сюда текст черновика + увеличивает prefillToken.
     */
    prefillText?: string
    /**
     * PR9.46: увеличиваемый счётчик — каждое увеличение триггерит
     * установку prefillText в textarea (даже если текст тот же).
     * Нужен потому что useEffect на `prefillText` не сработает если
     * текст не изменился.
     */
    prefillToken?: number
}

const CHANNELS = [
    { id: 'whatsapp', label: 'WhatsApp', short: 'WA', color: 'text-emerald-600', bg: 'bg-emerald-50', activeBg: 'bg-emerald-500' },
    { id: 'telegram', label: 'Telegram', short: 'TG', color: 'text-blue-600', bg: 'bg-blue-50', activeBg: 'bg-blue-500' },
    { id: 'max', label: 'MAX', short: 'MAX', color: 'text-purple-600', bg: 'bg-purple-50', activeBg: 'bg-purple-500' },
]

export default function MessageInputArea({
    chatId,
    activeChannelTab,
    replyContext,
    onClearReply,
    manualSendChannelMode,
    setManualSendChannelMode,
    onSendMessage,
    onTextareaFocus,
    prefillText,
    prefillToken,
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
    const fileInputRef = useRef<HTMLInputElement>(null)
    const cameraInputRef = useRef<HTMLInputElement>(null)
    const isTouchDevice = useRef(false)
    const [isSendingImage, setIsSendingImage] = useState(false)

    // Mic: hold to record, release to send. Camera: separate button, simple tap.
    const [isRecording, setIsRecording] = useState(false)
    const isRecordingRef = useRef(false)        // sync mirror — avoids stale closure in pointerup
    const shouldStopAfterStart = useRef(false)  // user released before getUserMedia resolved
    const [recordingSeconds, setRecordingSeconds] = useState(0)
    const mediaRecorderRef = useRef<MediaRecorder | null>(null)
    const audioChunksRef = useRef<Blob[]>([])
    const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
    const [imagePreview, setImagePreview] = useState<{ dataUrl: string; file: File } | null>(null)

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

    // PR9.46 «AI стажёр»: prefill из AI-черновика по клику «Взять в работу».
    // Token-based trigger — каждое увеличение prefillToken вызывает setText +
    // фокус курсора в конец, даже если текст тот же что был.
    useEffect(() => {
        if (prefillToken == null || prefillToken === 0) return
        if (prefillText == null) return
        setText(prefillText)
        draftCache.set(cacheKey, prefillText)
        setTimeout(() => {
            if (textareaRef.current) {
                textareaRef.current.focus()
                const len = prefillText.length
                textareaRef.current.setSelectionRange(len, len)
                textareaRef.current.style.height = 'auto'
                const scrollHeight = textareaRef.current.scrollHeight
                textareaRef.current.style.height = `${Math.min(scrollHeight, 120)}px`
            }
        }, 10)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [prefillToken])

    useEffect(() => {
        isTouchDevice.current = window.matchMedia('(pointer: coarse)').matches
    }, [])

    // Cleanup recording on unmount
    useEffect(() => {
        return () => {
            if (recordingTimerRef.current) clearInterval(recordingTimerRef.current)
        }
    }, [])

    const formatRecTime = (s: number) =>
        `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`

    const startRecording = async () => {
        if (!navigator.mediaDevices?.getUserMedia) return
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
            const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']
                .find(t => MediaRecorder.isTypeSupported(t)) || 'audio/webm'
            const recorder = new MediaRecorder(stream, { mimeType })
            audioChunksRef.current = []
            recorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data) }
            recorder.onstop = () => {
                stream.getTracks().forEach(t => t.stop())
                const blob = new Blob(audioChunksRef.current, { type: mimeType })
                const reader = new FileReader()
                reader.onload = () => {
                    const dataUrl = reader.result as string
                    const file = new File([blob], 'voice_message.webm', { type: mimeType })
                    setImagePreview({ dataUrl, file })
                }
                reader.readAsDataURL(blob)
            }
            recorder.start()
            mediaRecorderRef.current = recorder
            isRecordingRef.current = true
            setIsRecording(true)
            setRecordingSeconds(0)
            recordingTimerRef.current = setInterval(() => setRecordingSeconds(s => s + 1), 1000)
            // User released before getUserMedia resolved — stop immediately
            if (shouldStopAfterStart.current) {
                shouldStopAfterStart.current = false
                stopRecording()
            }
        } catch {
            shouldStopAfterStart.current = false
        }
    }

    const stopRecording = () => {
        if (mediaRecorderRef.current?.state === 'recording') mediaRecorderRef.current.stop()
        isRecordingRef.current = false
        setIsRecording(false)
        if (recordingTimerRef.current) { clearInterval(recordingTimerRef.current); recordingTimerRef.current = null }
    }

    const cancelRecording = () => {
        shouldStopAfterStart.current = false
        audioChunksRef.current = []
        if (mediaRecorderRef.current) {
            mediaRecorderRef.current.ondataavailable = null
            mediaRecorderRef.current.onstop = null
            if (mediaRecorderRef.current.state === 'recording') {
                mediaRecorderRef.current.stream?.getTracks().forEach(t => t.stop())
                mediaRecorderRef.current.stop()
            }
            mediaRecorderRef.current = null
        }
        isRecordingRef.current = false
        setIsRecording(false)
        if (recordingTimerRef.current) { clearInterval(recordingTimerRef.current); recordingTimerRef.current = null }
    }

    // Mic button: pointerdown = start instantly, pointerup = stop+send, cancel = discard
    const handleMicPointerDown = (e: React.PointerEvent) => {
        e.preventDefault()
        shouldStopAfterStart.current = false
        startRecording()
    }

    const handleMicPointerUp = () => {
        if (isRecordingRef.current) {
            stopRecording()
        } else {
            // getUserMedia still resolving — flag to stop as soon as it starts
            shouldStopAfterStart.current = true
        }
    }

    const handleMicPointerCancel = () => {
        cancelRecording()
    }

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

    const normalizeChannel = (ch: string) => ch === 'wa' ? 'whatsapp' : ch === 'tg' ? 'telegram' : ch
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
        onSendMessage(text.trim(), effectiveNormalized)
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

        if (e.key === 'Enter' && !e.shiftKey && !isTouchDevice.current) {
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

    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        e.target.value = ''
        if (!file) return

        const reader = new FileReader()
        reader.onload = () => {
            setImagePreview({ dataUrl: reader.result as string, file })
        }
        reader.readAsDataURL(file)
    }

    const handleSendImage = async () => {
        if (!imagePreview) return
        const { dataUrl, file } = imagePreview
        setImagePreview(null)
        setIsSendingImage(true)
        try {
            const base64 = dataUrl.split(',')[1]
            const res = await fetch('/api/messages/send-media', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chatId,
                    base64,
                    filename: file.name,
                    mimeType: file.type || 'application/octet-stream',
                    caption: text.trim() || '',
                }),
            })
            if (!res.ok) {
                const err = await res.json().catch(() => ({}))
                console.error('[send-media] failed:', err)
            } else {
                setText('')
                draftCache.delete(cacheKey)
            }
        } catch (err) {
            console.error('[send-media] error:', err)
        } finally {
            setIsSendingImage(false)
        }
    }

    const isChannelLocked = activeChannelTab !== 'all' || !!replyContext
    const hasText = text.trim().length > 0

    // FC-09: channel hint — explain why this channel is selected
    const channelHintReason = replyContext
        ? 'ответ'
        : activeChannelTab !== 'all'
            ? 'вкладка'
            : manualSendChannelMode
                ? 'выбран'
                : null

    return (
        <>
        {/* Media preview modal */}
        {imagePreview && (() => {
            const mt = imagePreview.file.type || ''
            const isImage = mt.startsWith('image/')
            const isVideo = mt.startsWith('video/')
            const isAudio = mt.startsWith('audio/')
            const title = isImage ? 'Отправить фото' : isVideo ? 'Отправить видео' : isAudio ? 'Отправить аудио' : 'Отправить файл'
            const fileSizeKb = Math.round(imagePreview.file.size / 1024)
            return (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setImagePreview(null)}>
                <div className="bg-white rounded-2xl shadow-2xl p-[4px] max-w-sm w-full mx-[4px] flex flex-col gap-3" onClick={e => e.stopPropagation()}>
                    <div className="flex items-center justify-between">
                        <span className="font-semibold text-[15px] text-gray-800">{title}</span>
                        <button onClick={() => setImagePreview(null)} className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-gray-100 text-gray-400 hover:text-gray-700">
                            <X size={16} />
                        </button>
                    </div>
                    {isImage ? (
                        <img src={imagePreview.dataUrl} alt="preview" className="w-full max-h-[320px] object-contain rounded-lg bg-gray-50" />
                    ) : isVideo ? (
                        <video src={imagePreview.dataUrl} controls className="w-full max-h-[320px] rounded-lg bg-gray-50" />
                    ) : isAudio ? (
                        <audio src={imagePreview.dataUrl} controls className="w-full" />
                    ) : (
                        <div className="flex items-center gap-3 p-3 rounded-lg bg-gray-50 border border-gray-200">
                            <div className="w-10 h-10 rounded-lg bg-[#3390EC]/10 flex items-center justify-center text-[#3390EC]">
                                <Paperclip size={20} />
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className="truncate text-[14px] font-medium text-gray-800">{imagePreview.file.name}</div>
                                <div className="text-[12px] text-gray-500">{fileSizeKb} KB</div>
                            </div>
                        </div>
                    )}
                    <div className="flex gap-[2px]">
                        <button onClick={() => setImagePreview(null)} className="flex-1 h-10 rounded-xl border border-gray-200 text-gray-600 text-[14px] hover:bg-gray-50 transition-colors">
                            Отмена
                        </button>
                        <button onClick={handleSendImage} className="flex-1 h-10 rounded-xl bg-[#3390EC] text-white text-[14px] font-medium hover:bg-[#2B7FD4] transition-colors">
                            Отправить
                        </button>
                    </div>
                </div>
            </div>
            )
        })()}
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
                <div className="px-3 pt-[2px] pb-1 flex items-center gap-3 border-t border-[#E8E8E8]">
                    <div className="w-[3px] h-[8px] bg-[#3390EC] rounded-full shrink-0" />
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-[2px]">
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

            {/* FC-09: Channel hint line — служебная инфа «Отправка через MAX»,
                на мобиле скрываем (канал и так виден в табах сверху). */}
            {channelHintReason && (
                <div className={`hidden lg:flex items-center gap-1.5 px-3 py-1 ${!replyContext ? 'border-t border-[#E8E8E8]' : ''}`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${currentChannelInfo.activeBg}`} />
                    <span className="text-[11px] text-gray-400">
                        Отправка через <span className={`font-medium ${currentChannelInfo.color}`}>{currentChannelInfo.label}</span>
                        {channelHintReason === 'ответ' && <span className="text-gray-300"> · ответ на сообщение</span>}
                        {channelHintReason === 'вкладка' && <span className="text-gray-300"> · по вкладке канала</span>}
                    </span>
                </div>
            )}

            <div className={`flex items-end gap-1.5 px-[2px] py-1.5 ${!replyContext && !channelHintReason ? 'border-t border-[#E8E8E8]' : ''}`}>
                <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.txt,.zip,.rar"
                    className="hidden"
                    onChange={handleFileSelect}
                />
                {/* Скрепка: на ПК слева (как было), на мобиле скрыта здесь и
                    показана справа у поля ввода — как в Telegram. */}
                <button
                    className={`hidden lg:flex h-[36px] w-[36px] rounded-full hover:bg-gray-100 items-center justify-center transition-colors shrink-0 ${isSendingImage ? 'text-purple-500 animate-pulse' : 'text-gray-400 hover:text-gray-600'}`}
                    onClick={() => fileInputRef.current?.click()}
                    title="Прикрепить файл"
                >
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

                {/* PR-Т: ✨ «Улучшить с ИИ» — popover с пресетами + diff preview.
                    Активна только когда в input есть осмысленный черновик. */}
                <div className="relative">
                    <ImproveDraftPopover
                        chatId={chatId}
                        draft={text}
                        onApply={(improved) => handleTextChange(improved)}
                    />
                </div>

                {/* Channel + Account selector — на мобиле скрыт (канал виден в табах
                    сверху, дублировать пиктограмму внизу незачем). */}
                <div className="relative hidden lg:block" ref={dropdownRef}>
                    <button 
                        onClick={() => !isChannelLocked && setChannelDropdownOpen(!channelDropdownOpen)}
                        disabled={isChannelLocked}
                        className={`h-[32px] px-[2px] rounded-lg flex items-center gap-1 text-[11px] font-bold transition-colors shrink-0 ${
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
                                    className={`w-full px-3 h-[30px] flex items-center gap-[2px] text-[12px] font-medium hover:bg-gray-50 transition-colors ${
                                        effectiveNormalized === ch.id ? `${ch.color} bg-gray-50` : 'text-[#111]'
                                    }`}
                                >
                                    <span className={`w-[2px] h-[2px] rounded-full ${ch.activeBg}`} />
                                    {ch.label}
                                    {effectiveNormalized === ch.id && <span className="ml-auto text-[10px]">✓</span>}
                                </button>
                            ))}
                            <div className="h-px bg-[#E8E8E8] mx-[2px] my-1" />
                            <div className="px-3 py-1.5 text-[10px] font-bold text-gray-400 uppercase tracking-wider">Аккаунт</div>
                            <button className="w-full px-3 h-[30px] flex items-center gap-[2px] text-[12px] font-medium text-[#111] hover:bg-gray-50 transition-colors">
                                <div className="w-[4px] h-[4px] rounded-full bg-gray-200 flex items-center justify-center text-[8px] font-bold text-gray-500">Ю</div>
                                Основной аккаунт
                                <span className="ml-auto text-[10px] text-[#3390EC]">✓</span>
                            </button>
                        </div>
                    )}
                </div>

                {isRecording ? (
                    /* Recording overlay replaces textarea */
                    <div className="flex-1 bg-red-50 rounded-[18px] flex items-center px-3 min-h-[36px] border border-red-200 gap-2">
                        <button
                            onClick={cancelRecording}
                            className="w-[20px] h-[20px] rounded-full bg-red-200 hover:bg-red-300 flex items-center justify-center shrink-0 transition-colors"
                            title="Отменить запись"
                        >
                            <X size={11} className="text-red-600" />
                        </button>
                        <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse shrink-0" />
                        <span className="text-[13px] font-medium text-red-600 flex-1">{formatRecTime(recordingSeconds)}</span>
                        <span className="text-[11px] text-gray-400 hidden xs:inline">Отпустите → отправить</span>
                    </div>
                ) : (
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
                            onFocus={onTextareaFocus}
                            placeholder="Написать сообщение..."
                            className="bg-transparent outline-none flex-1 text-[14px] placeholder-gray-400 py-[7px] px-[4px] resize-none w-full max-h-[120px] custom-scrollbar overflow-y-auto"
                            rows={1}
                        />
                    </div>
                )}

                {/* Hidden camera/file input — triggered by the camera label below */}
                <input
                    id="msg-camera-input"
                    ref={cameraInputRef}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    className="hidden"
                    onChange={handleFileSelect}
                />

                {/* Mobile: скрепка когда нет текста и не идёт запись */}
                <button
                    className={`${hasText || isRecording ? 'hidden' : 'flex'} lg:hidden h-[36px] w-[36px] rounded-full hover:bg-gray-100 items-center justify-center transition-colors shrink-0 ${isSendingImage ? 'text-purple-500 animate-pulse' : 'text-gray-400'}`}
                    onClick={() => fileInputRef.current?.click()}
                    title="Прикрепить файл"
                >
                    <Paperclip size={18} />
                </button>

                {/* Send button: mobile — only when has text; desktop — always */}
                <button
                    onClick={handleSend}
                    disabled={!hasText}
                    className={`h-[36px] w-[36px] rounded-full items-center justify-center transition-all shrink-0 ${
                        hasText
                        ? 'flex bg-[#3390EC] text-white hover:bg-[#2B7FD4] active:scale-95'
                        : 'hidden lg:flex bg-transparent text-gray-300 cursor-default'
                    }`}
                >
                    <SendHorizonal size={17} className="translate-x-[1px]" />
                </button>

                {/* Camera — simple tap; скрыта пока идёт запись */}
                {!isRecording && (
                    <label
                        htmlFor="msg-camera-input"
                        className="lg:hidden h-[36px] w-[36px] rounded-full flex items-center justify-center shrink-0 cursor-pointer text-gray-400 hover:bg-gray-100 active:bg-gray-200 transition-colors"
                        title="Камера"
                    >
                        <Camera size={18} />
                    </label>
                )}

                {/* Mic — ВСЕГДА в DOM, иначе pointerup не придёт после начала записи.
                    Меняет цвет на синий во время записи. */}
                <button
                    className={`lg:hidden h-[36px] w-[36px] rounded-full flex items-center justify-center shrink-0 select-none touch-none transition-colors ${
                        isRecording
                            ? 'bg-[#3390EC] text-white'
                            : 'text-gray-400 hover:bg-gray-100 active:bg-gray-200'
                    }`}
                    onPointerDown={handleMicPointerDown}
                    onPointerUp={handleMicPointerUp}
                    onPointerCancel={handleMicPointerCancel}
                    title={isRecording ? "Отпустите чтобы отправить" : "Удерживайте для записи голоса"}
                >
                    <Mic size={18} />
                </button>
            </div>
        </div>
        </>
    )
}
