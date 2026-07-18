/* eslint-disable @typescript-eslint/no-explicit-any */
"use client"

import { useState, useEffect } from "react"
import { X, Phone, UserCheck, ClipboardList, MoreHorizontal, ExternalLink, Plus, Archive, Ban, ChevronDown, Pencil, Trash2, Check, Star, MessageSquare, Loader2, GitMerge, Search, Copy } from "lucide-react"
import { useChatNavigation } from "../hooks/useChatNavigation"
import { useConversations, refreshConversations } from "../hooks/useConversations"
import { useContactSearch } from "../hooks/useContactSearch"
import { useContact, type ContactIdentity } from "../hooks/useContact"
import { useChannelStatus } from "../hooks/useChannelStatus"
import DriverTasksWidget from "@/app/messages/components/DriverTasksWidget"
import TaskCreateModal from "@/app/tasks/components/TaskCreateModal"
import CallButton from "@/components/sip/CallButton"
import ContactDriverProfilesPanel from "./ContactDriverProfilesPanel"
import AddPhoneResolutionDialog from "./AddPhoneResolutionDialog"
import ContactChannelRow, { type ContactChannelBadge } from "./ContactChannelRow"
import { countUniqueProviderChannels, formatProviderChannelCount, getIdentitySourceLabel } from "@/lib/contact-profile-ui"
import { getSegmentLabel } from '@/lib/contact-display'
import {
    readContactProfileFields,
    writeContactProfileFields,
    type ContactProfileField,
} from "@/lib/contact-profile-fields"
import {
    deriveChannelReachabilityPresentation,
    type LiveReachabilityDecision,
} from "@/lib/channel-reachability-ui"

type LiveReachabilityEntry = LiveReachabilityDecision & {
    contactId: string
    phone: string
    identityId: string | null
}

type ContactMergePreviewPayload = {
    source: { id: string; displayName: string }
    target: { id: string; displayName: string }
    planHash: string
    sourceVersion: string
    targetVersion: string
    confirmationToken: string
    entities: {
        identities: { count: number }
        phones: { count: number }
        chats: { count: number }
        messages: { count: number }
        attachments: { count: number }
        tasks: { count: number }
        calls: { count: number }
        driverProfiles: { count: number }
        profileAudits: { count: number }
        telegramBindings: { count: number }
    }
    warnings: string[]
    conflicts: string[]
    blockers: Array<{ code: string; message: string }>
    rollback: { mode: 'operator_manifest'; automatic: false }
}

// Channel display config
const CHANNEL_CONFIG: Record<string, { label: string; icon: string; color: string; dotColor: string }> = {
    whatsapp:   { label: 'WhatsApp',   icon: '📱', color: 'text-emerald-700 bg-emerald-50', dotColor: 'bg-emerald-500' },
    telegram:   { label: 'Telegram',   icon: '✈️',  color: 'text-blue-700 bg-blue-50',      dotColor: 'bg-blue-500' },
    max:        { label: 'MAX',        icon: '💬', color: 'text-purple-700 bg-purple-50',  dotColor: 'bg-purple-500' },
}

const SOURCE_LABELS: Record<string, { label: string; color: string }> = {
    yandex: { label: 'Яндекс', color: 'bg-yellow-50 text-yellow-700' },
    chat:   { label: 'Чат',    color: 'bg-blue-50 text-blue-700' },
    manual: { label: 'Ручной', color: 'bg-gray-100 text-gray-600' },
}

const MESSAGES_HELP_SECTIONS = [
    {
        title: 'Контакт.',
        body: 'Первое сообщение из MAX, Telegram или WhatsApp создаёт карточку человека, связь с каналом, чат и запись в истории. Если номера нет, карточка остаётся с данными канала до уточнения.',
    },
    {
        title: 'Добавление номера.',
        body: 'CRM сначала проверяет владельцев. Свободный номер добавляется только после подтверждения; повтор своего номера безопасен; чужой или спорный номер не записывается и открывает ручную проверку.',
    },
    {
        title: 'Профили в парках.',
        body: 'По подтверждённому номеру CRM ищет сохранённые профили во всех шести парках. Совпадение номера или ФИО помогает найти профиль, но не доказывает принадлежность человека.',
    },
    {
        title: 'Проверка.',
        body: 'Откройте возможные профили, сравните ФИО, парк, телефон и статус, затем вручную отметьте нужные. При конфликте или уже занятом профиле CRM ничего не переносит сама.',
    },
    {
        title: 'Привязка и объединение.',
        body: 'Привязка добавляет профиль водителя к текущей карточке. Объединение соединяет две карточки вместе с их CRM-историей. Это разные действия.',
    },
    {
        title: 'Главный профиль.',
        body: 'Он выбирается только среди привязанных работающих профилей: сначала ручной выбор, затем приоритет парков. Уволенный профиль главным быть не может.',
    },
    {
        title: 'Telegram-бот.',
        body: 'Бот привязывается к конкретному профилю водителя. Если профиль не выбран, CRM честно показывает это и не выбирает его случайно.',
    },
    {
        title: 'Обновление.',
        body: 'Сохранённые данные показываются сразу. CRM решает, нужно ли обновление; если парк временно не ответил, остаётся последняя сохранённая информация и кнопка повтора появится после паузы.',
    },
]

function getIdentitySourceBadges(identity: ContactIdentity, identityCount: number): ContactChannelBadge[] {
    if (identity.source === 'auto' && identityCount > 1) {
        return [{
            label: getIdentitySourceLabel(identity.source),
            className: 'bg-gray-50 text-gray-500',
            title: 'Канал привязан автоматически по номеру телефона',
        }]
    }
    if (identity.source === 'manual') {
        return [{
            label: getIdentitySourceLabel(identity.source),
            className: 'bg-violet-50 text-violet-600',
            title: 'Канал добавлен вручную',
        }]
    }
    return []
}

function formatPhone(phone: string): string {
    // +79221234567 → +7 922 215-57-50
    if (phone.length === 12 && phone.startsWith('+7')) {
        return `+7 ${phone.slice(2, 5)} ${phone.slice(5, 8)}-${phone.slice(8, 10)}-${phone.slice(10)}`
    }
    return phone
}

function formatTechnicalDate(value: string | null): string {
    if (!value) return 'нет'
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? 'нет' : date.toLocaleString('ru-RU')
}

function OrphanIdentityRow({ identity, cfg, isWriting, onWrite, badges, dotClassName, dotTitle, canWrite, writeDisabledReason, error }: {
    identity: ContactIdentity
    cfg: { label: string; icon: string; color: string; dotColor: string } | undefined
    isWriting: boolean
    onWrite: () => void
    badges: ContactChannelBadge[]
    dotClassName: string
    dotTitle: string
    canWrite: boolean
    writeDisabledReason?: string
    error?: string | null
}) {
    const [copiedId, setCopiedId] = useState(false)
    // metadata may contain { username, firstName, lastName } saved by TG webhook
    const meta = (identity.metadata as Record<string, string | null> | null) ?? {}
    // Only use metadata (populated on each incoming TG message).
    // Falls back to displayName ONLY for @username format — regular names
    // like "Check" are placeholder-grade and not shown until metadata arrives.
    const tgName = meta.firstName
        ? [meta.firstName, meta.lastName].filter(Boolean).join(' ')
        : null
    const tgUsername = meta.username
        ? `@${meta.username}`
        : (identity.displayName?.startsWith('@') ? identity.displayName : null)
    // Format: "Имя (@username)" | "@username" | "Имя" — без числового ID
    const identifierLabel = tgName && tgUsername
        ? `${tgName} (${tgUsername})`
        : (tgName || tgUsername || null)
    const handleCopyId = () => {
        const value = tgUsername || tgName || identity.externalId
        navigator.clipboard.writeText(value).then(() => {
            setCopiedId(true)
            setTimeout(() => setCopiedId(false), 2000)
        }).catch(() => {})
    }
    return (
        <ContactChannelRow
            provider={identity.channel}
            providerLabel={cfg?.label || identity.channel}
            icon={cfg?.icon || '?'}
            dotClassName={dotClassName}
            dotTitle={dotTitle}
            badges={badges}
            detail={identifierLabel ? (
                <button
                    type="button"
                    onClick={handleCopyId}
                    title="Нажмите, чтобы скопировать"
                    className="min-w-0 truncate text-[10px] text-gray-400 transition-colors hover:text-[#3390EC]"
                >
                    {copiedId ? '✓ скопировано' : identifierLabel}
                </button>
            ) : undefined}
            isWriting={isWriting}
            onWrite={onWrite}
            canWrite={canWrite}
            writeDisabledReason={writeDisabledReason}
            error={error}
        />
    )
}

