"use client"

import { useState, useEffect } from "react"
import { X, Phone, UserCheck, ClipboardList, MoreHorizontal, ExternalLink, Plus, Archive, Ban, ChevronDown, Calendar, Pencil, Trash2, Check, Star, MessageSquare, Send, Loader2, GitMerge, Search } from "lucide-react"
import { useChatNavigation } from "../hooks/useChatNavigation"
import { useConversations, refreshConversations } from "../hooks/useConversations"
import { useContactSearch } from "../hooks/useContactSearch"
import { useContact, type Contact, type ContactIdentity } from "../hooks/useContact"
import { useChannelStatus } from "../hooks/useChannelStatus"
import { AlertCircle } from "lucide-react"
import DriverTasksWidget from "./DriverTasksWidget"
import TaskCreateModal from "@/app/tasks/components/TaskCreateModal"

// Custom field types
interface CustomField {
    id: string
    label: string
    type: 'text' | 'select' | 'multi-select' | 'date'
    value: string | string[]
    options?: string[]
}

const defaultCustomFields: CustomField[] = [
    { id: 'park', label: 'Парк', type: 'select', value: 'Яндекс', options: ['Яндекс', 'Uber', 'Сити Мобил', 'Максим'] },
    { id: 'role', label: 'Роль', type: 'select', value: 'Водитель', options: ['Водитель', 'Курьер', 'Партнёр', 'Стажёр'] },
    { id: 'city', label: 'Город', type: 'text', value: '' },
    { id: 'start_date', label: 'Дата начала', type: 'date', value: '' },
]

// Channel display config
const CHANNEL_CONFIG: Record<string, { label: string; icon: string; color: string; dotColor: string }> = {
    whatsapp:   { label: 'WhatsApp',   icon: '📱', color: 'text-emerald-700 bg-emerald-50', dotColor: 'bg-emerald-500' },
    telegram:   { label: 'Telegram',   icon: '✈️',  color: 'text-blue-700 bg-blue-50',      dotColor: 'bg-blue-500' },
    max:        { label: 'MAX',        icon: '💬', color: 'text-purple-700 bg-purple-50',  dotColor: 'bg-purple-500' },
    yandex_pro: { label: 'Яндекс.Про', icon: '🚕', color: 'text-yellow-700 bg-yellow-50', dotColor: 'bg-yellow-500' },
}

const SOURCE_LABELS: Record<string, { label: string; color: string }> = {
    yandex: { label: 'Яндекс', color: 'bg-yellow-50 text-yellow-700' },
    chat:   { label: 'Чат',    color: 'bg-blue-50 text-blue-700' },
    manual: { label: 'Ручной', color: 'bg-gray-100 text-gray-600' },
}

function formatPhone(phone: string): string {
    // +79221234567 → +7 922 215-57-50
    if (phone.length === 12 && phone.startsWith('+7')) {
        return `+7 ${phone.slice(2, 5)} ${phone.slice(5, 8)}-${phone.slice(8, 10)}-${phone.slice(10)}`
    }
    return phone
}

