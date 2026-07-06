"use client"

import { useState, useRef, useEffect, useMemo } from "react"
import { SendHorizonal, Paperclip, X, ChevronDown, Plus, Zap, Mic, Camera, CornerUpLeft } from "lucide-react"
import QuickReplySuggestions from "./QuickReplySuggestions"
import type { QuickReplyTemplate } from "./QuickReplySuggestions"
import QuickReplyPopover from "./QuickReplyPopover"
import ImproveDraftPopover from "./ImproveDraftPopover"
import EmojiPicker from "./EmojiPicker"

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
    onSendMedia?: (file: File, dataUrl: string, caption: string, channel: string) => Promise<void>
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
    onSendMedia,
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
    const [sendingFile, setSendingFile] = useState<{ name: string; mimeType: string } | null>(null)

    // Mic: hold to record, release to send. Camera: separate button, simple tap.
    const [isRecording, setIsRecording] = useState(false)
    const isRecordingRef = useRef(false)        // sync mirror — avoids stale closure in pointerup
    const shouldStopAfterStart = useRef(false)  // user released before getUserMedia resolved
    const [recordingSeconds, setRecordingSeconds] = useState(0)
    const mediaRecorderRef = useRef<MediaRecorder | null>(null)
    const audioChunksRef = useRef<Blob[]>([])
    const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
    const [imagePreview, setImagePreview] = useState<{ dataUrl: string; file: File } | null>(null)
    const [mediaCaption, setMediaCaption] = useState("")
    const [showEmojiPicker, setShowEmojiPicker] = useState(false)

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

    const handlePasteFile = (file: File) => {
        const reader = new FileReader()
        reader.onload = () => {
            setMediaCaption("")
            setImagePreview({ dataUrl: reader.result as string, file })
        }
        reader.readAsDataURL(file)
    }

    const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
        const { files, items } = e.clipboardData || {}
        // Files copied from filesystem (Ctrl+C in Explorer → Ctrl+V here)
        if (files && files.length > 0) {
            e.preventDefault()
            handlePasteFile(files[0])
            return
        }
        // Image data in clipboard (screenshots, Ctrl+C on an image in browser)
        if (items) {
            for (const item of Array.from(items)) {
                if (item.kind === 'file') {
                    e.preventDefault()
                    const file = item.getAsFile()
                    if (file) handlePasteFile(file)
                    return
                }
            }
        }
    }

    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        e.target.value = ''
        if (!file) return

        const reader = new FileReader()
        reader.onload = () => {
            setMediaCaption("")
            setImagePreview({ dataUrl: reader.result as string, file })
        }
        reader.readAsDataURL(file)
    }

    const handleSendImage = async () => {
        if (!imagePreview) return
        const { dataUrl, file } = imagePreview
        const captionText = mediaCaption.trim()
        setImagePreview(null)
        setMediaCaption("")
        setIsSendingImage(true)
        setSendingFile({ name: file.name, mimeType: file.type || 'application/octet-stream' })
        try {
            if (onSendMedia) {
                await onSendMedia(file, dataUrl, captionText, effectiveNormalized)
            } else {
                const base64 = dataUrl.split(',')[1]
                const res = await fetch('/api/messages/send-media', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chatId,
                        base64,
                        filename: file.name,
                        mimeType: file.type || 'application/octet-stream',
                        caption: captionText,
                    }),
                })
                if (!res.ok) {
                    const err = await res.json().catch(() => ({}))
                    console.error('[send-media] failed:', err)
                }
            }
        } catch (err) {
            console.error('[send-media] error:', err)
        } finally {
            setIsSendingImage(false)
            setSendingFile(null)
        }
    }

    // Enter отправляет медиа-превью (включая аудио — там нет текстового
    // input для caption, поэтому фокус остаётся вне поля, и onKeyDown на
    // самом input не сработал бы). Document-level listener покрывает все
    // случаи сразу, без дублирования с caption input — поэтому там Enter
    // не обрабатывается отдельно.
    useEffect(() => {
        if (!imagePreview) return
        const handleModalKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSendImage()
            } else if (e.key === 'Escape') {
                e.preventDefault()
                setImagePreview(null)
                setMediaCaption("")
            }
        }
        document.addEventListener('keydown', handleModalKeyDown)
        return () => document.removeEventListener('keydown', handleModalKeyDown)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [imagePreview])

    const handleEmojiSelect = (emoji: string) => {
        const textarea = textareaRef.current
        if (!textarea) {
            handleTextChange(text + emoji)
            return
        }
        const start = textarea.selectionStart ?? text.length
        const end   = textarea.selectionEnd   ?? text.length
        const newText = text.slice(0, start) + emoji + text.slice(end)
        handleTextChange(newText)
        // Restore cursor position after React re-render
        setTimeout(() => {
            textarea.focus()
            const pos = start + emoji.length
            textarea.setSelectionRange(pos, pos)
            textarea.style.height = 'auto'
            textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`
        }, 0)
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
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => { setImagePreview(null); setMediaCaption("") }}>
                <div className="bg-white rounded-2xl shadow-2xl p-[4px] max-w-sm w-full mx-[4px] flex flex-col gap-3" onClick={e => e.stopPropagation()}>
                    <div className="flex items-center justify-between">
                        <span className="font-semibold text-[15px] text-gray-800">{title}</span>
                        <button onClick={() => { setImagePreview(null); setMediaCaption("") }} className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-gray-100 text-gray-400 hover:text-gray-700">
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
                    {!isAudio && (
                        <input
                            type="text"
                            value={mediaCaption}
                            onChange={(e) => setMediaCaption(e.target.value)}
                            placeholder="Добавить подпись..."
                            autoFocus
                            className="w-full h-10 px-3 rounded-lg border border-gray-200 text-[14px] outline-none focus:border-[#3390EC] placeholder-gray-400"
                        />
                    )}
                    <div className="flex gap-[2px]">
                        <button onClick={() => { setImagePreview(null); setMediaCaption("") }} className="flex-1 h-10 rounded-xl border border-gray-200 text-gray-600 text-[14px] hover:bg-gray-50 transition-colors">
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

            {/* Reply Context Bar — Telegram style */}
            {replyContext && (
                <div className="mx-2 mt-1.5 mb-0.5 flex items-center gap-2 bg-[#EBF4FD] rounded-xl px-3 py-[7px]">
                    <CornerUpLeft size={15} className="text-[#2AABEE] shrink-0 mt-[1px]" />
                    <div className="w-[2.5px] self-stretch min-h-[28px] bg-[#2AABEE] rounded-full shrink-0" />
                    <div className="flex-1 min-w-0">
                        <div className="text-[12px] font-semibold text-[#2AABEE] truncate leading-tight">
                            {replyContext.authorLabel}
                        </div>
                        <div className="text-[12px] text-[#64748B] truncate leading-[1.3] mt-[1px]">
                            {replyContext.snippet || <span className="italic text-[#94A3B8]">Медиа</span>}
                        </div>
                    </div>
                    <button
                        onClick={onClearReply}
                        className="flex-shrink-0 w-7 h-7 flex items-center justify-center text-[#94A3B8] hover:text-[#475569] hover:bg-[#D5E8F8] rounded-full transition-colors"
                    >
                        <X size={15} />
                    </button>
                </div>
            )}

            {/* Sending progress bar — появляется пока идёт загрузка медиа */}
            {isSendingImage && sendingFile && (
                <div className="mx-2 mb-1 mt-1 flex items-center gap-2 bg-[#F0F8FF] rounded-xl px-3 py-2 border border-[#DAEEF9]">
                    <div className="w-4 h-4 rounded-full border-2 border-[#2AABEE]/30 border-t-[#2AABEE] animate-spin shrink-0" />
                    <div className="flex-1 min-w-0">
                        <div className="text-[12px] font-semibold text-[#2AABEE] leading-tight">Отправка файла...</div>
                        <div className="text-[12px] text-[#444] truncate leading-[1.3] mt-[1px]">{sendingFile.name}</div>
                    </div>
                </div>
            )}

            {/* FC-09: Channel hint line — служебная инфа «Отправка через MAX»,
                скрываем при reply (контекст уже виден в reply bar) и на мобиле. */}
            {channelHintReason && !replyContext && (
                <div className="hidden lg:flex items-center gap-1.5 px-3 py-1 border-t border-[#E8E8E8]">
                    <span className={`w-1.5 h-1.5 rounded-full ${currentChannelInfo.activeBg}`} />
                    <span className="text-[11px] text-gray-400">
                        Отправка через <span className={`font-medium ${currentChannelInfo.color}`}>{currentChannelInfo.label}</span>
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

                {/* 😊 Emoji picker button */}
                <div className="relative">
                    <button
                        onClick={() => setShowEmojiPicker(p => !p)}
                        className={`h-[36px] w-[36px] rounded-full flex items-center justify-center transition-colors shrink-0 text-[18px] leading-none ${
                            showEmojiPicker
                            ? 'bg-[#2AABEE]/15 text-[#2AABEE]'
                            : 'hover:bg-gray-100 text-gray-400'
                        }`}
                        title="Эмодзи"
                    >
                        😊
                    </button>
                    {showEmojiPicker && (
                        <EmojiPicker
                            onSelect={(emoji) => { handleEmojiSelect(emoji) }}
                            onClose={() => setShowEmojiPicker(false)}
                        />
                    )}
                </div>

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
                            onPaste={handlePaste}
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