export default function ContactProfileDrawer({ chatId }: { chatId: string }) {
    const { toggleProfileDrawer, updateQuery } = useChatNavigation()
    const { conversations } = useConversations()
    const chat = conversations.find(c => c.id === chatId || c.allChatIds?.includes(chatId))
    const { contact, isLoading: contactLoading, refetch: refetchContact, retryProfileSync, profileSyncState, profileSyncError, profileSyncedAt } = useContact(chat?.contactId)
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
    const [mergePreview, setMergePreview] = useState<ContactMergePreviewPayload | null>(null)
    const [mergePreviewLoading, setMergePreviewLoading] = useState(false)
    const [mergeSuccess, setMergeSuccess] = useState(false)
    const { results: mergeSearchResults, loading: mergeSearchLoading } = useContactSearch(showMergeDialog ? mergeSearch : '')
    const [customFields, setCustomFields] = useState<ContactProfileField[]>([])
    const [editingFieldId, setEditingFieldId] = useState<string | null>(null)
    const [editingFieldValue, setEditingFieldValue] = useState("")
    const [showAddField, setShowAddField] = useState(false)
    const [newFieldLabel, setNewFieldLabel] = useState("")
    const [newFieldType, setNewFieldType] = useState<'text' | 'select' | 'date'>('text')
    const [profileDataSaving, setProfileDataSaving] = useState(false)
    const [profileDataError, setProfileDataError] = useState<string | null>(null)
    const [isTaskModalOpen, setIsTaskModalOpen] = useState(false)
    const [writingIdentityId, setWritingIdentityId] = useState<string | null>(null)
    const [showMessagesHelp, setShowMessagesHelp] = useState(false)

    // TG Bot link state
    const [tgIdCopied, setTgIdCopied] = useState(false)
    const [showBotProfilePicker, setShowBotProfilePicker] = useState(false)
    const [botLinkSaving, setBotLinkSaving] = useState(false)
    const [botLinkError, setBotLinkError] = useState<string | null>(null)

    // Edit display name state
    const [editingName, setEditingName] = useState(false)
    const [nameInput, setNameInput] = useState("")
    const [nameSaving, setNameSaving] = useState(false)

    // Add-phone inline form state
    const [showAddPhone, setShowAddPhone] = useState(false)

    // Reachability: merge persisted status from DB with optional live-check override.
    // "checking" is an operational state, not a green confirmation.
    const [liveReachability, setLiveReachability] = useState<Record<string, LiveReachabilityEntry>>({})

    useEffect(() => {
        if (!contact) {
            setTags([])
            setCustomFields([])
            return
        }
        setTags(contact.tags || [])
        setCustomFields(readContactProfileFields(contact.customFields))
    }, [contact])

    useEffect(() => {
        setMergePreview(null)
        setMergeError(null)
        if (!showMergeDialog || mergeMode !== 'contact' || !mergeTarget?.id) return

        const currentContactId = contact?.id || chat?.contactId
        if (!currentContactId) return
        const currentContactHasProfile = Boolean(contact?.mainDriverId || contact?.yandexDriverId)
        const sourceId = currentContactHasProfile ? mergeTarget.id : currentContactId
        const targetId = currentContactHasProfile ? currentContactId : mergeTarget.id
        const controller = new AbortController()

        setMergePreviewLoading(true)
        fetch(`/api/contacts/${sourceId}/merge-to/${targetId}`, {
            signal: controller.signal,
        })
            .then(async response => {
                const data = await response.json()
                if (!response.ok) throw new Error(data.error || 'Не удалось подготовить план объединения')
                return data as ContactMergePreviewPayload
            })
            .then(setMergePreview)
            .catch(error => {
                if (error instanceof DOMException && error.name === 'AbortError') return
                setMergeError(error instanceof Error ? error.message : 'Не удалось подготовить план объединения')
            })
            .finally(() => {
                if (!controller.signal.aborted) setMergePreviewLoading(false)
            })

        return () => controller.abort()
    }, [
        showMergeDialog,
        mergeMode,
        mergeTarget?.id,
        contact?.id,
        contact?.mainDriverId,
        contact?.yandexDriverId,
        chat?.contactId,
    ])

    const reachabilityPhone = contact?.phones.find(phone => phone.isPrimary)?.phone || contact?.phones[0]?.phone || null

    useEffect(() => {
        if (!contact?.id || !reachabilityPhone) return

        const controller = new AbortController()
        const checkChannels = ['telegram', 'whatsapp', 'max'] as const

        const runDecision = async (channel: typeof checkChannels[number]) => {
            const identity =
                contact.identities.find(item =>
                    item.channel === channel && item.phoneId === contact.primaryPhoneId,
                )
                || contact.identities.find(item =>
                    item.channel === channel && item.phoneId === null,
                )
            try {
                const response = await fetch('/api/channels/check-reachability', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        phone: reachabilityPhone,
                        channel,
                        identityId: identity?.id || null,
                    }),
                    signal: controller.signal,
                })
                const data = await response.json()
                if (controller.signal.aborted) return
                const status =
                    data.status === 'confirmed' || data.confirmed === true || data.telegramId
                        ? 'confirmed'
                        : data.status === 'unreachable' || data.reachable === false
                            ? 'unreachable'
                            : 'checking'
                setLiveReachability(previous => ({
                    ...previous,
                    [channel]: {
                        contactId: contact.id,
                        phone: reachabilityPhone,
                        identityId: identity?.id || null,
                        status,
                        retryable: data.retryable !== false,
                        error: data.error,
                        connectionHealth: data.connectionHealth || 'unknown',
                        cached: data.cached === true,
                        checkedAt: data.checkedAt,
                    },
                }))
            } catch (error: unknown) {
                if (controller.signal.aborted) return
                setLiveReachability(previous => ({
                    ...previous,
                    [channel]: {
                        contactId: contact.id,
                        phone: reachabilityPhone,
                        identityId: identity?.id || null,
                        status: 'checking',
                        retryable: false,
                        error: error instanceof Error ? error.message : 'Ошибка сети',
                        connectionHealth: 'unavailable',
                    },
                }))
            }
        }

        for (const channel of checkChannels) {
            void runDecision(channel)
        }

        return () => controller.abort()
    }, [contact?.id, contact?.identities, contact?.primaryPhoneId, reachabilityPhone])

    const liveReachabilityFor = (
        channel: string,
        target?: { phone?: string; identityId?: string },
    ): LiveReachabilityEntry | undefined => {
        const entry = liveReachability[channel]
        if (entry?.contactId !== contact?.id) return undefined
        if (target?.identityId && entry.identityId !== target.identityId) return undefined
        if (target?.phone && entry.phone !== target.phone) return undefined
        return entry
    }

    // Contact API resolves the canonical bot binding from DriverTelegram and
    // attached profiles. ContactIdentity.externalId can be a phone placeholder,
    // so it must not be used as the bot-link source of truth.
    const telegramBotState = contact?.telegramBotState ?? null
    const botTelegramId = telegramBotState?.telegramUserId || null
    const canManageBotLink = Boolean(botTelegramId && !/^[78]\d{10}$/.test(botTelegramId))
    const telegramBotDisplayStatus = telegramBotState?.status === 'NO_TELEGRAM_IDENTITY'
        && liveReachabilityFor('telegram')?.status === 'confirmed'
        ? 'TELEGRAM_DISCOVERED_BY_PHONE'
        : telegramBotState?.status || 'NO_TELEGRAM_IDENTITY'

    if (!chat) return null

    // Determine display data: Contact > Driver > Chat fallback
    // For auto-generated TG/WA/MAX placeholder names, prefer @username from identity metadata
    const _rawDisplayName = contact?.displayName || chat.driver?.fullName || chat.name || 'Водитель'
    const _isPlaceholder = /^(TG|WA|MAX|AV|Telegram|WhatsApp|Max)\s+\d+/i.test(_rawDisplayName)
    const _src = contact?.displayNameSource
    const displayName = contact?.canonicalSummary?.displayName || (() => {
        if (_src === 'yandex') return _rawDisplayName
        if (_src === 'manual' && !_isPlaceholder) return _rawDisplayName
        // Auto-generated placeholder or channel-sourced — try real TG identity
        const tgId = contact?.identities.find(i => i.channel === 'telegram')
        if (tgId) {
            const m = (tgId.metadata as Record<string, string | null> | null) ?? {}
            if (m.username) return `@${m.username}`
            if (m.firstName) return [m.firstName, m.lastName].filter(Boolean).join(' ')
            if (tgId.displayName?.startsWith('@')) return tgId.displayName
        }
        const phoneLike = /^\+?\d[\d\s()-]{9,}$/.test(_rawDisplayName)
        return phoneLike ? formatPhone(contact?.primaryPhone?.phone || _rawDisplayName.replace(/\s/g, '')) : _rawDisplayName
    })()
    const displayTitle = contact?.canonicalSummary?.displayTitle || displayName
    const masterSource = contact?.masterSource || (chat.driver ? 'yandex' : 'chat')
    const sourceInfo = SOURCE_LABELS[masterSource] || SOURCE_LABELS.chat
    const drawerChannelCount = contact?.canonicalSummary?.channelCount
        ?? countUniqueProviderChannels(contact?.channels)
    const contactOrDriverId = contact?.id || chat.driver?.id
    const taskDriverId = contact?.mainDriverProfile?.id || chat.driver?.id

    const saveContactPatch = async (patch: Record<string, unknown>): Promise<boolean> => {
        if (!contact || profileDataSaving) return false
        setProfileDataSaving(true)
        setProfileDataError(null)
        try {
            const response = await fetch(`/api/contacts/${contact.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(patch),
            })
            if (!response.ok) {
                const data = await response.json().catch(() => ({}))
                throw new Error(typeof data.message === 'string' ? data.message : 'Не удалось сохранить изменения')
            }
            await refetchContact()
            await refreshConversations()
            return true
        } catch (saveError) {
            setProfileDataError(saveError instanceof Error ? saveError.message : 'Не удалось сохранить изменения')
            await refetchContact()
            return false
        } finally {
            setProfileDataSaving(false)
        }
    }

    const handleAddTag = async () => {
        if (tagInput.trim() && !tags.includes(tagInput.trim())) {
            const nextTags = [...tags, tagInput.trim()]
            setTags(nextTags)
            setTagInput("")
            setShowTagInput(false)
            await saveContactPatch({ tags: nextTags })
        }
    }
    const handleRemoveTag = async (tag: string) => {
        const nextTags = tags.filter(item => item !== tag)
        setTags(nextTags)
        await saveContactPatch({ tags: nextTags })
    }

    const persistProfileFields = async (nextFields: ContactProfileField[]) => {
        if (!contact) return
        setCustomFields(nextFields)
        await saveContactPatch({
            customFields: writeContactProfileFields(contact.customFields, nextFields),
        })
    }
    const handleFieldSave = async (fieldId: string, newValue: string) => {
        const nextFields = customFields.map(field => field.id === fieldId ? { ...field, value: newValue } : field)
        await persistProfileFields(nextFields)
        setEditingFieldId(null)
    }
    const handleFieldDelete = async (fieldId: string) => {
        await persistProfileFields(customFields.filter(field => field.id !== fieldId))
    }
    const handleAddField = async () => {
        if (!newFieldLabel.trim()) return
        const nextFields: ContactProfileField[] = [
            ...customFields,
            {
                id: `custom-${Date.now()}`,
                label: newFieldLabel.trim(),
                type: newFieldType,
                value: '',
                options: newFieldType === 'select' ? ['Вариант 1', 'Вариант 2'] : undefined,
            },
        ]
        await persistProfileFields(nextFields)
        setNewFieldLabel(""); setNewFieldType('text'); setShowAddField(false)
    }

    const CHANNEL_SHORT: Record<string, string> = { whatsapp: 'wa', telegram: 'tg', max: 'max' }

    // ── Handle "Написать" — works with identity OR phone+channel ──
    const handleWrite = async (channel: string, identityId?: string) => {
        if (!contact) return

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

    const handleBotProfileLink = async (driverProfileId: string) => {
        if (!contact || !botTelegramId || botLinkSaving) return
        setBotLinkSaving(true)
        setBotLinkError(null)
        try {
            const response = await fetch('/api/bot-link', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'link',
                    telegramId: botTelegramId,
                    driverId: driverProfileId,
                    contactId: contact.id,
                }),
            })
            const data = await response.json().catch(() => ({}))
            if (!response.ok) {
                throw new Error(typeof data.message === 'string' ? data.message : 'Не удалось изменить профиль Telegram-бота')
            }
            await refetchContact()
            await refreshConversations()
            setShowBotProfilePicker(false)
        } catch (linkError) {
            setBotLinkError(linkError instanceof Error ? linkError.message : 'Не удалось изменить профиль Telegram-бота')
        } finally {
            setBotLinkSaving(false)
        }
    }

    const handleBotUnlink = async () => {
        if (!contact || !botTelegramId || botLinkSaving) return
        if (!confirm('Отвязать Telegram-бота от профиля водителя? Чат и Contact останутся без изменений.')) return
        setBotLinkSaving(true)
        setBotLinkError(null)
        try {
            const response = await fetch('/api/bot-link', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'unlink',
                    telegramId: botTelegramId,
                    contactId: contact.id,
                }),
            })
            const data = await response.json().catch(() => ({}))
            if (!response.ok) {
                throw new Error(typeof data.message === 'string' ? data.message : 'Не удалось отвязать Telegram-бота')
            }
            await refetchContact()
            await refreshConversations()
            setShowBotProfilePicker(false)
        } catch (unlinkError) {
            setBotLinkError(unlinkError instanceof Error ? unlinkError.message : 'Не удалось отвязать Telegram-бота')
        } finally {
            setBotLinkSaving(false)
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
            <div className="h-[44px] border-b border-[#E8E8E8] flex items-center justify-between px-[4px] shrink-0">
                <span className="text-[13px] font-semibold text-[#111]">Профиль</span>
                <button onClick={() => toggleProfileDrawer(false)} className="w-6 h-6 rounded-full hover:bg-gray-100 flex items-center justify-center text-gray-400 hover:text-gray-700 transition-colors">
                    <X size={14} />
                </button>
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar">
                {/* Contact Card */}
                <div className="px-[4px] pt-[4px] pb-3 flex flex-col items-center text-center">
                    <div className="w-14 h-14 rounded-full bg-[#3390EC] text-white flex items-center justify-center text-[20px] font-bold mb-[2px]">
                        {displayName.substring(0, 2).toUpperCase()}
                    </div>
                    {contact && editingName ? (
                        <div className="flex items-center gap-1 mt-0.5 w-full justify-center">
                            <input
                                autoFocus
                                value={nameInput}
                                onChange={e => setNameInput(e.target.value)}
                                onKeyDown={async e => {
                                    if (e.key === 'Enter') {
                                        e.preventDefault()
                                        if (!nameInput.trim() || nameSaving) return
                                        setNameSaving(true)
                                        await fetch(`/api/contacts/${contact.id}`, {
                                            method: 'PATCH',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ displayName: nameInput.trim() }),
                                        })
                                        await refetchContact()
                                        refreshConversations()
                                        setEditingName(false)
                                        setNameSaving(false)
                                    }
                                    if (e.key === 'Escape') { setEditingName(false) }
                                }}
                                className="text-[15px] font-semibold text-[#111] border-b border-[#3390EC] outline-none bg-transparent text-center w-full max-w-[180px]"
                                placeholder="Введите имя"
                            />
                            <button
                                disabled={nameSaving || !nameInput.trim()}
                                onClick={async () => {
                                    if (!nameInput.trim() || nameSaving) return
                                    setNameSaving(true)
                                    await fetch(`/api/contacts/${contact.id}`, {
                                        method: 'PATCH',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({ displayName: nameInput.trim() }),
                                    })
                                    await refetchContact()
                                    refreshConversations()
                                    setEditingName(false)
                                    setNameSaving(false)
                                }}
                                className="text-[#3390EC] disabled:opacity-40"
                            >
                                <Check size={14} />
                            </button>
                            <button onClick={() => setEditingName(false)} className="text-gray-400">
                                <X size={14} />
                            </button>
                        </div>
                    ) : (
                        <div className="mt-0.5 flex max-w-full items-start gap-1 px-1">
                            <h3 className="min-w-0 break-words text-[15px] font-semibold leading-tight text-[#111]">{displayTitle}</h3>
                            {contact && (
                                <button
                                    onClick={() => { setNameInput(displayName); setEditingName(true) }}
                                    className="mt-0.5 shrink-0 text-gray-300 transition-colors hover:text-gray-500"
                                    title="Редактировать имя"
                                >
                                    <Pencil size={12} />
                                </button>
                            )}
                        </div>
                    )}
                    <div className="flex items-center gap-1 mt-1.5 flex-wrap justify-center">
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${sourceInfo.color}`}>
                            Источник: {sourceInfo.label}
                        </span>
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${
                            chat.status === 'open' || chat.status === 'waiting_customer' ? 'bg-green-50 text-green-700' :
                            chat.status === 'new' ? 'bg-blue-50 text-blue-700' :
                            chat.status === 'resolved' ? 'bg-gray-100 text-gray-500' :
                            'bg-gray-100 text-gray-600'
                        }`}>
                            {chat.status === 'open' ? 'В работе' : chat.status === 'new' ? 'Новый' : chat.status === 'waiting_customer' ? 'Ожидаем клиента' : chat.status === 'waiting_internal' ? 'Внутренний' : chat.status === 'resolved' ? 'Завершён' : chat.status}
                        </span>
                        {contact && drawerChannelCount > 0 && (
                            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-600">
                                {formatProviderChannelCount(drawerChannelCount)}
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
                <div className="px-3 pb-[2px] flex gap-1.5">
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
                    <button
                        onClick={() => setShowMessagesHelp(true)}
                        className="h-[30px] w-[30px] bg-gray-100 text-gray-500 rounded-lg hover:bg-gray-200 transition-colors flex items-center justify-center"
                        title="Как работает раздел"
                    >
                        <MessageSquare size={13} />
                    </button>
                    <div className="relative">
                        <button onClick={() => setShowMoreMenu(!showMoreMenu)} className="h-[30px] w-[30px] bg-gray-100 text-gray-500 rounded-lg hover:bg-gray-200 transition-colors flex items-center justify-center">
                            <MoreHorizontal size={13} />
                        </button>
                        {showMoreMenu && (
                            <div className="absolute right-0 top-full mt-1 bg-white rounded-lg shadow-lg border border-[#E0E0E0] py-1 min-w-[160px] z-50 animate-in fade-in slide-in-from-top-1 duration-150">
                                <button className="w-full px-3 h-[30px] flex items-center gap-[2px] text-[12px] text-[#111] hover:bg-gray-50">
                                    <ExternalLink size={12} /> Открыть в CRM
                                </button>
                                <button className="w-full px-3 h-[30px] flex items-center gap-[2px] text-[12px] text-[#111] hover:bg-gray-50">
                                    <Archive size={12} /> Архивировать
                                </button>
                                <div className="h-px bg-[#E8E8E8] mx-[2px] my-0.5" />
                                <button className="w-full px-3 h-[30px] flex items-center gap-[2px] text-[12px] text-red-500 hover:bg-red-50">
                                    <Ban size={12} /> Заблокировать
                                </button>
                            </div>
                        )}
                    </div>
                </div>

                {contact && (
                    <ContactDriverProfilesPanel
                        contact={contact}
                        profileSyncState={profileSyncState}
                        profileSyncError={profileSyncError}
                        profileSyncedAt={profileSyncedAt}
                        onRetry={retryProfileSync}
                        onRefetch={async () => {
                            const result = await refetchContact()
                            await refreshConversations()
                            return result
                        }}
                        onOpenHelp={() => setShowMessagesHelp(true)}
                    />
                )}

                <div className="h-px bg-[#E8E8E8] mx-3" />

                {/* ── Phones & Channels (Contact Model) ──────────────── */}
                {contactLoading ? (
                    <div className="px-[4px] py-3">
                        <div className="animate-pulse space-y-[2px]">
                            <div className="h-3 bg-gray-200 rounded w-[24px]" />
                            <div className="h-[8px] bg-gray-100 rounded" />
                            <div className="h-[8px] bg-gray-100 rounded" />
                        </div>
                    </div>
                ) : contact ? (
                    <div className="px-[4px] py-2.5">
                        <div className="flex items-center justify-between mb-[2px]">
                            <h4 className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Телефоны и каналы</h4>
                            {!showAddPhone && (
                                <button
                                    onClick={() => setShowAddPhone(true)}
                                    className="text-[10px] font-semibold text-[#3390EC] hover:text-[#2B7FD4] flex items-center gap-0.5"
                                    title="Проверить владельца номера перед добавлением"
                                >
                                    <Plus size={10} />
                                    Добавить номер
                                </button>
                            )}
                        </div>

                        {phonesWithIdentities.length === 0 && orphanIdentities.length === 0 && !showAddPhone && (
                            <div className="text-[12px] text-gray-400 italic">Нет активных каналов связи</div>
                        )}

                        {/* Phones with their identities + available channels */}
                        {phonesWithIdentities.map(({ phone, identities }) => {
                            // Channels that have identity for this phone
                            const existingChannels = new Set([
                                ...identities.map(i => i.channel),
                                ...contact.identities
                                    .filter(i => !i.phoneId && contact.chats.some(c => c.contactIdentityId === i.id))
                                    .map(i => i.channel),
                            ])
                            // Channels available via phone but without identity yet
                            const phoneChannels: string[] = ['whatsapp', 'telegram', 'max']
                            const missingChannels = phoneChannels.filter(ch => !existingChannels.has(ch))

                            // Temp-phone badge + countdown until Avito's number rotates.
                            const tempDaysLeft = phone.expiresAt
                                ? Math.max(0, Math.ceil((new Date(phone.expiresAt).getTime() - Date.now()) / 86400_000))
                                : null

                            const handleDeletePhone = async () => {
                                const what = phone.isTemporary ? 'временный номер' : 'номер'
                                if (!confirm(`Удалить ${what} ${formatPhone(phone.phone)}? История звонков на него останется.`)) return
                                const res = await fetch(`/api/contacts/${contact!.id}/phones/${phone.id}`, { method: 'DELETE' })
                                if (res.ok) {
                                    await refetchContact()
                                    await refreshConversations()
                                }
                            }

                            const handleMakePrimary = async () => {
                                const res = await fetch(`/api/contacts/${contact!.id}/phones/${phone.id}`, {
                                    method: 'PATCH',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ isPrimary: true }),
                                })
                                if (res.ok) {
                                    await refetchContact()
                                    await refreshConversations()
                                }
                            }

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
                                        {phone.isTemporary && (
                                            <span
                                                className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-100"
                                                title={tempDaysLeft !== null ? `Временный номер Авито · истечёт через ${tempDaysLeft} дн.` : 'Временный номер Авито'}
                                            >
                                                ⏱ Врем.{tempDaysLeft !== null && tempDaysLeft <= 3 ? ` ${tempDaysLeft}д` : ''}
                                            </span>
                                        )}
                                        <div className="ml-auto flex items-center gap-0.5">
                                            {!phone.isPrimary && !phone.isTemporary && (
                                                <button
                                                    onClick={handleMakePrimary}
                                                    className="w-5 h-5 rounded hover:bg-yellow-50 flex items-center justify-center text-gray-300 hover:text-yellow-500 transition-colors"
                                                    title="Сделать основным"
                                                >
                                                    <Star size={11} />
                                                </button>
                                            )}
                                            <CallButton phoneNumber={phone.phone} label="" />
                                            <button
                                                onClick={handleDeletePhone}
                                                className="w-5 h-5 rounded hover:bg-red-50 flex items-center justify-center text-gray-300 hover:text-red-500 transition-colors"
                                                title="Удалить номер"
                                            >
                                                <Trash2 size={11} />
                                            </button>
                                        </div>
                                    </div>
                                    <div className="ml-[4px] space-y-0.5">
                                        {/* Existing identities */}
                                        {identities.map(identity => {
                                            const cfg = CHANNEL_CONFIG[identity.channel]
                                            const isWriting = writingIdentityId === identity.id
                                            const chStatus = channelStatus[identity.channel]
                                            const hasFailed = chStatus?.status === 'failed'
                                            const liveEntry = liveReachabilityFor(identity.channel, {
                                                identityId: identity.id,
                                            })
                                            const linkedChat = contact.chats.find(c => c.contactIdentityId === identity.id)
                                            const routeKnown = Boolean(identity.externalId || linkedChat?.externalChatId)
                                            const presentation = deriveChannelReachabilityPresentation({
                                                persistedStatus: identity.reachabilityStatus,
                                                live: liveEntry,
                                                routeKnown,
                                                deliveryFailed: hasFailed,
                                                deliveryError: chStatus?.error,
                                            })
                                            const badges: ContactChannelBadge[] = [
                                                {
                                                    label: presentation.accountBadge.label,
                                                    className: presentation.accountBadge.className,
                                                    title: presentation.accountBadge.title,
                                                },
                                                ...(presentation.connectionBadge ? [presentation.connectionBadge] : []),
                                                ...(presentation.routeBadge ? [presentation.routeBadge] : []),
                                                ...getIdentitySourceBadges(identity, contact.identities.length),
                                            ]
                                            return (
                                                <ContactChannelRow
                                                    key={identity.id}
                                                    provider={identity.channel}
                                                    providerLabel={cfg?.label || identity.channel}
                                                    icon={cfg?.icon || '?'}
                                                    dotClassName={presentation.dotClassName}
                                                    dotTitle={presentation.dotTitle}
                                                    badges={badges}
                                                    isWriting={isWriting}
                                                    onWrite={() => handleWrite(identity.channel, identity.id)}
                                                    canWrite={presentation.canWrite}
                                                    writeDisabledReason={presentation.writeDisabledReason}
                                                    error={hasFailed ? (chStatus.error || 'Неизвестная ошибка доставки') : null}
                                                />
                                            )
                                        })}
                                        {/* Available channels without identity (can write via phone) */}
                                        {missingChannels.map(ch => {
                                            const cfg = CHANNEL_CONFIG[ch]
                                            const isWriting = writingIdentityId === `phone_${ch}`
                                            const liveEntry = liveReachabilityFor(ch, {
                                                phone: phone.phone,
                                            })
                                            const presentation = deriveChannelReachabilityPresentation({
                                                persistedStatus: 'unknown',
                                                live: liveEntry,
                                                routeKnown: false,
                                            })
                                            return (
                                                <ContactChannelRow
                                                    key={`missing-${ch}`}
                                                    provider={ch}
                                                    providerLabel={cfg?.label || ch}
                                                    icon={cfg?.icon || '?'}
                                                    dotClassName={presentation.dotClassName}
                                                    dotTitle={presentation.dotTitle}
                                                    badges={[
                                                        {
                                                            label: presentation.accountBadge.label,
                                                            className: presentation.accountBadge.className,
                                                            title: presentation.accountBadge.title,
                                                        },
                                                        ...(presentation.connectionBadge ? [presentation.connectionBadge] : []),
                                                    ]}
                                                    isWriting={isWriting}
                                                    onWrite={() => handleWrite(ch)}
                                                    canWrite={presentation.canWrite}
                                                    writeDisabledReason={presentation.writeDisabledReason}
                                                    muted
                                                />
                                            )
                                        })}
                                    </div>
                                </div>
                            )
                        })}

                        {/* Identities without phone (e.g. MAX, TG with no phone) */}
                        {orphanIdentities.map(identity => {
                            const cfg = CHANNEL_CONFIG[identity.channel]
                            const isWriting = writingIdentityId === identity.id
                            const chStatus = channelStatus[identity.channel]
                            const hasFailed = chStatus?.status === 'failed'
                            const liveEntry = liveReachabilityFor(identity.channel, {
                                identityId: identity.id,
                            })
                            const linkedChat = contact.chats.find(c => c.contactIdentityId === identity.id)
                            const routeKnown = Boolean(identity.externalId || linkedChat?.externalChatId)
                            const presentation = deriveChannelReachabilityPresentation({
                                persistedStatus: identity.reachabilityStatus,
                                live: liveEntry,
                                routeKnown,
                                deliveryFailed: hasFailed,
                                deliveryError: chStatus?.error,
                            })
                            const badges: ContactChannelBadge[] = [
                                {
                                    label: presentation.accountBadge.label,
                                    className: presentation.accountBadge.className,
                                    title: presentation.accountBadge.title,
                                },
                                ...(presentation.connectionBadge ? [presentation.connectionBadge] : []),
                                ...(presentation.routeBadge ? [presentation.routeBadge] : []),
                                ...getIdentitySourceBadges(identity, contact.identities.length),
                            ]
                            return (
                                <OrphanIdentityRow
                                    key={identity.id}
                                    identity={identity}
                                    cfg={cfg}
                                    isWriting={isWriting}
                                    onWrite={() => handleWrite(identity.channel, identity.id)}
                                    badges={badges}
                                    dotClassName={presentation.dotClassName}
                                    dotTitle={presentation.dotTitle}
                                    canWrite={presentation.canWrite}
                                    writeDisabledReason={presentation.writeDisabledReason}
                                    error={hasFailed ? (chStatus.error || 'Неизвестная ошибка доставки') : null}
                                />
                            )
                        })}
                    </div>
                ) : !chat.contactId ? (
                    /* Fallback: no Contact linked */
                    <div className="px-[4px] py-2.5">
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

                {/* Telegram Bot state is present for every canonical Contact. */}
                {contact && (
                    <>
                        <div
                            className="px-[4px] py-2.5"
                            data-telegram-bot-block
                            data-telegram-bot-state={telegramBotDisplayStatus}
                        >
                            <div className="flex items-center justify-between mb-[6px]">
                                <h4 className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Telegram-бот водителя</h4>
                                <a
                                    href="/settings/integrations/bot"
                                    className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-[#3390EC] hover:text-[#2B7FD4]"
                                    title="Открыть настройки Telegram-бота"
                                >
                                    Настройки <ExternalLink size={9} />
                                </a>
                            </div>

                            {botTelegramId && (
                                <div className="mb-1.5 flex min-w-0 items-center gap-1">
                                    {contact.telegramIdentity?.displayName && (
                                        <span className="truncate text-[11px] font-medium text-[#111]">
                                            {contact.telegramIdentity.displayName}
                                        </span>
                                    )}
                                    {contact.telegramIdentity?.username && (
                                        <span className="shrink-0 text-[11px] text-[#3390EC]">@{contact.telegramIdentity.username}</span>
                                    )}
                                    {!contact.telegramIdentity?.displayName && !contact.telegramIdentity?.username && (
                                        <span className="text-[11px] text-gray-500">Telegram user</span>
                                    )}
                                </div>
                            )}

                            {telegramBotState?.driverProfile ? (
                                <div className="space-y-0.5 text-[11px] text-[#111]">
                                    <div className="flex items-center gap-1">
                                        <span className={`rounded px-1 py-px text-[9px] font-semibold ${
                                            telegramBotDisplayStatus === 'BOT_BOUND'
                                                ? 'bg-emerald-50 text-emerald-700'
                                                : 'bg-amber-50 text-amber-700'
                                        }`}>
                                            {telegramBotDisplayStatus === 'BOT_BOUND_TO_DISMISSED_PROFILE'
                                                ? 'Профиль уволен'
                                                : telegramBotDisplayStatus === 'BOT_BOUND_TO_NON_MAIN_PROFILE'
                                                    ? 'Не главный'
                                                    : 'Связан'}
                                        </span>
                                        <span className="font-medium">{telegramBotState.driverProfile.fullName}</span>
                                    </div>
                                    <div className="text-gray-500">
                                        {telegramBotState.parkName || telegramBotState.driverProfile.parkName}
                                        {' · '}{telegramBotState.driverProfile.employmentTypeLabel}
                                        {' · '}{telegramBotState.driverProfile.statusLabel}
                                    </div>
                                    {telegramBotState.boundAt && (
                                        <div className="text-[10px] text-gray-400">
                                            Привязано {new Date(telegramBotState.boundAt).toLocaleDateString('ru-RU')}
                                        </div>
                                    )}
                                    {telegramBotDisplayStatus === 'BOT_BOUND_TO_NON_MAIN_PROFILE' && (
                                        <div className="text-[10px] text-amber-700">
                                            Привязка отличается от главного профиля Contact
                                        </div>
                                    )}
                                    {telegramBotDisplayStatus === 'BOT_BOUND_TO_DISMISSED_PROFILE' && (
                                        <div className="text-[10px] text-amber-700">
                                            Выберите действующий профиль водителя
                                        </div>
                                    )}
                                </div>
                            ) : telegramBotDisplayStatus === 'BOT_BOUND_WITHOUT_PROFILE' ? (
                                <div className="text-[11px] text-amber-700">Бот привязан, но DriverProfile этого Contact не выбран</div>
                            ) : telegramBotDisplayStatus === 'CONFLICT' ? (
                                <div className="text-[11px] text-red-600">Обнаружена конфликтующая привязка. Требуется проверка.</div>
                            ) : telegramBotDisplayStatus === 'TEMPORARILY_UNAVAILABLE' ? (
                                <div className="text-[11px] text-gray-500">Данные Telegram-бота временно недоступны. Карточка Contact продолжает работать.</div>
                            ) : telegramBotDisplayStatus === 'TELEGRAM_DISCOVERED_BY_PHONE' ? (
                                <div className="text-[11px] text-amber-700">Telegram-аккаунт найден по номеру, но не подтверждён</div>
                            ) : telegramBotDisplayStatus === 'TELEGRAM_IDENTITY_AVAILABLE_BOT_UNBOUND' ? (
                                <div className="text-[11px] text-gray-500">Telegram identity найдена, бот не привязан к DriverProfile</div>
                            ) : liveReachability.telegram?.status === 'checking' ? (
                                <div className="text-[11px] text-gray-500">Проверяем Telegram-аккаунт</div>
                            ) : (
                                <div className="text-[11px] text-gray-500">Бот не найден</div>
                            )}

                            {telegramBotState?.lastUpdatedAt && (
                                <div className="mt-1 text-[10px] text-gray-400">
                                    Обновлено {new Date(telegramBotState.lastUpdatedAt).toLocaleString('ru-RU')}
                                </div>
                            )}

                            <div className="mt-2 flex flex-wrap items-center gap-1">
                                {canManageBotLink
                                    && telegramBotDisplayStatus !== 'CONFLICT'
                                    && telegramBotDisplayStatus !== 'TEMPORARILY_UNAVAILABLE'
                                    && contact.attachedProfiles.length > 0 && (
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setShowBotProfilePicker(value => !value)
                                            setBotLinkError(null)
                                        }}
                                        className="rounded bg-[#3390EC]/10 px-2 py-0.5 text-[10px] font-semibold text-[#3390EC] hover:bg-[#3390EC]/15"
                                    >
                                        {telegramBotState?.linked ? 'Сменить профиль' : 'Выбрать профиль'}
                                    </button>
                                )}
                                {telegramBotState?.linked && canManageBotLink && (
                                    <button
                                        type="button"
                                        onClick={handleBotUnlink}
                                        disabled={botLinkSaving}
                                        className="rounded bg-red-50 px-2 py-0.5 text-[10px] font-semibold text-red-600 hover:bg-red-100 disabled:opacity-50"
                                    >
                                        Отвязать
                                    </button>
                                )}
                            </div>

                            {showBotProfilePicker && (
                                <div className="mt-2 space-y-1 rounded-md border border-gray-100 bg-gray-50 p-1.5">
                                    <div className="text-[10px] text-gray-500">
                                        Выберите подтверждённый профиль этого Contact
                                    </div>
                                    {contact.attachedProfiles.map(profile => (
                                        <button
                                            key={profile.id}
                                            type="button"
                                            disabled={botLinkSaving}
                                            onClick={() => handleBotProfileLink(profile.id)}
                                            className="flex w-full items-center justify-between gap-1 rounded bg-white px-2 py-1 text-left hover:bg-blue-50 disabled:opacity-50"
                                        >
                                            <span className="min-w-0">
                                                <span className="block truncate text-[11px] font-medium text-[#111]">{profile.fullName}</span>
                                                <span className="block truncate text-[9px] text-gray-400">
                                                    {profile.parkName} · {profile.statusLabel}
                                                </span>
                                            </span>
                                            {botLinkSaving
                                                ? <Loader2 size={10} className="shrink-0 animate-spin text-[#3390EC]" />
                                                : telegramBotState?.driverProfile?.id === profile.id
                                                    ? <Check size={10} className="shrink-0 text-emerald-500" />
                                                    : null}
                                        </button>
                                    ))}
                                </div>
                            )}

                            {botLinkError && (
                                <div className="mt-1 text-[10px] text-red-600">{botLinkError}</div>
                            )}
                        </div>
                        <div className="h-px bg-[#E8E8E8] mx-3" />
                    </>
                )}

                {/* Custom Fields */}
                <div className="px-[4px] py-2.5">
                    <div className="mb-[2px] flex items-center justify-between">
                        <h4 className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Поля</h4>
                        {profileDataSaving && (
                            <span title="Сохраняем">
                                <Loader2 size={10} className="animate-spin text-[#3390EC]" />
                            </span>
                        )}
                    </div>
                    {profileDataError && (
                        <div className="mb-1 text-[10px] text-red-600">{profileDataError}</div>
                    )}

                    {/* Driver-specific fields from Contact */}
                    {contact?.driver && (
                        <div className="space-y-1.5 mb-[2px]">
                            <div className="flex items-center justify-between min-h-[28px]">
                                <span className="text-[12px] text-gray-500 w-[80px]">Сегмент</span>
                                <span className="text-[12px] font-medium text-[#111]">
                                    {getSegmentLabel(contact.driver.segment)}
                                </span>
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
                                    <div className="flex-1 flex items-center gap-1 ml-[2px]">
                                        {field.type === 'select' && field.options ? (
                                            <select autoFocus value={editingFieldValue} onChange={(e) => setEditingFieldValue(e.target.value)} onBlur={() => handleFieldSave(field.id, editingFieldValue)} className="flex-1 h-[24px] bg-[#F4F5F7] rounded px-[2px] text-[12px] text-[#111] outline-none border border-[#3390EC]/30">
                                                {field.options.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                                            </select>
                                        ) : field.type === 'date' ? (
                                            <input type="date" autoFocus value={editingFieldValue} onChange={(e) => setEditingFieldValue(e.target.value)} onBlur={() => handleFieldSave(field.id, editingFieldValue)} onKeyDown={(e) => { if (e.key === 'Enter') handleFieldSave(field.id, editingFieldValue); if (e.key === 'Escape') setEditingFieldId(null) }} className="flex-1 h-[24px] bg-[#F4F5F7] rounded px-[2px] text-[12px] text-[#111] outline-none border border-[#3390EC]/30" />
                                        ) : (
                                            <input type="text" autoFocus value={editingFieldValue} onChange={(e) => setEditingFieldValue(e.target.value)} onBlur={() => handleFieldSave(field.id, editingFieldValue)} onKeyDown={(e) => { if (e.key === 'Enter') handleFieldSave(field.id, editingFieldValue); if (e.key === 'Escape') setEditingFieldId(null) }} placeholder="Введите..." className="flex-1 h-[24px] bg-[#F4F5F7] rounded px-[2px] text-[12px] text-[#111] outline-none border border-[#3390EC]/30 placeholder:text-gray-400" />
                                        )}
                                        <button onClick={() => handleFieldSave(field.id, editingFieldValue)} className="text-[#3390EC]"><Check size={12} /></button>
                                    </div>
                                ) : (
                                    <div className="flex-1 flex items-center gap-1 ml-[2px]">
                                        <button onClick={() => { setEditingFieldId(field.id); setEditingFieldValue(typeof field.value === 'string' ? field.value : '') }} className="flex-1 text-left text-[12px] font-medium text-[#111] hover:text-[#3390EC] transition-colors truncate h-[24px] flex items-center">
                                            {field.value || <span className="text-gray-400 italic">—</span>}
                                            {field.type === 'select' && <ChevronDown size={10} className="ml-0.5 text-gray-400" />}
                                        </button>
                                        <button disabled={profileDataSaving} onClick={() => handleFieldDelete(field.id)} className="opacity-0 transition-all group-hover:opacity-100 text-gray-400 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-30"><Trash2 size={10} /></button>
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>

                    {showAddField ? (
                        <div className="mt-[2px] bg-[#F4F5F7] rounded-lg p-2.5 space-y-1.5 animate-in fade-in duration-150">
                            <input autoFocus value={newFieldLabel} onChange={(e) => setNewFieldLabel(e.target.value)} placeholder="Название поля..." onKeyDown={(e) => { if (e.key === 'Enter') handleAddField(); if (e.key === 'Escape') setShowAddField(false) }} className="w-full h-[26px] bg-white rounded px-[2px] text-[12px] outline-none placeholder:text-gray-400 text-[#111]" />
                            <div className="flex gap-1">
                                <select value={newFieldType} onChange={(e) => setNewFieldType(e.target.value as any)} className="flex-1 h-[26px] bg-white rounded px-[2px] text-[11px] outline-none text-[#111]">
                                    <option value="text">Текст</option>
                                    <option value="select">Список</option>
                                    <option value="date">Дата</option>
                                </select>
                                <button disabled={profileDataSaving} onClick={handleAddField} className="h-[26px] px-2.5 bg-[#3390EC] text-white text-[11px] font-semibold rounded hover:bg-[#2B7FD4] transition-colors disabled:cursor-not-allowed disabled:opacity-50">Добавить</button>
                            </div>
                        </div>
                    ) : (
                        <button onClick={() => setShowAddField(true)} className="mt-[2px] inline-flex items-center gap-0.5 text-[11px] text-[#3390EC] font-medium px-[2px] py-1 rounded-lg bg-[#3390EC]/5 hover:bg-[#3390EC]/10 transition-colors">
                            <Plus size={10} /> Добавить поле
                        </button>
                    )}
                </div>

                <div className="h-px bg-[#E8E8E8] mx-3" />

                {/* Tags */}
                <div className="px-[4px] py-2.5">
                    <h4 className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1.5">Теги</h4>
                    <div className="flex flex-wrap gap-1">
                        {tags.map(tag => (
                            <span key={tag} className="inline-flex items-center gap-1 bg-gray-100 text-[11px] text-gray-700 px-[2px] py-0.5 rounded-full">
                                {tag}
                                <button disabled={profileDataSaving} onClick={() => handleRemoveTag(tag)} className="text-gray-400 hover:text-gray-700 disabled:cursor-not-allowed disabled:opacity-40"><X size={10} /></button>
                            </span>
                        ))}
                        {showTagInput ? (
                            <input autoFocus value={tagInput} onChange={(e) => setTagInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') handleAddTag(); if (e.key === 'Escape') setShowTagInput(false); }} onBlur={() => { if (!tagInput.trim()) setShowTagInput(false); }} placeholder="Тег..." className="h-[22px] w-[80px] bg-gray-100 rounded-full px-[2px] text-[11px] outline-none placeholder:text-gray-400" />
                        ) : (
                            <button disabled={profileDataSaving} onClick={() => setShowTagInput(true)} className="inline-flex items-center gap-0.5 text-[11px] text-[#3390EC] font-medium px-[2px] py-0.5 rounded-full bg-[#3390EC]/5 hover:bg-[#3390EC]/10 transition-colors disabled:cursor-not-allowed disabled:opacity-40">
                                <Plus size={10} /> Тег
                            </button>
                        )}
                    </div>
                </div>

                <div className="h-px bg-[#E8E8E8] mx-3" />

                {/* Tasks Widget */}
                {taskDriverId ? (
                    <DriverTasksWidget driverId={taskDriverId} />
                ) : (
                    <div className="px-[4px] py-3">
                        <div className="flex items-center gap-[2px] mb-[2px] text-[#9ca3af]">
                            <ClipboardList className="w-[4px] h-[4px]" />
                            <span className="text-[14px] font-semibold">Задачи</span>
                        </div>
                        <div className="text-[12px] text-[#9ca3af] italic">DriverProfile не привязан к Contact</div>
                    </div>
                )}

                <div className="h-px bg-[#E8E8E8] mx-3" />

                {/* AI Agent */}
                <div className="px-[4px] py-2.5">
                    <h4 className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1.5">AI Агент</h4>
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                            <div className="h-[6px] w-[6px] rounded-full bg-gray-300" />
                            <span className="text-[12px] font-medium text-[#111]">Не настроен</span>
                        </div>
                        <span
                            className="text-[10px] text-gray-400"
                            title="Панель не создаёт локальный фиктивный статус. Настройка AI выполняется отдельной интеграцией."
                        >
                            Без автоматизации
                        </span>
                    </div>
                </div>

                <div className="h-px bg-[#E8E8E8] mx-3" />

                {/* Context Info */}
                <div className="px-[4px] py-2.5">
                    <h4 className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1.5">Контекст</h4>
                    <div className="space-y-[2px] text-[12px]">
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
                                    <span className="text-[#111] font-medium">{contact.canonicalSummary?.channelCount ?? countUniqueProviderChannels(contact.channels)}</span>
                                </div>
                            </>
                        )}
                    </div>
                </div>

                {contact && (
                    <>
                        <div className="h-px bg-[#E8E8E8] mx-3" />
                        <details className="px-[4px] py-2.5" data-testid="technical-data">
                            <summary className="cursor-pointer text-[10px] font-bold uppercase tracking-wider text-gray-400">Технические данные</summary>
                            <div className="mt-2 space-y-0.5 break-all font-mono text-[9px] text-gray-500">
                                <div>Contact: {contact.technicalData.contactId}</div>
                                <div>Profile schema: {contact.technicalData.schemaVersion}</div>
                                <div>Build marker: {contact.technicalData.buildMarker}</div>
                                <div>Resolution: {contact.technicalData.resolutionState}</div>
                                <div>Provider IDs: {contact.technicalData.providerIds.map(item => `${item.channel}:${item.externalId}`).join(', ') || 'нет'}</div>
                                {contact.telegramIdentity?.telegramUserId && (
                                    <div className="flex items-center gap-1">
                                        <span>Telegram userId: {contact.telegramIdentity.telegramUserId}</span>
                                        <button
                                            type="button"
                                            onClick={() => {
                                                navigator.clipboard.writeText(contact.telegramIdentity!.telegramUserId!).catch(() => {})
                                                setTgIdCopied(true)
                                                setTimeout(() => setTgIdCopied(false), 2000)
                                            }}
                                            className="text-gray-400 hover:text-[#3390EC]"
                                            title="Скопировать Telegram userId"
                                        >
                                            {tgIdCopied ? <Check size={9} /> : <Copy size={9} />}
                                        </button>
                                    </div>
                                )}
                                {contact.telegramIdentity?.lastObservedUsername && (
                                    <div>Telegram username: @{contact.telegramIdentity.lastObservedUsername}</div>
                                )}
                                {contact.telegramIdentity?.lastSyncAt && (
                                    <div>Telegram sync: {formatTechnicalDate(contact.telegramIdentity.lastSyncAt)}</div>
                                )}
                                <div>DriverProfile IDs: {contact.technicalData.driverProfileIds.join(', ') || 'нет'}</div>
                                <div>Suggested IDs: {contact.technicalData.suggestedProfileIds.join(', ') || 'нет'}</div>
                                <div>Last success: {formatTechnicalDate(contact.technicalData.lastSuccessfulSyncAt)}</div>
                                {contact.technicalData.profileSourceValues.map(profile => (
                                    <div key={profile.id}>
                                        {profile.id}: employment={profile.employmentTypeCode || 'unknown'}, work={profile.workStatusCode || 'unknown'}, current={profile.currentStatusCode || 'unknown'}
                                    </div>
                                ))}
                            </div>
                        </details>
                    </>
                )}
            </div>

            {showMessagesHelp && (
                <div className="fixed inset-0 bg-black/30 z-[100] flex items-center justify-center" onClick={() => setShowMessagesHelp(false)}>
                    <div className="bg-white rounded-xl shadow-2xl w-[420px] max-h-[560px] overflow-y-auto p-4" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center justify-between mb-3">
                            <h3 className="text-[15px] font-bold text-[#111]">Как работает раздел</h3>
                            <button onClick={() => setShowMessagesHelp(false)} className="text-gray-400 hover:text-gray-600"><X size={16} /></button>
                        </div>
                        <div className="space-y-2 text-[12px] text-gray-700 leading-snug">
                            {MESSAGES_HELP_SECTIONS.map(section => (
                                <p key={section.title}><strong>{section.title}</strong> {section.body}</p>
                            ))}
                        </div>
                    </div>
                </div>
            )}

            {showAddPhone && contact && (
                <AddPhoneResolutionDialog
                    contactId={contact.id}
                    onClose={() => setShowAddPhone(false)}
                    onResolved={async () => {
                        await refetchContact()
                        refreshConversations()
                    }}
                    onOpenContact={owner => {
                        if (!owner.chatId) return
                        setShowAddPhone(false)
                        updateQuery({ id: owner.chatId, profile: '1' })
                    }}
                    onReviewMerge={owner => {
                        setShowAddPhone(false)
                        setMergeMode('contact')
                        setMergeTarget({
                            id: owner.id,
                            displayName: owner.displayName,
                            phones: [{ phone: owner.phone }],
                            channels: owner.channels,
                        })
                        setMergeError(null)
                        setMergeSuccess(false)
                        setShowMergeDialog(true)
                    }}
                />
            )}

            {/* Task Create Modal */}
            {isTaskModalOpen && contactOrDriverId && (
                <TaskCreateModal
                    driverId={taskDriverId}
                    contactId={contact?.id}
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
                        <div className="px-[4px] py-3 border-b border-[#E8E8E8] flex items-center justify-between shrink-0">
                            <span className="text-[14px] font-bold text-[#111]">Объединить контакт</span>
                            <button onClick={() => setShowMergeDialog(false)} className="text-gray-400 hover:text-gray-600"><X size={16} /></button>
                        </div>

                        {/* Success state */}
                        {mergeSuccess ? (
                            <div className="px-[4px] py-[8px] flex flex-col items-center gap-[2px]">
                                <Check size={32} className="text-emerald-500" />
                                <span className="text-[14px] font-semibold text-[#111]">Контакты объединены</span>
                                <button onClick={() => setShowMergeDialog(false)} className="mt-[2px] px-[4px] py-1.5 bg-[#3390EC] text-white text-[12px] font-semibold rounded-lg hover:bg-[#2B7FD4]">
                                    Закрыть
                                </button>
                            </div>
                        ) : !mergeMode ? (
                            /* Mode selection */
                            <div className="px-[4px] py-3 space-y-[2px]">
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
                            <div className="px-[4px] py-[4px] space-y-3">
                                <p className="text-[12px] text-gray-600">
                                    {mergeMode === 'contact'
                                        ? contact?.yandexDriverId
                                            ? <>Влить <strong>{mergeTarget.displayName}</strong> в текущий контакт <strong>{displayName}</strong>?</>
                                            : <>Влить <strong>{displayName}</strong> в <strong>{mergeTarget.displayName}</strong>?</>
                                        : <>Привязать <strong>{displayName}</strong> к водителю <strong>{mergeTarget.fullName || mergeTarget.displayName}</strong>?</>
                                    }
                                </p>
                                {mergePreviewLoading && (
                                    <p className="text-[11px] text-gray-500 flex items-center gap-1">
                                        <Loader2 size={11} className="animate-spin" />
                                        Проверяем состав карточек...
                                    </p>
                                )}
                                {mergePreview && (
                                    <div className="border-y border-[#E8E8E8] py-2 text-[10px] text-gray-600 space-y-1">
                                        <div className="grid grid-cols-3 gap-x-2 gap-y-1">
                                            <span>Каналы: {mergePreview.entities.identities.count}</span>
                                            <span>Телефоны: {mergePreview.entities.phones.count}</span>
                                            <span>Чаты: {mergePreview.entities.chats.count}</span>
                                            <span>Сообщения: {mergePreview.entities.messages.count}</span>
                                            <span>Звонки: {mergePreview.entities.calls.count}</span>
                                            <span>Задачи: {mergePreview.entities.tasks.count}</span>
                                            <span>Профили: {mergePreview.entities.driverProfiles.count}</span>
                                            <span>Аудит: {mergePreview.entities.profileAudits.count}</span>
                                            <span>Telegram Bot: {mergePreview.entities.telegramBindings.count}</span>
                                        </div>
                                        {mergePreview.warnings.map(warning => (
                                            <p key={warning} className="text-amber-700">{warning}</p>
                                        ))}
                                        {mergePreview.conflicts.map(conflict => (
                                            <p key={conflict} className="text-amber-700">{conflict}</p>
                                        ))}
                                        {mergePreview.blockers.map(blocker => (
                                            <p key={blocker.code} className="text-red-600">{blocker.message}</p>
                                        ))}
                                        <p className="text-gray-400">Будет сохранён операторский rollback manifest.</p>
                                    </div>
                                )}
                                {mergeError && <p className="text-[11px] text-red-500 bg-red-50 px-[2px] py-1 rounded">{mergeError}</p>}
                                <div className="flex gap-[2px]">
                                    <button onClick={() => { setMergeTarget(null); setMergePreview(null); setMergeError(null) }} className="flex-1 h-[32px] bg-gray-100 text-gray-700 text-[12px] font-semibold rounded-lg hover:bg-gray-200">
                                        Назад
                                    </button>
                                    <button
                                        onClick={async () => {
                                            setMergeLoading(true); setMergeError(null)
                                            try {
                                                let res: Response
                                                if (mergePreview) {
                                                    res = await fetch(`/api/contacts/${mergePreview.source.id}/merge-to/${mergePreview.target.id}`, {
                                                        method: 'POST',
                                                        headers: { 'Content-Type': 'application/json' },
                                                        body: JSON.stringify({
                                                            planHash: mergePreview.planHash,
                                                            sourceVersion: mergePreview.sourceVersion,
                                                            targetVersion: mergePreview.targetVersion,
                                                            confirmationToken: mergePreview.confirmationToken,
                                                        }),
                                                    })
                                                } else if (mergeMode === 'driver') {
                                                    res = await fetch(`/api/contacts/${contact?.id || chat?.contactId}/merge`, {
                                                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                                                        body: JSON.stringify({ driverId: mergeTarget.id }),
                                                    })
                                                } else {
                                                    throw new Error('Сначала дождитесь плана объединения')
                                                }
                                                const data = await res.json()
                                                if (data.status === 'merge_confirmation_required' && data.preview) {
                                                    setMergePreview(data.preview as ContactMergePreviewPayload)
                                                    setMergeError('Проверьте состав карточек и подтвердите объединение ещё раз')
                                                    return
                                                }
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
                                        disabled={
                                            mergeLoading
                                            || mergePreviewLoading
                                            || (mergeMode === 'contact' && !mergePreview)
                                            || Boolean(mergePreview?.blockers.length)
                                        }
                                        className="flex-1 h-[32px] bg-[#3390EC] text-white text-[12px] font-semibold rounded-lg hover:bg-[#2B7FD4] disabled:opacity-50 flex items-center justify-center gap-1"
                                    >
                                        {mergeLoading ? <Loader2 size={12} className="animate-spin" /> : <GitMerge size={12} />}
                                        {mergePreview ? 'Подтвердить' : mergeMode === 'driver' ? 'Привязать' : 'Объединить'}
                                    </button>
                                </div>
                            </div>
                        ) : (
                            /* Search */
                            <div className="flex flex-col min-h-0">
                                <div className="px-3 py-[2px] shrink-0">
                                    <div className="relative">
                                        <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                                        <input
                                            type="text"
                                            value={mergeSearch}
                                            onChange={e => setMergeSearch(e.target.value)}
                                            placeholder={mergeMode === 'driver' ? 'Поиск водителя...' : 'Поиск контакта (имя, телефон)...'}
                                            className="w-full h-[32px] bg-[#F4F5F7] rounded-lg pl-[8px] pr-3 text-[12px] outline-none placeholder:text-gray-400"
                                            autoFocus
                                        />
                                    </div>
                                    <button onClick={() => { setMergeMode(null); setMergeSearch('') }} className="text-[11px] text-[#3390EC] mt-1 hover:underline">
                                        ← Назад к выбору типа
                                    </button>
                                </div>
                                <div className="flex-1 overflow-y-auto max-h-[280px]">
                                    {mergeSearchLoading && mergeSearch.length >= 2 && (
                                        <div className="px-[4px] py-3 text-[11px] text-gray-400 flex items-center gap-[2px]">
                                            <Loader2 size={12} className="animate-spin" /> Поиск...
                                        </div>
                                    )}
                                    {mergeSearch.length >= 2 && !mergeSearchLoading && mergeSearchResults.length === 0 && (
                                        <div className="px-[4px] py-6 text-center text-[12px] text-gray-400">Ничего не найдено</div>
                                    )}
                                    {mergeSearchResults.filter(r => r.id !== contact?.id).map(result => {
                                        const phone = result.phones?.[0]?.phone
                                        const driverProfileId = result.mainDriverProfileId
                                        const isValidTarget = mergeMode === 'driver' ? Boolean(driverProfileId) : true
                                        return (
                                            <button
                                                key={result.id}
                                                onClick={() => isValidTarget && setMergeTarget(
                                                    mergeMode === 'driver'
                                                        ? { id: driverProfileId, displayName: result.displayName, fullName: result.displayName }
                                                        : result,
                                                )}
                                                disabled={!isValidTarget}
                                                className={`w-full px-3 py-[2px] text-left flex items-center gap-2.5 transition-colors ${
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