export default function ContactProfileDrawer({ chatId }: { chatId: string }) {
    const { toggleProfileDrawer, updateQuery } = useChatNavigation()
    const { conversations } = useConversations()
    const chat = conversations.find(c => c.id === chatId || c.allChatIds?.includes(chatId))
    const { contact, isLoading: contactLoading, refetch: refetchContact } = useContact(chat?.contactId)
    const { channelStatus } = useChannelStatus(contact?.id)

    const [tags, setTags] = useState<string[]>([])
    const [tagInput, setTagInput] = useState("")
    const [showTagInput, setShowTagInput] = useState(false)
    const [showMoreMenu, setShowMoreMenu] = useState(false)
    const [showMergeDialog, setShowMergeDialog] = useState(false)
    const [mergeSearch, setMergeSearch] = useState("")
    const [mergeTarget, setMergeTarget] = useState<any>(null)
    const [mergeMode, setMergeMode] = useState<'contact' | 'driver' | null>(null)
    const [mergeLoading, setMergeLoading] = useState(false)
    const [mergeError, setMergeError] = useState<string | null>(null)
    const [mergeSuccess, setMergeSuccess] = useState(false)
    const { results: mergeSearchResults, loading: mergeSearchLoading } = useContactSearch(showMergeDialog ? mergeSearch : '')
    const [customFields, setCustomFields] = useState<CustomField[]>(defaultCustomFields)
    const [editingFieldId, setEditingFieldId] = useState<string | null>(null)
    const [editingFieldValue, setEditingFieldValue] = useState("")
    const [showAddField, setShowAddField] = useState(false)
    const [newFieldLabel, setNewFieldLabel] = useState("")
    const [newFieldType, setNewFieldType] = useState<'text' | 'select' | 'date'>('text')
    const [aiStatus, setAiStatus] = useState<'active' | 'paused' | 'inactive'>('inactive')
    const [isTaskModalOpen, setIsTaskModalOpen] = useState(false)
    const [writingIdentityId, setWritingIdentityId] = useState<string | null>(null)

    // Reachability: merge persisted status from DB with optional live-check override
    const [liveReachability, setLiveReachability] = useState<Record<string, boolean | null>>({})

    useEffect(() => {
        if (!contact) return
        const primaryPhone = contact.phones.find(p => p.isPrimary)?.phone || contact.phones[0]?.phone
        if (!primaryPhone) return

        let cancelled = false
        const checkChannels = ['telegram', 'whatsapp'] as const

        for (const channel of checkChannels) {
            fetch('/api/channels/check-reachability', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone: primaryPhone, channel }),
            })
                .then(r => r.json())
                .then(data => {
                    if (cancelled) return
                    // Only override if we got a definitive answer (not soft fallback)
                    if (data.reachable === false || data.telegramId) {
                        setLiveReachability(prev => ({ ...prev, [channel]: data.reachable }))
                    }
                })
                .catch(() => {})
        }

        return () => { cancelled = true }
    }, [contact?.id])

    /** Get effective reachability for a channel: live > persisted > null */
    const getReachability = (identity: ContactIdentity): boolean | null => {
        // Live check result takes priority (if definitive)
        if (liveReachability[identity.channel] !== undefined) {
            return liveReachability[identity.channel]
        }
        // Fall back to persisted status from DB
        if (identity.reachabilityStatus === 'confirmed') return true
        if (identity.reachabilityStatus === 'unreachable') return false
        return null // unknown
    }

    if (!chat) return null

    // Determine display data: Contact > Driver > Chat fallback
    const displayName = contact?.displayName || chat.driver?.fullName || chat.name || 'Водитель'
    const masterSource = contact?.masterSource || (chat.driver ? 'yandex' : 'chat')
    const sourceInfo = SOURCE_LABELS[masterSource] || SOURCE_LABELS.chat
    const contactOrDriverId = contact?.id || chat.driver?.id

    const handleAddTag = () => {
        if (tagInput.trim() && !tags.includes(tagInput.trim())) {
            setTags([...tags, tagInput.trim()])
            setTagInput("")
            setShowTagInput(false)
        }
    }
    const handleRemoveTag = (tag: string) => setTags(tags.filter(t => t !== tag))

    const handleFieldSave = (fieldId: string, newValue: string) => {
        setCustomFields(fields => fields.map(f => f.id === fieldId ? { ...f, value: newValue } : f))
        setEditingFieldId(null)
    }
    const handleFieldDelete = (fieldId: string) => setCustomFields(fields => fields.filter(f => f.id !== fieldId))
    const handleAddField = () => {
        if (!newFieldLabel.trim()) return
        setCustomFields([...customFields, { id: `custom-${Date.now()}`, label: newFieldLabel.trim(), type: newFieldType, value: '', options: newFieldType === 'select' ? ['Вариант 1', 'Вариант 2'] : undefined }])
        setNewFieldLabel(""); setNewFieldType('text'); setShowAddField(false)
    }

    const CHANNEL_SHORT: Record<string, string> = { whatsapp: 'wa', telegram: 'tg', max: 'max', yandex_pro: 'yp' }

    // ── Handle "Написать" — works with identity OR phone+channel ──
    const handleWrite = async (channel: string, identityId?: string) => {
        if (!contact || channel === 'yandex_pro') return

        // If identityId provided, check for existing chat
        if (identityId) {
            const existingChat = contact.chats.find(c => c.contactIdentityId === identityId)
            if (existingChat) {
                updateQuery({ id: existingChat.id, channel: CHANNEL_SHORT[channel] || null })
                return
            }
        }

        // Create chat via API (will also create identity if needed)
        setWritingIdentityId(identityId || `phone_${channel}`)
        try {
            const res = await fetch(`/api/contacts/${contact.id}/chats`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    channel,
                    ...(identityId ? { identityId } : {}),
                }),
            })
            const data = await res.json()
            if (res.ok && data.chat) {
                updateQuery({ id: data.chat.id, channel: CHANNEL_SHORT[channel] || null })
                refetchContact()
            } else {
                console.error('[ContactProfile] Create chat error:', data.error)
            }
        } catch (e: any) {
            console.error('[ContactProfile] Create chat failed:', e.message)
        } finally {
            setWritingIdentityId(null)
        }
    }

    // ── Group identities by phone ─────────────────────────────
    const phonesWithIdentities = contact ? contact.phones.map(phone => ({
        phone,
        identities: contact.identities.filter(i => i.phoneId === phone.id),
    })) : []
    const orphanIdentities = contact ? contact.identities.filter(i => !i.phoneId) : []

    return (
        <div className="w-[280px] bg-white border-l border-[#E8E8E8] shrink-0 h-full flex flex-col animate-in slide-in-from-right-4 duration-200">
            {/* Header */}
            <div className="h-[44px] border-b border-[#E8E8E8] flex items-center justify-between px-4 shrink-0">
                <span className="text-[13px] font-semibold text-[#111]">Профиль</span>
                <button onClick={() => toggleProfileDrawer(false)} className="w-6 h-6 rounded-full hover:bg-gray-100 flex items-center justify-center text-gray-400 hover:text-gray-700 transition-colors">
                    <X size={14} />
                </button>
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar">
                {/* Contact Card */}
                <div className="px-4 pt-4 pb-3 flex flex-col items-center text-center">
                    <div className="w-14 h-14 rounded-full bg-[#3390EC] text-white flex items-center justify-center text-[20px] font-bold mb-2">
                        {displayName.substring(0, 2).toUpperCase()}
                    </div>
                    <h3 className="text-[15px] font-semibold text-[#111]">{displayName}</h3>
                    <div className="flex items-center gap-1 mt-1.5 flex-wrap justify-center">
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${sourceInfo.color}`}>
                            {sourceInfo.label}
                        </span>
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${
                            chat.status === 'open' || chat.status === 'waiting_customer' ? 'bg-green-50 text-green-700' :
                            chat.status === 'new' ? 'bg-blue-50 text-blue-700' :
                            chat.status === 'resolved' ? 'bg-gray-100 text-gray-500' :
                            'bg-gray-100 text-gray-600'
                        }`}>
                            {chat.status === 'open' ? 'В работе' : chat.status === 'new' ? 'Новый' : chat.status === 'waiting_customer' ? 'Ожидаем клиента' : chat.status === 'waiting_internal' ? 'Внутренний' : chat.status === 'resolved' ? 'Завершён' : chat.status}
                        </span>
                        {contact && contact.identities.length > 1 && (
                            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-600">
                                {contact.identities.length} канала
                            </span>
                        )}
                        {contact && contact.mergeHistory && contact.mergeHistory.length > 0 && (
                            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-violet-50 text-violet-600">
                                Объединён
                            </span>
                        )}
                    </div>
                </div>

                {/* Quick Actions */}
                <div className="px-3 pb-2 flex gap-1.5">
                    <button
                        onClick={() => { if (contactOrDriverId) setIsTaskModalOpen(true) }}
                        className={`flex-1 h-[30px] text-white text-[11px] font-semibold rounded-lg transition-colors flex items-center justify-center gap-1 ${
                            contactOrDriverId ? 'bg-[#3390EC] hover:bg-[#2B7FD4]' : 'bg-gray-300 cursor-not-allowed'
                        }`}
                        title={!contactOrDriverId ? 'Контакт не привязан' : ''}
                    >
                        <ClipboardList size={11} /> Задача
                    </button>
                    <button className="flex-1 h-[30px] bg-gray-100 text-gray-700 text-[11px] font-semibold rounded-lg hover:bg-gray-200 transition-colors flex items-center justify-center gap-1">
                        <UserCheck size={11} /> Назначить
                    </button>
                    <button
                        onClick={() => { setShowMergeDialog(true); setMergeMode(null); setMergeTarget(null); setMergeError(null); setMergeSuccess(false); setMergeSearch('') }}
                        className="flex-1 h-[30px] bg-gray-100 text-gray-700 text-[11px] font-semibold rounded-lg hover:bg-gray-200 transition-colors flex items-center justify-center gap-1"
                        title="Объединить контакт"
                    >
                        <GitMerge size={11} /> Объединить
                    </button>
                    <div className="relative">
                        <button onClick={() => setShowMoreMenu(!showMoreMenu)} className="h-[30px] w-[30px] bg-gray-100 text-gray-500 rounded-lg hover:bg-gray-200 transition-colors flex items-center justify-center">
                            <MoreHorizontal size={13} />
                        </button>
                        {showMoreMenu && (
                            <div className="absolute right-0 top-full mt-1 bg-white rounded-lg shadow-lg border border-[#E0E0E0] py-1 min-w-[160px] z-50 animate-in fade-in slide-in-from-top-1 duration-150">
                                <button className="w-full px-3 h-[30px] flex items-center gap-2 text-[12px] text-[#111] hover:bg-gray-50">
                                    <ExternalLink size={12} /> Открыть в CRM
                                </button>
                                <button className="w-full px-3 h-[30px] flex items-center gap-2 text-[12px] text-[#111] hover:bg-gray-50">
                                    <Archive size={12} /> Архивировать
                                </button>
                                <div className="h-px bg-[#E8E8E8] mx-2 my-0.5" />
                                <button className="w-full px-3 h-[30px] flex items-center gap-2 text-[12px] text-red-500 hover:bg-red-50">
                                    <Ban size={12} /> Заблокировать
                                </button>
                            </div>
                        )}
                    </div>
                </div>

                <div className="h-px bg-[#E8E8E8] mx-3" />

                {/* ── Phones & Channels (Contact Model) ──────────────── */}
                {contactLoading ? (
                    <div className="px-4 py-3">
                        <div className="animate-pulse space-y-2">
                            <div className="h-3 bg-gray-200 rounded w-24" />
                            <div className="h-8 bg-gray-100 rounded" />
                            <div className="h-8 bg-gray-100 rounded" />
                        </div>
                    </div>
                ) : contact ? (
                    <div className="px-4 py-2.5">
                        <h4 className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">Телефоны и каналы</h4>

                        {phonesWithIdentities.length === 0 && orphanIdentities.length === 0 && (
                            <div className="text-[12px] text-gray-400 italic">Нет активных каналов связи</div>
                        )}

                        {/* Phones with their identities + available channels */}
                        {phonesWithIdentities.map(({ phone, identities }) => {
                            // Channels that have identity for this phone
                            const existingChannels = new Set(identities.map(i => i.channel))
                            // Channels available via phone but without identity yet
                            const phoneChannels: string[] = ['whatsapp', 'telegram', 'max']
                            const missingChannels = phoneChannels.filter(ch => !existingChannels.has(ch))

                            return (
                                <div key={phone.id} className="mb-2.5">
                                    <div className="flex items-center gap-1.5 mb-1">
                                        <Phone size={11} className="text-gray-400" />
                                        <span className="text-[12px] font-medium text-[#111] font-mono">
                                            {formatPhone(phone.phone)}
                                        </span>
                                        {phone.isPrimary && (
                                            <Star size={10} className="text-yellow-500 fill-yellow-500" />
                                        )}
                                    </div>
                                    <div className="ml-4 space-y-0.5">
                                        {/* Existing identities */}
                                        {identities.map(identity => {
                                            const cfg = CHANNEL_CONFIG[identity.channel]
                                            const isYandex = identity.channel === 'yandex_pro'
                                            const isWriting = writingIdentityId === identity.id
                                            const chStatus = channelStatus[identity.channel]
                                            const hasFailed = chStatus?.status === 'failed'
                                            const isCheckable = identity.channel === 'telegram' || identity.channel === 'whatsapp'
                                            const reachable = getReachability(identity)
                                            return (
                                                <div key={identity.id}>
                                                    <div className="flex items-center justify-between h-[26px]">
                                                        <div className="flex items-center gap-1.5">
                                                            {isCheckable && reachable !== undefined ? (
                                                                <span className={`inline-block w-[7px] h-[7px] rounded-full ${reachable ? 'bg-emerald-500' : 'bg-red-500'}`} title={reachable ? 'Номер найден' : 'Номер не найден'} />
                                                            ) : (
                                                                <span className="inline-block w-[7px] h-[7px] rounded-full bg-gray-300" title="Проверка недоступна" />
                                                            )}
                                                            <span className="text-[11px]">{cfg?.icon || '?'}</span>
                                                            <span className="text-[11px] text-gray-600">{cfg?.label || identity.channel}</span>
                                                            {identity.source === 'auto' && contact && contact.identities.length > 1 && (
                                                                <span className="text-[8px] text-gray-400 bg-gray-50 px-1 py-px rounded" title="Канал привязан автоматически по номеру телефона">авто</span>
                                                            )}
                                                            {identity.source === 'manual' && (
                                                                <span className="text-[8px] text-violet-400 bg-violet-50 px-1 py-px rounded" title="Канал добавлен вручную">ручной</span>
                                                            )}
                                                            {hasFailed && <AlertCircle size={10} className="text-red-500" />}
                                                        </div>
                                                        {!isYandex && (
                                                            <button
                                                                onClick={() => handleWrite(identity.channel, identity.id)}
                                                                disabled={isWriting}
                                                                className="text-[10px] text-[#3390EC] font-semibold px-2 py-0.5 rounded bg-[#3390EC]/5 hover:bg-[#3390EC]/15 transition-colors disabled:opacity-50 flex items-center gap-1"
                                                            >
                                                                {isWriting ? <Loader2 size={10} className="animate-spin" /> : <Send size={9} />}
                                                                Написать
                                                            </button>
                                                        )}
                                                    </div>
                                                    {hasFailed && (
                                                        <div className="ml-5 mb-0.5 group/err relative inline-block">
                                                            <span className="text-[10px] text-red-500 leading-tight cursor-default">Ошибка доставки</span>
                                                            {chStatus.error && (
                                                                <div className="absolute left-0 bottom-full mb-1 hidden group-hover/err:block z-50 pointer-events-none">
                                                                    <div className="bg-[#333] text-white text-[10px] leading-tight rounded-lg px-2.5 py-1.5 max-w-[220px] whitespace-pre-wrap shadow-lg">
                                                                        {chStatus.error.length > 120 ? chStatus.error.substring(0, 120) + '…' : chStatus.error}
                                                                    </div>
                                                                </div>
                                                            )}
                                                        </div>
                                                    )}
                                                </div>
                                            )
                                        })}
                                        {/* Available channels without identity (can write via phone) */}
                                        {missingChannels.map(ch => {
                                            const cfg = CHANNEL_CONFIG[ch]
                                            const isWriting = writingIdentityId === `phone_${ch}`
                                            const isMissingCheckable = ch === 'telegram' || ch === 'whatsapp'
                                            const missingReachable = liveReachability[ch] !== undefined ? liveReachability[ch] : null
                                            return (
                                                <div key={`missing-${ch}`} className="flex items-center justify-between h-[26px]">
                                                    <div className="flex items-center gap-1.5">
                                                        {isMissingCheckable && missingReachable !== undefined ? (
                                                            <span className={`inline-block w-[7px] h-[7px] rounded-full ${missingReachable ? 'bg-emerald-500' : 'bg-red-500'}`} title={missingReachable ? 'Номер найден' : 'Номер не найден'} />
                                                        ) : (
                                                            <span className="inline-block w-[7px] h-[7px] rounded-full bg-gray-300" title="Проверка недоступна" />
                                                        )}
                                                        <span className="text-[11px] opacity-50">{cfg?.icon || '?'}</span>
                                                        <span className="text-[11px] text-gray-400">{cfg?.label || ch}</span>
                                                    </div>
                                                    <button
                                                        onClick={() => handleWrite(ch)}
                                                        disabled={isWriting}
                                                        className="text-[10px] text-[#3390EC] font-semibold px-2 py-0.5 rounded bg-[#3390EC]/5 hover:bg-[#3390EC]/15 transition-colors disabled:opacity-50 flex items-center gap-1"
                                                    >
                                                        {isWriting ? <Loader2 size={10} className="animate-spin" /> : <Send size={9} />}
                                                        Написать
                                                    </button>
                                                </div>
                                            )
                                        })}
                                    </div>
                                </div>
                            )
                        })}

                        {/* Identities without phone (e.g. MAX) */}
                        {orphanIdentities.map(identity => {
                            const cfg = CHANNEL_CONFIG[identity.channel]
                            const isYandex = identity.channel === 'yandex_pro'
                            const isWriting = writingIdentityId === identity.id
                            return (
                                <div key={identity.id} className="mb-2.5">
                                    <div className="flex items-center gap-1.5 mb-0.5">
                                        <span className="text-[11px]">{cfg?.icon || '?'}</span>
                                        <span className="text-[12px] font-medium text-[#111]">
                                            {cfg?.label || identity.channel}
                                        </span>
                                        <span className="text-[11px] text-gray-400 font-mono">
                                            ID: {identity.externalId.length > 15 ? identity.externalId.substring(0, 15) + '...' : identity.externalId}
                                        </span>
                                        {identity.source === 'auto' && contact && contact.identities.length > 1 && (
                                            <span className="text-[8px] text-gray-400 bg-gray-50 px-1 py-px rounded">авто</span>
                                        )}
                                        {identity.source === 'manual' && (
                                            <span className="text-[8px] text-violet-400 bg-violet-50 px-1 py-px rounded">ручной</span>
                                        )}
                                    </div>
                                    {!isYandex && (
                                        <div className="ml-4">
                                            <button
                                                onClick={() => handleWrite(identity.channel, identity.id)}
                                                disabled={isWriting}
                                                className="text-[10px] text-[#3390EC] font-semibold px-2 py-0.5 rounded bg-[#3390EC]/5 hover:bg-[#3390EC]/15 transition-colors disabled:opacity-50 flex items-center gap-1"
                                            >
                                                {isWriting ? <Loader2 size={10} className="animate-spin" /> : <Send size={9} />}
                                                Написать
                                            </button>
                                        </div>
                                    )}
                                </div>
                            )
                        })}
                    </div>
                ) : !chat.contactId ? (
                    /* Fallback: no Contact linked */
                    <div className="px-4 py-2.5">
                        <h4 className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1.5">Телефоны и каналы</h4>
                        {chat.driver?.phone ? (
                            <div className="flex items-center gap-1.5">
                                <Phone size={11} className="text-gray-400" />
                                <span className="text-[12px] text-[#111]">{chat.driver.phone}</span>
                            </div>
                        ) : (
                            <div className="text-[12px] text-gray-400 italic">Контакт не привязан</div>
                        )}
                    </div>
                ) : null}

                <div className="h-px bg-[#E8E8E8] mx-3" />

                {/* Custom Fields */}
                <div className="px-4 py-2.5">
                    <h4 className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">Поля</h4>

                    {/* Driver-specific fields from Contact */}
                    {contact?.driver && (
                        <div className="space-y-1.5 mb-2">
                            <div className="flex items-center justify-between min-h-[28px]">
                                <span className="text-[12px] text-gray-500 w-[80px]">Сегмент</span>
                                <span className="text-[12px] font-medium text-[#111]">{contact.driver.segment || '—'}</span>
                            </div>
                            {contact.driver.score != null && (
                                <div className="flex items-center justify-between min-h-[28px]">
                                    <span className="text-[12px] text-gray-500 w-[80px]">Скоринг</span>
                                    <span className="text-[12px] font-medium text-[#111]">{contact.driver.score}</span>
                                </div>
                            )}
                            {contact.driver.lastOrderAt && (
                                <div className="flex items-center justify-between min-h-[28px]">
                                    <span className="text-[12px] text-gray-500 w-[80px]">Посл. заказ</span>
                                    <span className="text-[12px] font-medium text-[#111]">
                                        {new Date(contact.driver.lastOrderAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}
                                    </span>
                                </div>
                            )}
                        </div>
                    )}

                    <div className="space-y-1.5">
                        {customFields.map(field => (
                            <div key={field.id} className="group flex items-center justify-between min-h-[28px]">
                                <span className="text-[12px] text-gray-500 shrink-0 w-[80px]">{field.label}</span>
                                {editingFieldId === field.id ? (
                                    <div className="flex-1 flex items-center gap-1 ml-2">
                                        {field.type === 'select' && field.options ? (
                                            <select autoFocus value={editingFieldValue} onChange={(e) => setEditingFieldValue(e.target.value)} onBlur={() => handleFieldSave(field.id, editingFieldValue)} className="flex-1 h-[24px] bg-[#F4F5F7] rounded px-2 text-[12px] text-[#111] outline-none border border-[#3390EC]/30">
                                                {field.options.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                                            </select>
                                        ) : field.type === 'date' ? (
                                            <input type="date" autoFocus value={editingFieldValue} onChange={(e) => setEditingFieldValue(e.target.value)} onBlur={() => handleFieldSave(field.id, editingFieldValue)} onKeyDown={(e) => { if (e.key === 'Enter') handleFieldSave(field.id, editingFieldValue); if (e.key === 'Escape') setEditingFieldId(null) }} className="flex-1 h-[24px] bg-[#F4F5F7] rounded px-2 text-[12px] text-[#111] outline-none border border-[#3390EC]/30" />
                                        ) : (
                                            <input type="text" autoFocus value={editingFieldValue} onChange={(e) => setEditingFieldValue(e.target.value)} onBlur={() => handleFieldSave(field.id, editingFieldValue)} onKeyDown={(e) => { if (e.key === 'Enter') handleFieldSave(field.id, editingFieldValue); if (e.key === 'Escape') setEditingFieldId(null) }} placeholder="Введите..." className="flex-1 h-[24px] bg-[#F4F5F7] rounded px-2 text-[12px] text-[#111] outline-none border border-[#3390EC]/30 placeholder:text-gray-400" />
                                        )}
                                        <button onClick={() => handleFieldSave(field.id, editingFieldValue)} className="text-[#3390EC]"><Check size={12} /></button>
                                    </div>
                                ) : (
                                    <div className="flex-1 flex items-center gap-1 ml-2">
                                        <button onClick={() => { setEditingFieldId(field.id); setEditingFieldValue(typeof field.value === 'string' ? field.value : '') }} className="flex-1 text-left text-[12px] font-medium text-[#111] hover:text-[#3390EC] transition-colors truncate h-[24px] flex items-center">
                                            {field.value || <span className="text-gray-400 italic">—</span>}
                                            {field.type === 'select' && <ChevronDown size={10} className="ml-0.5 text-gray-400" />}
                                        </button>
                                        <button onClick={() => handleFieldDelete(field.id)} className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 transition-all"><Trash2 size={10} /></button>
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>

                    {showAddField ? (
                        <div className="mt-2 bg-[#F4F5F7] rounded-lg p-2.5 space-y-1.5 animate-in fade-in duration-150">
                            <input autoFocus value={newFieldLabel} onChange={(e) => setNewFieldLabel(e.target.value)} placeholder="Название поля..." onKeyDown={(e) => { if (e.key === 'Enter') handleAddField(); if (e.key === 'Escape') setShowAddField(false) }} className="w-full h-[26px] bg-white rounded px-2 text-[12px] outline-none placeholder:text-gray-400 text-[#111]" />
                            <div className="flex gap-1">
                                <select value={newFieldType} onChange={(e) => setNewFieldType(e.target.value as any)} className="flex-1 h-[26px] bg-white rounded px-2 text-[11px] outline-none text-[#111]">
                                    <option value="text">Текст</option>
                                    <option value="select">Список</option>
                                    <option value="date">Дата</option>
                                </select>
                                <button onClick={handleAddField} className="h-[26px] px-2.5 bg-[#3390EC] text-white text-[11px] font-semibold rounded hover:bg-[#2B7FD4] transition-colors">Добавить</button>
                            </div>
                        </div>
                    ) : (
                        <button onClick={() => setShowAddField(true)} className="mt-2 inline-flex items-center gap-0.5 text-[11px] text-[#3390EC] font-medium px-2 py-1 rounded-lg bg-[#3390EC]/5 hover:bg-[#3390EC]/10 transition-colors">
                            <Plus size={10} /> Добавить поле
                        </button>
                    )}
                </div>

                <div className="h-px bg-[#E8E8E8] mx-3" />

                {/* Tags */}
                <div className="px-4 py-2.5">
                    <h4 className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1.5">Теги</h4>
                    <div className="flex flex-wrap gap-1">
                        {tags.map(tag => (
                            <span key={tag} className="inline-flex items-center gap-1 bg-gray-100 text-[11px] text-gray-700 px-2 py-0.5 rounded-full">
                                {tag}
                                <button onClick={() => handleRemoveTag(tag)} className="text-gray-400 hover:text-gray-700"><X size={10} /></button>
                            </span>
                        ))}
                        {showTagInput ? (
                            <input autoFocus value={tagInput} onChange={(e) => setTagInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') handleAddTag(); if (e.key === 'Escape') setShowTagInput(false); }} onBlur={() => { if (!tagInput.trim()) setShowTagInput(false); }} placeholder="Тег..." className="h-[22px] w-[80px] bg-gray-100 rounded-full px-2 text-[11px] outline-none placeholder:text-gray-400" />
                        ) : (
                            <button onClick={() => setShowTagInput(true)} className="inline-flex items-center gap-0.5 text-[11px] text-[#3390EC] font-medium px-2 py-0.5 rounded-full bg-[#3390EC]/5 hover:bg-[#3390EC]/10 transition-colors">
                                <Plus size={10} /> Тег
                            </button>
                        )}
                    </div>
                </div>

                <div className="h-px bg-[#E8E8E8] mx-3" />

                {/* Tasks Widget */}
                {chat.driver?.id ? (
                    <DriverTasksWidget driverId={chat.driver.id} />
                ) : (
                    <div className="px-4 py-3">
                        <div className="flex items-center gap-2 mb-2 text-[#9ca3af]">
                            <ClipboardList className="w-4 h-4" />
                            <span className="text-[14px] font-semibold">Задачи</span>
                        </div>
                        <div className="text-[12px] text-[#9ca3af] italic">Водитель не привязан к чату</div>
                    </div>
                )}

                <div className="h-px bg-[#E8E8E8] mx-3" />

                {/* AI Agent */}
                <div className="px-4 py-2.5">
                    <h4 className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1.5">AI Агент</h4>
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                            <div className={`w-2 h-2 rounded-full ${aiStatus === 'active' ? 'bg-green-500' : aiStatus === 'paused' ? 'bg-yellow-500' : 'bg-gray-300'}`} />
                            <span className="text-[12px] text-[#111] font-medium">
                                {aiStatus === 'active' ? 'Активен' : aiStatus === 'paused' ? 'Пауза' : 'Неактивен'}
                            </span>
                        </div>
                        <div className="flex items-center gap-1">
                            {aiStatus === 'active' ? (
                                <button onClick={() => setAiStatus('paused')} className="text-[10px] text-yellow-600 font-semibold px-2 py-0.5 bg-yellow-50 rounded hover:bg-yellow-100 transition-colors">Пауза</button>
                            ) : (
                                <button onClick={() => setAiStatus('active')} className="text-[10px] text-[#3390EC] font-semibold px-2 py-0.5 bg-[#3390EC]/10 rounded hover:bg-[#3390EC]/20 transition-colors">Включить</button>
                            )}
                            {aiStatus !== 'inactive' && (
                                <button onClick={() => setAiStatus('inactive')} className="text-[10px] text-gray-500 font-medium px-2 py-0.5 bg-gray-100 rounded hover:bg-gray-200 transition-colors">Взять на себя</button>
                            )}
                        </div>
                    </div>
                </div>

                <div className="h-px bg-[#E8E8E8] mx-3" />

                {/* Context Info */}
                <div className="px-4 py-2.5">
                    <h4 className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1.5">Контекст</h4>
                    <div className="space-y-2 text-[12px]">
                        <div className="flex justify-between">
                            <span className="text-gray-500">Последний контакт</span>
                            <span className="text-[#111] font-medium">
                                {chat.lastMessageAt ? new Date(chat.lastMessageAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) : '—'}
                            </span>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-gray-500">Ответственный</span>
                            <span className="text-[#3390EC] font-medium cursor-pointer hover:underline">Назначить</span>
                        </div>
                        {contact && (
                            <>
                                <div className="flex justify-between">
                                    <span className="text-gray-500">Источник</span>
                                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${sourceInfo.color}`}>{sourceInfo.label}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-gray-500">Каналов</span>
                                    <span className="text-[#111] font-medium">{contact.identities.length}</span>
                                </div>
                            </>
                        )}
                    </div>
                </div>
            </div>

            {/* Task Create Modal */}
            {isTaskModalOpen && contactOrDriverId && (
                <TaskCreateModal
                    driverId={chat.driver?.id || contactOrDriverId}
                    driverName={displayName}
                    source="chat"
                    chatContext={{ chatId: chat.id }}
                    onClose={() => setIsTaskModalOpen(false)}
                />
            )}

            {/* Merge Dialog */}
            {showMergeDialog && (
                <div className="fixed inset-0 bg-black/30 z-[100] flex items-center justify-center" onClick={() => setShowMergeDialog(false)}>
                    <div className="bg-white rounded-xl shadow-2xl w-[380px] max-h-[500px] flex flex-col animate-in fade-in zoom-in-95 duration-150" onClick={e => e.stopPropagation()}>
                        {/* Header */}
                        <div className="px-4 py-3 border-b border-[#E8E8E8] flex items-center justify-between shrink-0">
                            <span className="text-[14px] font-bold text-[#111]">Объединить контакт</span>
                            <button onClick={() => setShowMergeDialog(false)} className="text-gray-400 hover:text-gray-600"><X size={16} /></button>
                        </div>

                        {/* Success state */}
                        {mergeSuccess ? (
                            <div className="px-4 py-8 flex flex-col items-center gap-2">
                                <Check size={32} className="text-emerald-500" />
                                <span className="text-[14px] font-semibold text-[#111]">Контакты объединены</span>
                                <button onClick={() => setShowMergeDialog(false)} className="mt-2 px-4 py-1.5 bg-[#3390EC] text-white text-[12px] font-semibold rounded-lg hover:bg-[#2B7FD4]">
                                    Закрыть
                                </button>
                            </div>
                        ) : !mergeMode ? (
                            /* Mode selection */
                            <div className="px-4 py-3 space-y-2">
                                <p className="text-[12px] text-gray-500 mb-3">Выберите тип объединения:</p>
                                <button
                                    onClick={() => setMergeMode('contact')}
                                    className="w-full px-3 py-2.5 text-left bg-gray-50 hover:bg-blue-50 rounded-lg transition-colors border border-transparent hover:border-blue-200"
                                >
                                    <div className="text-[12px] font-semibold text-[#111]">С другим контактом</div>
                                    <div className="text-[11px] text-gray-400 mt-0.5">Объединить два контакта (lead-to-lead)</div>
                                </button>
                                <button
                                    onClick={() => setMergeMode('driver')}
                                    className="w-full px-3 py-2.5 text-left bg-gray-50 hover:bg-blue-50 rounded-lg transition-colors border border-transparent hover:border-blue-200"
                                >
                                    <div className="text-[12px] font-semibold text-[#111]">С карточкой водителя</div>
                                    <div className="text-[11px] text-gray-400 mt-0.5">Привязать к существующему водителю (Driver)</div>
                                </button>
                            </div>
                        ) : mergeTarget ? (
                            /* Confirmation */
                            <div className="px-4 py-4 space-y-3">
                                <p className="text-[12px] text-gray-600">
                                    {mergeMode === 'contact'
                                        ? contact?.yandexDriverId
                                            ? <>Влить <strong>{mergeTarget.displayName}</strong> в текущий контакт <strong>{displayName}</strong>?</>
                                            : <>Влить <strong>{displayName}</strong> в <strong>{mergeTarget.displayName}</strong>?</>
                                        : <>Привязать <strong>{displayName}</strong> к водителю <strong>{mergeTarget.fullName || mergeTarget.displayName}</strong>?</>
                                    }
                                </p>
                                {mergeError && <p className="text-[11px] text-red-500 bg-red-50 px-2 py-1 rounded">{mergeError}</p>}
                                <div className="flex gap-2">
                                    <button onClick={() => { setMergeTarget(null); setMergeError(null) }} className="flex-1 h-[32px] bg-gray-100 text-gray-700 text-[12px] font-semibold rounded-lg hover:bg-gray-200">
                                        Назад
                                    </button>
                                    <button
                                        onClick={async () => {
                                            setMergeLoading(true); setMergeError(null)
                                            try {
                                                const userId = document.cookie.split(';').map(c => c.trim()).find(c => c.startsWith('crm_user_id='))?.split('=')[1] || 'system'
                                                let res: Response
                                                if (mergeMode === 'driver') {
                                                    res = await fetch(`/api/contacts/${contact?.id || chat?.contactId}/merge`, {
                                                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                                                        body: JSON.stringify({ driverId: mergeTarget.id, mergedBy: userId }),
                                                    })
                                                } else {
                                                    // contact-to-contact: if current is driver-linked, current is target (survivor)
                                                    const sourceId = contact?.yandexDriverId ? mergeTarget.id : (contact?.id || chat?.contactId)
                                                    const targetId = contact?.yandexDriverId ? (contact?.id || chat?.contactId) : mergeTarget.id
                                                    res = await fetch(`/api/contacts/${sourceId}/merge-to/${targetId}`, {
                                                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                                                        body: JSON.stringify({ mergedBy: userId }),
                                                    })
                                                }
                                                const data = await res.json()
                                                if (!res.ok) throw new Error(data.error || 'Ошибка объединения')
                                                setMergeSuccess(true)
                                                refetchContact()
                                                refreshConversations()
                                            } catch (e: any) {
                                                setMergeError(e.message)
                                            } finally {
                                                setMergeLoading(false)
                                            }
                                        }}
                                        disabled={mergeLoading}
                                        className="flex-1 h-[32px] bg-[#3390EC] text-white text-[12px] font-semibold rounded-lg hover:bg-[#2B7FD4] disabled:opacity-50 flex items-center justify-center gap-1"
                                    >
                                        {mergeLoading ? <Loader2 size={12} className="animate-spin" /> : <GitMerge size={12} />}
                                        Объединить
                                    </button>
                                </div>
                            </div>
                        ) : (
                            /* Search */
                            <div className="flex flex-col min-h-0">
                                <div className="px-3 py-2 shrink-0">
                                    <div className="relative">
                                        <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                                        <input
                                            type="text"
                                            value={mergeSearch}
                                            onChange={e => setMergeSearch(e.target.value)}
                                            placeholder={mergeMode === 'driver' ? 'Поиск водителя...' : 'Поиск контакта (имя, телефон)...'}
                                            className="w-full h-[32px] bg-[#F4F5F7] rounded-lg pl-8 pr-3 text-[12px] outline-none placeholder:text-gray-400"
                                            autoFocus
                                        />
                                    </div>
                                    <button onClick={() => { setMergeMode(null); setMergeSearch('') }} className="text-[11px] text-[#3390EC] mt-1 hover:underline">
                                        ← Назад к выбору типа
                                    </button>
                                </div>
                                <div className="flex-1 overflow-y-auto max-h-[280px]">
                                    {mergeSearchLoading && mergeSearch.length >= 2 && (
                                        <div className="px-4 py-3 text-[11px] text-gray-400 flex items-center gap-2">
                                            <Loader2 size={12} className="animate-spin" /> Поиск...
                                        </div>
                                    )}
                                    {mergeSearch.length >= 2 && !mergeSearchLoading && mergeSearchResults.length === 0 && (
                                        <div className="px-4 py-6 text-center text-[12px] text-gray-400">Ничего не найдено</div>
                                    )}
                                    {mergeSearchResults.filter(r => r.id !== contact?.id).map(result => {
                                        const phone = result.phones?.[0]?.phone
                                        const hasDriver = !!(result as any).driver || result.masterSource === 'yandex'
                                        const isValidTarget = mergeMode === 'driver' ? hasDriver : true
                                        return (
                                            <button
                                                key={result.id}
                                                onClick={() => isValidTarget && setMergeTarget(mergeMode === 'driver' ? { id: result.id, displayName: result.displayName, fullName: result.displayName } : result)}
                                                disabled={!isValidTarget}
                                                className={`w-full px-3 py-2 text-left flex items-center gap-2.5 transition-colors ${
                                                    isValidTarget ? 'hover:bg-blue-50 cursor-pointer' : 'opacity-40 cursor-not-allowed'
                                                }`}
                                            >
                                                <div className="h-[36px] w-[36px] rounded-full bg-[#E3E8ED] text-[#6B7A8D] flex items-center justify-center font-bold text-[12px] shrink-0">
                                                    {(result.displayName || '?')[0].toUpperCase()}
                                                </div>
                                                <div className="flex-1 min-w-0">
                                                    <div className="text-[12px] font-semibold text-[#111] truncate">{result.displayName || 'Без имени'}</div>
                                                    <div className="text-[10px] text-gray-400 flex items-center gap-1">
                                                        {phone && <span className="font-mono">{phone}</span>}
                                                        {result.channels?.map((ch: string) => (
                                                            <span key={ch} className="text-[8px] font-bold bg-gray-100 px-1 py-px rounded">{ch === 'whatsapp' ? 'WA' : ch === 'telegram' ? 'TG' : ch.toUpperCase()}</span>
                                                        ))}
                                                        {!isValidTarget && <span className="text-[9px] text-orange-500">нет водителя</span>}
                                                    </div>
                                                </div>
                                            </button>
                                        )
                                    })}
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    )
}
