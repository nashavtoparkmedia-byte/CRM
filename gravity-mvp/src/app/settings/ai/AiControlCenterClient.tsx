'use client'

import { useState, useEffect, useRef, useTransition } from 'react'
import {
    Bot, Database, Settings, BookOpen, ClipboardList,
    Play, Pause, CheckCircle2, XCircle, AlertCircle,
    Plus, Trash2, Save, RefreshCw, ChevronDown, ChevronUp,
    Zap, MessageSquare, Phone, Send, Square, X, HelpCircle,
    Loader2,
    // AI Knowledge Core: tab icon + section icons + UX.
    Library, Wallet, FileText, PiggyBank, Clock, Banknote,
    MessageCircle, AlertTriangle, CheckSquare, Ban, ChevronRight, Sparkles,
} from 'lucide-react'
import {
    saveAiConfig, testAiConnection, testSavedConnection,
    getKnowledgeBase, createKnowledgeEntry, updateKnowledgeEntry, deleteKnowledgeEntry,
    getDecisionLogs, setOperatorVerdict,
    createImportJob, getAllImportJobs, cancelImportJob, deleteImportJob,
    getAiRuntimeStats, checkScraperHealth,
    createAiProfile, updateAiProfile, deleteAiProfile, setActiveAiProfile,
    listKnowledgeSections, listItemsBySection, listExtractionJobs,
    startKnowledgeExtraction, getExtractionJob, saveExtractionQualityTier,
    getKnowledgeStats as getKnowledgeStatsAction,
    editKnowledgeItem, archiveKnowledgeItem, restoreKnowledgeItem,
    verifyKnowledgeItem, supersedeKnowledgeItem, resolveConflict,
    createManualKnowledgeItem, getKnowledgeAuditLog,
    listRecentRetrievalTraces, getKnowledgeRuntimeStateForUi,
    getDecisionExplainabilityForUi, previewDecisionRetry,
    getKnowledgeReadinessForUi,
    getLegacyMigrationPreview, migrateLegacyKnowledgeBase,
    listChannelConnections,
    getSourceStatsByConnection, disableKnowledgeSource, resetKnowledgeCore,
    getItemSourceBadges,
    getChannelTotalsForUi,
    getMessageCountsByConnection,
    getExtractionDataRange,
    bulkVerifyItems, bulkArchiveDraftsInSection,
    type ExplainabilityBundle,
    type KnowledgeReadinessBundle,
    type LegacyMigrationPreview, type LegacyMigrationResult,
    type ChannelConnection,
    type SourceStatsRow, type DisableSourceResult,
    type ResetMode, type ResetResult,
    type BulkActionResult,
    type RetryPreviewResult,
    type AiProfileData,
    type KnowledgeSection, type KnowledgeItem, type KnowledgeStats,
    type ExtractionScope,
    type ItemSourceBadges,
    type ChannelTotalsRow,
    type ConnectionMessageCount,
    type ExtractionDataRange,
} from './actions'

// ─── Типы ─────────────────────────────────────────────────────────

interface AiConfig {
    id: string
    enabled: boolean
    mode: string
    provider: string
    apiKeyEncrypted?: string | null
    classificationModel: string
    responseModel: string
    language: string
    confidenceThreshold: number
    maxAutoRepliesPerChat: number
    activeChannels: string[]
    escalationPolicy?: any
    workingHours?: any
    routingRules?: any
    promptRole?: string | null
    promptTone?: string | null
    promptAllowed?: string | null
    promptForbidden?: string | null
    connectionStatus?: string | null
    lastConnectionCheckAt?: string | null
}

interface KbEntry {
    id: string
    title: string
    category: string
    sampleQuestions: string[]
    answer: string
    tags: string[]
    channels: string[]
    active: boolean
    priority: number
}

interface ImportJob {
    id: string
    channels: string[]
    mode: string
    status: string
    resultType?: string | null
    startedAt?: string | null
    finishedAt?: string | null
    chatsScanned: number
    contactsFound: number
    messagesImported: number
    coveredPeriodFrom?: string | null
    coveredPeriodTo?: string | null
    createdAt: string
}

interface DecisionLog {
    id: string
    channel?: string | null
    detectedIntent?: string | null
    confidence?: number | null
    decision?: string | null
    selectedModel?: string | null
    generatedReply?: string | null
    replySent: boolean
    escalated: boolean
    error?: string | null
    reviewedByOperator: boolean
    operatorVerdict?: string | null
    createdAt: string
}

interface RuntimeStats {
    total: number
    autoReplied: number
    escalated: number
    errors: number
}

interface Props {
    initialConfig: AiConfig | null
    initialKb: KbEntry[]
    initialImportJobs: ImportJob[]
    initialLogs: DecisionLog[]
    initialStats: RuntimeStats
    /** Стили общения (Роль/Тон/Разрешено/Запрещено). Один активен. */
    initialProfiles: AiProfileData[]
    initialActiveProfileId: string | null
    /** AI Knowledge Core (PR1, read-only). Секции — "оглавление книги". */
    initialSections: KnowledgeSection[]
    initialKnowledgeStats: KnowledgeStats
    initialExtractionJobs: unknown[]
    /** Сохранённый пресет модели для extraction (PR2). */
    initialExtractionTier: 'economy' | 'balanced' | 'quality'
    /** Operational readiness bundle (PR5). counts + lastExtraction +
     *  activity7d + checks[]. UI обновляет после governance-операций
     *  через refreshReadiness(). */
    initialReadiness: KnowledgeReadinessBundle
    /** Администратор/Руководитель видит все вкладки и может менять настройки.
     *  Менеджеру оставлен только Журнал (read-only + 👍/👎). */
    canEdit: boolean
}

// ─── Переиспользуемые UI-примитивы ────────────────────────────────

/** Короткая подсказка в одну-две строки, рядом с действием. Telegram-
 *  style: спокойный серый текст, без иконки и без bg-обёртки. Тонкий
 *  left-border накапливает «это пояснение», но не кричит «callout».
 *  Раньше было border + bg + Info-иконка — выглядело корпоративно
 *  и тяжело. */
function InlineInfo({ children }: { children: React.ReactNode }) {
    return (
        <p className="text-[12px] text-gray-500 leading-[1.5] border-l-2 border-[#E8E8E8] pl-3">
            {children}
        </p>
    )
}

/** «?»-иконка с native title-tooltip. Минималистичный паттерн из
 *  ai-call-scenarios — без библиотечного popover, чтобы не утяжелять. */
function Hint({ text }: { text: string }) {
    return (
        <span
            role="img"
            aria-label="Подсказка"
            title={text}
            className="inline-flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full text-gray-300 hover:text-gray-500 transition-colors"
        >
            <HelpCircle size={13} />
        </span>
    )
}

// ─── Утилиты ──────────────────────────────────────────────────────

const CHANNEL_LABELS: Record<string, string> = { max: 'MAX', telegram: 'TG', whatsapp: 'WA' }

// AI Knowledge Core: маппинг iconKey → lucide-компонент. Неизвестный/null → BookOpen.
const SECTION_ICONS: Record<string, typeof BookOpen> = {
    Wallet, CheckCircle2, FileText, PiggyBank, Clock, Banknote,
    MessageCircle, AlertTriangle, CheckSquare, Ban, BookOpen,
}

// PR2.5 audit action labels для UI "История".
const ACTION_LABEL: Record<string, string> = {
    created:           'Создано экстрактором',
    manual_created:    'Создано вручную',
    edited:            'Отредактировано',
    archived:          'В архив',
    restored:          'Восстановлено',
    verified:          'Подтверждено',
    unverified:        'Подтверждение снято',
    superseded:        'Заменено новым знанием',
    conflict_resolved: 'Конфликт разрешён',
    source_added:      'Добавлен источник',
}

// PR4: human-readable labels для explainability модалки.
const DECISION_HUMAN: Record<string, string> = {
    auto_reply: 'Ответил сам',
    escalate:   'Передал менеджеру',
    skip:       'Не отвечал',
}
const RETRIEVAL_MODE_HUMAN: Record<string, string> = {
    legacy:  'Старая база FAQ',
    shadow:  'Тестовый режим — новое ядро работало в фоне',
    runtime: 'Активный режим — ответ из ядра знаний',
}
const ESCALATION_HUMAN: Record<string, string> = {
    conflict:       'Конфликт в знаниях компании — два правила противоречат друг другу',
    requires_human: 'Запрос требует решения менеджера',
    low_confidence: 'Недостаточная уверенность в найденных знаниях',
    no_relevant:    'Не нашёл подходящих знаний по этому запросу',
    only_drafts:    'Найдены только черновые знания, не прошедшие проверку',
    ambiguous:      'Запрос можно понять по-разному',
    safety_block:   'Сработал защитный фильтр',
}
const USAGE_REASON_HUMAN: Record<string, string> = {
    used:                     'Использовано в ответе',
    filtered_archived:        'Пропущено: знание в архиве',
    filtered_superseded:      'Пропущено: знание заменено новым',
    filtered_draft:           'Пропущено: знание черновое',
    filtered_low_confidence:  'Пропущено: низкая уверенность',
    filtered_low_evidence:    'Пропущено: мало источников',
    filtered_conflict:        'Пропущено: участвует в конфликте',
    filtered_requires_human:  'Пропущено: требует менеджера',
    filtered_safety:          'Пропущено: защитный фильтр',
    filtered_escalation:      'Не дошло до ответа: эскалация',
    filtered_no_knowledge:    'Не использовано',
}
const AUDIT_AFTER_HUMAN: Record<string, string> = {
    created:           'создано экстрактором',
    manual_created:    'создано вручную',
    edited:            'отредактировано',
    archived:          'в архив',
    restored:          'восстановлено',
    verified:          'подтверждено',
    unverified:        'подтверждение снято',
    superseded:        'заменено новым знанием',
    conflict_resolved: 'конфликт разрешён',
    source_added:      'добавлен источник',
}

// Однострочные подсказки к счётчикам импорта. Старый StatHint был портянкой
// из 6 строк и одинаков для «Сообщений» / «Чатов» (copy-paste). По принципу
// AI-обзвона: одна строка, рядом с действием.
const STAT_HINT: Record<string, string> = {
    'Сообщений': 'Все сообщения за выбранный период — входящие и исходящие, текст и медиа.',
    'Чатов':     'Сколько чатов попало в импорт.',
    'Контактов': 'Уникальные собеседники. У одного контакта может быть несколько чатов.',
}
// Что AI реально делает в каждом режиме — для шапки и для tooltip-ов.
// Это «mental model»: вместо «mode = suggest_only» показываем «AI
// подсказывает ответы». Помогает админу не держать в голове термины.
const RUNNING_LABEL: Record<string, string> = {
    off:             'AI не работает',
    suggest_only:    'AI подсказывает ответы',
    auto_reply:      'AI отвечает сам, сложное передаёт менеджеру',
    operator_locked: 'AI передаёт все диалоги менеджерам',
}

// Простая склейка-«N ответов / переданы менеджеру / ошибки» в одну
// человеческую фразу, без слэшей и цифр-через-разделитель.
function plural(n: number, one: string, few: string, many: string) {
    const mod10 = n % 10
    const mod100 = n % 100
    if (mod10 === 1 && mod100 !== 11) return one
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few
    return many
}

function StatusDot({ status, detail }: { status: string, detail?: React.ReactNode }) {
    const [show, setShow] = useState(false)
    const color =
        status === 'completed' || status === 'ok'  ? 'bg-green-500' :
        status === 'running'   || status === 'queued' ? 'bg-yellow-400 animate-pulse' :
        status === 'partial'                         ? 'bg-yellow-500' :
        status === 'failed'    || status === 'error'  ? 'bg-red-500' : 'bg-gray-300'

    return (
        <div className="relative inline-flex items-center">
            <button
                onMouseEnter={() => setShow(true)}
                onMouseLeave={() => setShow(false)}
                onClick={() => setShow(v => !v)}
                className={`w-2.5 h-2.5 rounded-full ${color} cursor-pointer`}
            />
            {show && detail && (
                <div className="absolute left-4 top-0 z-50 bg-white border border-gray-200 rounded-lg shadow-lg p-3 min-w-[220px] text-[11px] text-[#111]">
                    {detail}
                </div>
            )}
        </div>
    )
}

// ─── Главный компонент ─────────────────────────────────────────────

export default function AiControlCenterClient({
    initialConfig, initialKb, initialImportJobs, initialLogs, initialStats,
    initialProfiles, initialActiveProfileId,
    initialSections, initialKnowledgeStats, initialExtractionJobs, initialExtractionTier,
    initialReadiness,
    canEdit,
}: Props) {
    // Менеджеру открываем сразу Журнал — это единственная вкладка, где он
    // что-то делает. Админ/Руководитель — начинают с Синхронизации, как и
    // раньше.
    const [tab, setTab] = useState<'sync' | 'provider' | 'rules' | 'kb' | 'knowledge' | 'log'>(canEdit ? 'sync' : 'log')
    const [config, setConfig] = useState<AiConfig>(initialConfig ?? {
        id: 'singleton', enabled: false, mode: 'off', provider: 'anthropic',
        classificationModel: 'claude-haiku-4-5', responseModel: 'claude-sonnet-4-5',
        language: 'ru', confidenceThreshold: 0.75, maxAutoRepliesPerChat: 5,
        activeChannels: [],
    })
    const [kb, setKb]                 = useState<KbEntry[]>(initialKb)
    const [importJobs, setImportJobs] = useState<ImportJob[]>(initialImportJobs)
    const [logs, setLogs]             = useState<DecisionLog[]>(initialLogs)
    const [stats, setStats]           = useState<RuntimeStats>(initialStats)
    const [profiles, setProfiles]     = useState<AiProfileData[]>(initialProfiles)
    const [activeProfileId, setActiveProfileId] = useState<string | null>(initialActiveProfileId)
    const [isPending, startTransition] = useTransition()
    const [toast, setToast]           = useState<string | null>(null)

    // ─── AI Knowledge Core (PR1+PR2) ─────────────────────────────
    const [sections, setSections] = useState<KnowledgeSection[]>(initialSections)
    const [knowledgeStats, setKnowledgeStats] = useState<KnowledgeStats>(initialKnowledgeStats)
    const [extractionJobs, setExtractionJobs] = useState<unknown[]>(initialExtractionJobs)
    const [knowledgeSubtab, setKnowledgeSubtab] =
        useState<'core' | 'sources' | 'archive'>('core')
    const [selectedSectionId, setSelectedSectionId] = useState<string | null>(
        initialSections.find(s => s.isActive)?.id ?? initialSections[0]?.id ?? null
    )
    const [knowledgeItems, setKnowledgeItems] = useState<KnowledgeItem[]>([])
    const [knowledgeItemsLoading, setKnowledgeItemsLoading] = useState(false)
    // PR7.12: compact source badges per item — «откуда взято» одной
    // строкой на карточке. Map itemId → badges. Загружается batch'ем
    // после items, чтобы не делать N+1 запрос на render.
    const [itemBadges, setItemBadges] = useState<Record<string, ItemSourceBadges>>({})
    // Подгружаем items при смене секции / подвкладки (Ядро ↔ Архив).
    // В "Источники" items не нужны — там показывается список jobs.
    useEffect(() => {
        if (!selectedSectionId) { setKnowledgeItems([]); setItemBadges({}); return }
        if (knowledgeSubtab === 'sources') return
        let cancelled = false
        setKnowledgeItemsLoading(true)
        listItemsBySection(selectedSectionId, {
            includeArchived: knowledgeSubtab === 'archive',
        })
            .then(async arr => {
                if (cancelled) return
                const items = arr as KnowledgeItem[]
                setKnowledgeItems(items)
                // Batch fetch badges. Не блокирует render — items уже
                // показаны, badges дойдут до 200ms позже.
                try {
                    const badges = await getItemSourceBadges(items.map(i => i.id))
                    if (!cancelled) setItemBadges(badges as Record<string, ItemSourceBadges>)
                } catch {
                    if (!cancelled) setItemBadges({})
                }
            })
            .catch(() => { if (!cancelled) { setKnowledgeItems([]); setItemBadges({}) } })
            .finally(() => { if (!cancelled) setKnowledgeItemsLoading(false) })
        return () => { cancelled = true }
    }, [selectedSectionId, knowledgeSubtab])

    // ─── Extraction (PR2.6) ──────────────────────────────────────
    const [extractionModalOpen, setExtractionModalOpen] = useState(false)
    const [extractionScopeMode, setExtractionScopeMode] =
        useState<'last_30d' | 'last_90d' | 'all'>('last_90d')
    const [extractionTier, setExtractionTier] =
        useState<'economy' | 'balanced' | 'quality'>(initialExtractionTier)
    const [extractionStarting, setExtractionStarting] = useState(false)
    // PR7.4: source-selector state.
    // — channelConnections: список подключений всех каналов (lazy load
    //   при первом открытии модала).
    // — selectedConnectionIds: подключения которые админ оставил
    //   ☑ в чекбоксах. По default — все ready. При unselect WA
    //   connection — pairBuilder реально отрежет его сообщения.
    // — onlyConnectedNow: convenience toggle. Если true, отключённые
    //   подключения автоматически снимаются из selected.
    const [channelConnections, setChannelConnections] = useState<ChannelConnection[]>([])
    const [channelConnectionsLoading, setChannelConnectionsLoading] = useState(false)
    const [selectedConnectionIds, setSelectedConnectionIds] = useState<Set<string>>(new Set())
    const [onlyConnectedNow, setOnlyConnectedNow] = useState(true)
    // PR7.9: «Источники» panel state — статистика per connection
    // и состояние disable / reset операций.
    const [sourceStats, setSourceStats] = useState<SourceStatsRow[]>([])
    const [disableInFlight, setDisableInFlight] = useState<string | null>(null)
    const [resetModalOpen, setResetModalOpen] = useState(false)
    const [resetMode, setResetMode] = useState<ResetMode | null>(null)
    const [resetTypedConfirm, setResetTypedConfirm] = useState('')
    const [resetRunning, setResetRunning] = useState(false)
    const [resetResult, setResetResult] = useState<ResetResult | null>(null)
    interface ExtractionJobLite {
        id: string
        status: string
        progress: Record<string, number> | null
        extractionProvider?: string | null
        extractionModel?: string | null
        extractionPromptVersion?: string | null
        extractionQualityTier?: string | null
        startedAt?: string | null
        finishedAt?: string | null
        errorMessage?: string | null
    }
    const [activeExtractionJob, setActiveExtractionJob] = useState<ExtractionJobLite | null>(null)

    // Polling — только пока queued/running. На terminal status — финальный
    // refresh sections+stats+items + toast feedback.
    useEffect(() => {
        if (!activeExtractionJob) return
        if (activeExtractionJob.status === 'completed' ||
            activeExtractionJob.status === 'partial' ||
            activeExtractionJob.status === 'failed') {
            // UX-фикс: failed job отрабатывает мгновенно (нет ключа / нет
            // сообщений). Без toast пользователь не понимал что произошло.
            if (activeExtractionJob.status === 'failed') {
                const msg = activeExtractionJob.errorMessage || 'неизвестная ошибка'
                showToast('Сбор ядра не запущен: ' + msg)
            } else if (activeExtractionJob.status === 'partial') {
                showToast('Сбор завершён частично — детали в Источниках')
            } else {
                const created = (activeExtractionJob.progress as Record<string, number> | null)?.itemsCreated ?? 0
                const merged = (activeExtractionJob.progress as Record<string, number> | null)?.itemsMerged ?? 0
                showToast(`Сбор завершён: ${created} ${plural(created,'новое','новых','новых')} ${plural(created,'знание','знания','знаний')}` + (merged > 0 ? ` · ${merged} обновлено` : ''))
            }
            // PR9.1: после terminal status'а обновляем ВЕСЬ kernel state —
            // не только sections+stats, но и readiness + sourceStats +
            // channelTotals + connectionCounts. Без этого:
            //   1) passport «Текущее ядро AI» остаётся coreEmpty
            //      (readiness.counts.activeItems = SSR initial)
            //   2) red alert «Последний сбор не удался» висит, потому что
            //      readiness.lastExtraction указывает на старый failed job
            //   3) «Собрано из» не показывает свежие sources
            Promise.all([
                listKnowledgeSections(),
                getKnowledgeStatsAction(),
                listExtractionJobs(10),
                getKnowledgeReadinessForUi(),
                getSourceStatsByConnection(),
                getChannelTotalsForUi(),
                getMessageCountsByConnection(),
            ]).then(([s, st, jobs, readinessFresh, sourceStatsFresh, totalsFresh, connCountsFresh]) => {
                setSections(s as KnowledgeSection[])
                setKnowledgeStats(st as KnowledgeStats)
                setExtractionJobs(jobs)
                setReadiness(readinessFresh as KnowledgeReadinessBundle)
                setSourceStats(sourceStatsFresh as SourceStatsRow[])
                setChannelTotals(totalsFresh as ChannelTotalsRow[])
                setConnectionCounts(connCountsFresh as ConnectionMessageCount[])
                if (selectedSectionId) {
                    listItemsBySection(selectedSectionId, {
                        includeArchived: knowledgeSubtab === 'archive',
                    }).then(arr => setKnowledgeItems(arr as KnowledgeItem[]))
                }
            }).catch(() => { /* silent */ })
            return
        }
        const interval = setInterval(async () => {
            const fresh = await getExtractionJob(activeExtractionJob.id)
            if (fresh) setActiveExtractionJob(fresh as ExtractionJobLite)
        }, 2000)
        return () => clearInterval(interval)
    }, [activeExtractionJob, selectedSectionId, knowledgeSubtab])

    // ─── Governance (PR2.5) ──────────────────────────────────────
    const [editingItem, setEditingItem] = useState<KnowledgeItem | null>(null)
    const [editForm, setEditForm] = useState({
        title: '', canonicalStatement: '', tagsCsv: '',
        safetyLevel: 'normal' as 'normal' | 'sensitive' | 'requires_human',
    })
    const [editTab, setEditTab] = useState<'fields' | 'history'>('fields')
    const [editSaving, setEditSaving] = useState(false)
    interface AuditEntry {
        id: string
        action: string
        actor: string | null
        createdAt: string
        metadata: Record<string, unknown> | null
    }
    const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([])

    const [manualCreateOpen, setManualCreateOpen] = useState(false)
    const [manualForm, setManualForm] = useState({
        title: '', canonicalStatement: '', tagsCsv: '',
        safetyLevel: 'normal' as 'normal' | 'sensitive' | 'requires_human',
    })
    const [manualSaving, setManualSaving] = useState(false)

    const [supersedeFor, setSupersedeFor] = useState<KnowledgeItem | null>(null)
    const [conflictFor, setConflictFor] = useState<KnowledgeItem | null>(null)
    const [conflictMembers, setConflictMembers] = useState<KnowledgeItem[]>([])

    // PR4: explainability модалка "Почему AI так ответил?"
    const [explainBundle, setExplainBundle] = useState<ExplainabilityBundle | null>(null)
    const [explainOpen, setExplainOpen] = useState(false)
    const [explainLoading, setExplainLoading] = useState(false)
    const [retryPreview, setRetryPreview] = useState<RetryPreviewResult | null>(null)
    const [retryRunning, setRetryRunning] = useState(false)
    const [advancedOpen, setAdvancedOpen] = useState(false)

    function copyToClipboardSafe(text: string, successMessage: string) {
        try {
            if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
                navigator.clipboard.writeText(text)
                    .then(() => showToast(successMessage))
                    .catch(() => showToast('Не удалось скопировать'))
                return
            }
        } catch { /* fallthrough */ }
        showToast('Не удалось скопировать')
    }

    async function openExplain(logId: string) {
        setExplainOpen(true)
        setExplainBundle(null)
        setRetryPreview(null)
        setAdvancedOpen(false)
        setExplainLoading(true)
        try {
            const b = await getDecisionExplainabilityForUi(logId)
            setExplainBundle(b)
        } catch {
            /* empty bundle */
        } finally {
            setExplainLoading(false)
        }
    }
    async function runRetryPreview() {
        if (!explainBundle?.decision) return
        setRetryRunning(true)
        setRetryPreview(null)
        try {
            const r = await previewDecisionRetry(explainBundle.decision.id)
            setRetryPreview(r as RetryPreviewResult)
        } catch (e) {
            const msg = e instanceof Error ? e.message : 'неизвестная ошибка'
            setRetryPreview({
                items: [], policyType: 'no_knowledge', escalationReason: null,
                generatedReply: null,
                trace: {
                    candidateCount: 0, prefilterDurationMs: 0, rerankDurationMs: null,
                    generatorDurationMs: null, totalDurationMs: 0,
                    runtimeVersion: null, rerankUsedModel: null,
                },
                errorMessage: msg,
            })
        } finally {
            setRetryRunning(false)
        }
    }
    function jumpToKnowledgeItem(_itemId: string, sectionId: string) {
        setExplainOpen(false)
        setSelectedSectionId(sectionId)
        setKnowledgeSubtab('core')
        setTab('knowledge')
        listItemsBySection(sectionId, { includeArchived: false })
            .then(arr => setKnowledgeItems(arr as KnowledgeItem[]))
            .catch(() => { /* silent */ })
    }

    // PR3.8: shadow/runtime traces для UI вкладки "Источники".
    interface RetrievalTrace {
        id: string
        messageId: string | null
        chatId: string | null
        channel: string | null
        retrievalMode: string | null
        retrievalDecision: string | null
        escalationReason: string | null
        knowledgeRuntimeVersion: string | null
        shadowRetrievalSummary: {
            decision?: string
            escalationReason?: string | null
            topItemIds?: string[]
            candidateCount?: number
            durationMs?: number
        } | null
        decision: string | null
        generatedReply: string | null
        createdAt: string
    }
    const [retrievalTraces, setRetrievalTraces] = useState<RetrievalTrace[]>([])
    const [runtimeState, setRuntimeState] =
        useState<{ mode: 'legacy' | 'shadow' | 'runtime', shadowOn: boolean, runtimeOn: boolean }>({
            mode: 'legacy', shadowOn: false, runtimeOn: false,
        })
    // PR5: operational readiness — counts + checks. Обновляется
    // после verify/archive/edit и при открытии rollout-модала.
    const [readiness, setReadiness] = useState<KnowledgeReadinessBundle>(initialReadiness)
    // PR5: модал runtime-rollout (объяснение что runtime контролируется
    // env-флагом + checklist).
    const [rolloutOpen, setRolloutOpen] = useState(false)
    // PR5: фильтр items в "Ядро" под-табе. Раньше показывались все
    // активные — теперь админ может быстро отфильтровать конфликты
    // или черновики, не покидая текущую секцию.
    const [coreFilter, setCoreFilter] = useState<'all' | 'conflicts' | 'drafts' | 'unverified'>('all')
    // PR5: bulk governance — running flag (для блокировки кнопки)
    const [bulkRunning, setBulkRunning] = useState(false)

    async function handleBulkVerify(itemIds: string[]) {
        if (bulkRunning || itemIds.length === 0) return
        if (!confirm(`Подтвердить ${itemIds.length} ${plural(itemIds.length, 'знание', 'знания', 'знаний')}? Каждое попадает в audit отдельной записью.`)) return
        setBulkRunning(true)
        try {
            const r = await bulkVerifyItems(itemIds) as BulkActionResult
            showToast(`Подтверждено: ${r.processed}${r.skipped ? `, пропущено ${r.skipped}` : ''}${r.failed ? `, ошибок ${r.failed}` : ''}`)
            await refreshCurrentSection()
        } catch (e: any) {
            showToast('Ошибка: ' + (e?.message ?? 'unknown'))
        } finally {
            setBulkRunning(false)
        }
    }
    async function handleBulkArchiveDrafts(sectionId: string | null) {
        if (bulkRunning || !sectionId) return
        if (!confirm('Архивировать все черновики в этом разделе? Действие обратимо через «Архив → Восстановить».')) return
        setBulkRunning(true)
        try {
            const r = await bulkArchiveDraftsInSection(sectionId) as BulkActionResult
            showToast(`Архивировано черновиков: ${r.processed}${r.failed ? `, ошибок ${r.failed}` : ''}`)
            await refreshCurrentSection()
        } catch (e: any) {
            showToast('Ошибка: ' + (e?.message ?? 'unknown'))
        } finally {
            setBulkRunning(false)
        }
    }

    // PR7.9: disable source by connection. Soft-disable + auto-archive
    // unverified/non-manual items с 0 active sources. Verified/manual
    // оставляем active + warning tag (handled server-side).
    async function handleDisableSource(conn: ChannelConnection, stat?: SourceStatsRow) {
        if (disableInFlight) return
        const itemsCount = stat?.itemsTouched ?? 0
        const verifiedCount = stat?.itemsVerified ?? 0
        const manualCount = stat?.itemsManual ?? 0
        const protectedCount = verifiedCount + manualCount
        const willArchive = Math.max(0, itemsCount - protectedCount)
        const msg = [
            `Отключить знания из аккаунта «${conn.label}»?`,
            '',
            `Затронуто знаний: ${itemsCount}.`,
            willArchive > 0
                ? `~${willArchive} автоматически собранных уйдут в архив (можно восстановить).`
                : 'Авто-собранных среди них нет.',
            protectedCount > 0
                ? `${protectedCount} подтверждённых или ручных останутся активными с пометкой «Источники отключены».`
                : '',
            '',
            'Действие обратимо через карточку знания → Архив → Восстановить.',
        ].filter(Boolean).join('\n')
        if (!confirm(msg)) return

        setDisableInFlight(conn.id)
        try {
            const r = await disableKnowledgeSource({
                channel:      conn.channel,
                connectionId: conn.id,
            }) as DisableSourceResult
            showToast(
                `Отключено. Архивировано: ${r.itemsAutoArchived}` +
                (r.itemsKeptWithWarning > 0 ? `, оставлено с предупреждением: ${r.itemsKeptWithWarning}` : ''),
            )
            // Refresh stats + current section.
            const fresh = await getSourceStatsByConnection() as SourceStatsRow[]
            setSourceStats(fresh)
            await refreshCurrentSection()
        } catch (e: any) {
            showToast('Ошибка: ' + (e?.message ?? 'unknown'))
        } finally {
            setDisableInFlight(null)
        }
    }

    // PR7.9: full core reset. NO default mode, requires typed confirm
    // для full. После успеха показывает result inline; пользователь
    // сам нажимает «Закрыть».
    async function handleResetCore() {
        if (resetRunning || !resetMode) return
        if (resetMode === 'full' && resetTypedConfirm !== 'ОЧИСТИТЬ') {
            showToast('Для полного reset введите подтверждение «ОЧИСТИТЬ»')
            return
        }
        setResetRunning(true)
        try {
            const r = await resetKnowledgeCore(
                resetMode,
                resetMode === 'full' ? resetTypedConfirm : undefined,
            ) as ResetResult
            setResetResult(r)
            // Refresh dependent state.
            const stats = await getSourceStatsByConnection() as SourceStatsRow[]
            setSourceStats(stats)
            await refreshCurrentSection()
            showToast(`В архив: ${r.archivedCount}, сохранено: ${r.keptCount}`)
        } catch (e: any) {
            showToast('Ошибка: ' + (e?.message ?? 'unknown'))
        } finally {
            setResetRunning(false)
        }
    }

    function openResetModal() {
        setResetModalOpen(true)
        setResetMode(null)
        setResetTypedConfirm('')
        setResetResult(null)
    }
    function closeResetModal() {
        if (resetRunning) return
        setResetModalOpen(false)
        setResetMode(null)
        setResetTypedConfirm('')
        setResetResult(null)
    }

    async function refreshReadiness() {
        try {
            const r = await getKnowledgeReadinessForUi()
            setReadiness(r as KnowledgeReadinessBundle)
        } catch { /* silent */ }
    }

    // PR7.16.1: per-channel totals из реальной БД (Chat + Message).
    // Используется на Sync top-card вместо importJobs aggregation,
    // потому что MAX/TG могут приходить live без HistoryImportJob.
    const [channelTotals, setChannelTotals] = useState<ChannelTotalsRow[]>([])
    // PR8.D: per-connection message counts из реальной БД. Используется
    // в passport empty-state «Сейчас доступно для анализа» и в
    // Sync «доступно для анализа», чтобы показывать реальные числа.
    const [connectionCounts, setConnectionCounts] = useState<ConnectionMessageCount[]>([])
    // PR9.11: timestamp последнего refresh + loading flag для фидбэка пользователю
    // когда кликает на карточку или «Обновить всё».
    const [dbStatsRefreshedAt, setDbStatsRefreshedAt] = useState<Date | null>(null)
    const [dbStatsRefreshing,  setDbStatsRefreshing]  = useState(false)
    async function refreshDbStats() {
        setDbStatsRefreshing(true)
        try {
            const [fresh, totals] = await Promise.all([
                getMessageCountsByConnection(),
                getChannelTotalsForUi(),
            ])
            setConnectionCounts(fresh as ConnectionMessageCount[])
            setChannelTotals(totals as ChannelTotalsRow[])
            setDbStatsRefreshedAt(new Date())
        } finally {
            setDbStatsRefreshing(false)
        }
    }

    // PR9.3: реальный диапазон данных в БД для extraction modal.
    // Перезагружается при открытии модала и при изменении selection.
    const [extractionRange, setExtractionRange] = useState<ExtractionDataRange | null>(null)
    const [extractionRangeLoading, setExtractionRangeLoading] = useState(false)

    // На mount fetch runtime state + recent traces.
    useEffect(() => {
        let cancelled = false
        Promise.all([
            getKnowledgeRuntimeStateForUi(),
            listRecentRetrievalTraces(30),
            // PR7.6: подключения для рендера job-card connection
            // labels + live status. Loaded one-time на mount; модал
            // «Собрать ядро» (PR7.4) переиспользует этот же state.
            listChannelConnections(),
            // PR7.9: per-connection статистика для «Источники» panel.
            getSourceStatsByConnection(),
            // PR7.16.1: per-channel totals из БД — для Sync top-card.
            getChannelTotalsForUi(),
            // PR8.D: per-connection counts для passport empty-state.
            getMessageCountsByConnection(),
        ]).then(([state, traces, conns, stats, totals, connCounts]) => {
            if (cancelled) return
            setRuntimeState(state)
            setRetrievalTraces(traces as RetrievalTrace[])
            setChannelConnections(conns as ChannelConnection[])
            setSourceStats(stats as SourceStatsRow[])
            setChannelTotals(totals as ChannelTotalsRow[])
            setConnectionCounts(connCounts as ConnectionMessageCount[])
            // PR9.11: метка времени для пользовательского контекста
            setDbStatsRefreshedAt(new Date())
            // Если ещё не было user-выбора в селекторе — preselect
            // все ready. При повторном открытии модала PR7.4 проверяет
            // selectedConnectionIds.size > 0 и оставляет user choice.
            setSelectedConnectionIds(prev => prev.size > 0 ? prev
                : new Set((conns as ChannelConnection[]).filter(c => c.isReady).map(c => c.id)))
        }).catch(() => { /* silent */ })
        return () => { cancelled = true }
    }, [])

    async function refreshCurrentSection() {
        if (!selectedSectionId) return
        const arr = await listItemsBySection(selectedSectionId, {
            includeArchived: knowledgeSubtab === 'archive',
        })
        const items = arr as KnowledgeItem[]
        setKnowledgeItems(items)
        const stats = await getKnowledgeStatsAction()
        setKnowledgeStats(stats as KnowledgeStats)
        const secs = await listKnowledgeSections()
        setSections(secs as KnowledgeSection[])
        // PR7.12: refresh compact source badges — disable/archive могут
        // изменить allDisabled статус.
        try {
            const badges = await getItemSourceBadges(items.map(i => i.id))
            setItemBadges(badges as Record<string, ItemSourceBadges>)
        } catch { /* silent */ }
        // PR5: governance операции (verify/archive/etc) меняют readiness,
        // обновляем безшумно — UI не блокируется на этом запросе.
        refreshReadiness()
    }

    function openEditFor(item: KnowledgeItem) {
        setEditingItem(item)
        setEditForm({
            title: item.title,
            canonicalStatement: item.canonicalStatement,
            tagsCsv: item.tags.filter(t => !t.startsWith('type:')).join(', '),
            safetyLevel: item.safetyLevel,
        })
        setEditTab('fields')
        setAuditEntries([])
    }

    async function loadAuditHistory(itemId: string) {
        try {
            const arr = await getKnowledgeAuditLog(itemId, 50)
            setAuditEntries(arr as unknown as AuditEntry[])
        } catch {
            setAuditEntries([])
        }
    }

    async function handleSaveEdit() {
        if (!editingItem) return
        setEditSaving(true)
        try {
            const tags = editForm.tagsCsv
                .split(',').map(s => s.trim()).filter(Boolean)
                .concat(editingItem.tags.filter(t => t.startsWith('type:')))
            await editKnowledgeItem(editingItem.id, {
                title:              editForm.title,
                canonicalStatement: editForm.canonicalStatement,
                tags,
                safetyLevel:        editForm.safetyLevel,
            })
            setEditingItem(null)
            await refreshCurrentSection()
            showToast('Сохранено')
        } catch (e) {
            showToast('Ошибка: ' + (e instanceof Error ? e.message : 'неизвестная'))
        } finally {
            setEditSaving(false)
        }
    }

    async function handleArchive(item: KnowledgeItem) {
        try {
            await archiveKnowledgeItem(item.id)
            await refreshCurrentSection()
            showToast('В архив')
        } catch (e) {
            showToast('Ошибка: ' + (e instanceof Error ? e.message : 'неизвестная'))
        }
    }
    async function handleRestore(item: KnowledgeItem) {
        try {
            await restoreKnowledgeItem(item.id)
            await refreshCurrentSection()
            showToast('Восстановлено')
        } catch (e) {
            showToast('Ошибка: ' + (e instanceof Error ? e.message : 'неизвестная'))
        }
    }
    async function handleVerify(item: KnowledgeItem, verified: boolean) {
        try {
            await verifyKnowledgeItem(item.id, verified)
            await refreshCurrentSection()
            showToast(verified ? 'Подтверждено' : 'Подтверждение снято')
        } catch (e) {
            showToast('Ошибка: ' + (e instanceof Error ? e.message : 'неизвестная'))
        }
    }
    async function handleSupersede(oldItem: KnowledgeItem, newItemId: string) {
        try {
            await supersedeKnowledgeItem(oldItem.id, newItemId)
            setSupersedeFor(null)
            await refreshCurrentSection()
            showToast('Знание заменено новым')
        } catch (e) {
            showToast('Ошибка: ' + (e instanceof Error ? e.message : 'неизвестная'))
        }
    }
    async function handleResolveConflict(itemId: string, action: 'keep_this_archive_others' | 'unmark_all') {
        try {
            await resolveConflict(itemId, action)
            setConflictFor(null)
            await refreshCurrentSection()
            showToast(action === 'unmark_all' ? 'Конфликт снят' : 'Конфликт разрешён')
        } catch (e) {
            showToast('Ошибка: ' + (e instanceof Error ? e.message : 'неизвестная'))
        }
    }
    async function openConflictResolver(item: KnowledgeItem) {
        setConflictFor(item)
        if (!item.conflictGroupId) { setConflictMembers([]); return }
        const arr = await listItemsBySection(item.sectionId, { includeArchived: true })
        const members = (arr as KnowledgeItem[]).filter(i => i.conflictGroupId === item.conflictGroupId)
        setConflictMembers(members)
    }
    async function handleCreateManual() {
        if (!selectedSectionId) return
        setManualSaving(true)
        try {
            const tags = manualForm.tagsCsv.split(',').map(s => s.trim()).filter(Boolean)
            await createManualKnowledgeItem({
                sectionId:          selectedSectionId,
                title:              manualForm.title,
                canonicalStatement: manualForm.canonicalStatement,
                tags,
                safetyLevel:        manualForm.safetyLevel,
            })
            setManualCreateOpen(false)
            setManualForm({ title: '', canonicalStatement: '', tagsCsv: '', safetyLevel: 'normal' })
            await refreshCurrentSection()
            showToast('Знание добавлено')
        } catch (e) {
            showToast('Ошибка: ' + (e instanceof Error ? e.message : 'неизвестная'))
        } finally {
            setManualSaving(false)
        }
    }

    // PR7.4: загружаем connections при открытии модала + дефолтный
    // выбор — все ready подключения. Если открыли уже не первый раз,
    // повторно не загружаем чтобы не сбросить пользовательский выбор.
    async function openExtractionModal() {
        setExtractionModalOpen(true)
        if (channelConnections.length === 0) {
            setChannelConnectionsLoading(true)
            try {
                const conns = await listChannelConnections() as ChannelConnection[]
                setChannelConnections(conns)
                // Default: все ready подключения ☑
                setSelectedConnectionIds(new Set(conns.filter(c => c.isReady).map(c => c.id)))
            } catch (e) {
                showToast('Не удалось загрузить список подключений')
            } finally {
                setChannelConnectionsLoading(false)
            }
        }
    }

    function toggleConnectionSelection(id: string) {
        setSelectedConnectionIds(prev => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
        })
    }

    // PR9.3: подгружаем диапазон данных в БД для текущего выбора.
    // Перезапускается на открытие модала и на смену selectedConnectionIds /
    // onlyConnectedNow. Это чтобы пользователь видел «в БД с DATE по DATE
    // лежит N сообщений» прежде чем выбрать scope.
    useEffect(() => {
        if (!extractionModalOpen) return
        let cancelled = false
        setExtractionRangeLoading(true)
        // Вычисляем effective set с учётом onlyConnectedNow.
        const readyIds = new Set(channelConnections.filter(c => c.isReady).map(c => c.id))
        const effective = onlyConnectedNow
            ? [...selectedConnectionIds].filter(id => readyIds.has(id))
            : [...selectedConnectionIds]
        const filter = effective.length > 0 && effective.length < channelConnections.length
            ? effective
            : null
        getExtractionDataRange(filter)
            .then(r => { if (!cancelled) setExtractionRange(r as ExtractionDataRange) })
            .catch(() => { if (!cancelled) setExtractionRange(null) })
            .finally(() => { if (!cancelled) setExtractionRangeLoading(false) })
        return () => { cancelled = true }
    }, [extractionModalOpen, selectedConnectionIds, onlyConnectedNow, channelConnections])

    async function handleStartExtraction() {
        setExtractionStarting(true)
        try {
            if (extractionTier !== initialExtractionTier) {
                await saveExtractionQualityTier(extractionTier)
            }
            // PR7.4: вычисляем effective set с учётом onlyConnectedNow.
            const readyIds = new Set(channelConnections.filter(c => c.isReady).map(c => c.id))
            const effective = onlyConnectedNow
                ? [...selectedConnectionIds].filter(id => readyIds.has(id))
                : [...selectedConnectionIds]
            // PR7.15: вычисляем effective channels — те, у которых
            // выбран хоть один аккаунт. Раньше scope.channels оставался
            // undefined → pairBuilder фоллбэчил на все 3 канала, и MAX
            // попадал в сбор даже если ни одного MAX-чекбокса не стояло.
            // Теперь если у канала 0 selected → канал не идёт в scope.
            // Исключение: если effective=0 в принципе — оставляем
            // null (legacy fast-path по всем каналам).
            const effectiveSet = new Set(effective)
            const channelsWithSelection = new Set<string>()
            for (const c of channelConnections) {
                if (effectiveSet.has(c.id)) channelsWithSelection.add(c.channel)
            }
            const scope: ExtractionScope = {
                mode: extractionScopeMode,
                // Передаём connectionIds только если выбор не совпадает
                // с полным набором ready (чтобы не загромождать scope
                // лишними данными если ничего не отфильтровано).
                connectionIds: effective.length > 0 && effective.length < channelConnections.length
                    ? effective
                    : null,
                onlyConnectedNow,
                // PR7.15: явно ограничиваем каналы выбранными. Только
                // если пользователь хоть что-то выбрал — иначе legacy
                // behaviour (все 3 канала, для сбора из уже загруженной
                // истории без активных connections).
                channels: effective.length > 0
                    ? Array.from(channelsWithSelection)
                    : undefined,
            }
            const job = await startKnowledgeExtraction(scope, extractionTier)
            setExtractionModalOpen(false)
            setActiveExtractionJob({
                id: job.id,
                status: job.status,
                progress: null,
            } as ExtractionJobLite)
            showToast('Сбор ядра запущен')
        } catch (e) {
            const msg = e instanceof Error ? e.message : 'неизвестная ошибка'
            showToast('Ошибка: ' + msg)
        } finally {
            setExtractionStarting(false)
        }
    }

    const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 3000) }

    const lastJob = importJobs[0] ?? null
    const importStatus = lastJob?.status ?? 'none'

    // ─── Runtime Status block ─────────────────────────────────────

    // Шапка-статус: плоская строка, без box-обёртки. Цель — спокойное
    // ощущение «AI работает», а не monitoring-панель. Цифры за сутки
    // подаются как человеческая фраза, без слэшей.
    const RuntimeStatus = () => {
        const channels = config.activeChannels.map(c => CHANNEL_LABELS[c] ?? c).join(', ')
        const replied  = stats.autoReplied
        const escal    = stats.escalated
        const errs     = stats.errors
        // Собираем 24h-фразу только если что-то было — в первые сутки
        // молча, без «0 ответов / 0 ошибок».
        const sentence: string[] = []
        if (replied > 0) sentence.push(`${replied} ${plural(replied, 'ответ', 'ответа', 'ответов')}`)
        if (escal   > 0) sentence.push(`${escal} ${plural(escal, 'передан', 'переданы', 'передано')} менеджеру`)
        if (errs    > 0) sentence.push(`${errs} ${plural(errs, 'ошибка', 'ошибки', 'ошибок')}`)
        const stats24h = sentence.join(', ')

        return (
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-6 text-[13px]">
                <span className="inline-flex items-baseline gap-2">
                    <span className={`w-2 h-2 rounded-full ${config.enabled ? 'bg-green-500' : 'bg-gray-300'}`} style={{ transform: 'translateY(-1px)' }} />
                    <span className="font-medium text-[#111]">
                        {config.enabled ? (RUNNING_LABEL[config.mode] ?? 'AI работает') : 'AI не работает'}
                    </span>
                </span>
                {config.enabled && channels && (
                    <span className="text-gray-500">· в {channels}</span>
                )}
                {stats24h && (
                    <span className="text-gray-400">· за сутки: {stats24h}</span>
                )}
                {canEdit && (
                    <button
                        onClick={() => {
                            const newEnabled = !config.enabled
                            if (config.enabled && !confirm('Выключить AI? Авто-ответы во всех каналах остановятся.')) return
                            setConfig(c => ({ ...c, enabled: newEnabled }))
                            startTransition(async () => {
                                await saveAiConfig({ enabled: newEnabled })
                                showToast(newEnabled ? 'AI включён' : 'AI выключен')
                            })
                        }}
                        className={`ml-auto h-[26px] px-3 rounded-md text-[12px] font-medium transition-colors ${
                            config.enabled
                                ? 'text-red-600 hover:bg-red-50'
                                : 'text-green-600 hover:bg-green-50'
                        }`}
                    >
                        {config.enabled ? 'Выключить' : 'Включить'}
                    </button>
                )}
            </div>
        )
    }

    // ─── Вкладка: Синхронизация ───────────────────────────────────

    const [importChannels, setImportChannels] = useState<string[]>(['max'])
    const [importMode, setImportMode]         = useState<string>('from_connection_time')
    const [importDays, setImportDays]         = useState(7)
    const [importLoading, setImportLoading]   = useState(false)
    const [liveProgress, setLiveProgress]     = useState<{ active: boolean, messagesImported: number, chatsScanned: number, contactsFound: number, elapsed: number } | null>(null)
    const pollRef = useRef<NodeJS.Timeout | null>(null)

    // Preflight: idle → checking → unavailable | needs_auth | ready
    type PreflightState = 'idle' | 'checking' | 'unavailable' | 'needs_auth'
    const [preflightState, setPreflightState] = useState<PreflightState>('idle')
    const [preflightError, setPreflightError] = useState<string | null>(null)

    // Transport health: отслеживаем доступность скрапера во время активного задания
    type TransportStatus = 'unknown' | 'online' | 'offline' | 'initializing'
    const [transportStatus, setTransportStatus] = useState<TransportStatus>('unknown')
    const transportFailCount = useRef(0)

    // При загрузке: если есть активное задание, сразу проверяем транспорт
    useEffect(() => {
        const hasActive = importJobs.some(j => j.status === 'queued' || j.status === 'running')
        if (hasActive && transportStatus === 'unknown') {
            checkScraperHealth(['max']).then(health => {
                if (health.max?.ok) {
                    setTransportStatus('online')
                    transportFailCount.current = 0
                } else if (health.max?.status === 'initializing') {
                    setTransportStatus('initializing')
                } else {
                    setTransportStatus('offline')
                }
            })
        }
    }, []) // eslint-disable-line react-hooks/exhaustive-deps

    // Polling: обновляем статус заданий + live-счётчики + проверяем здоровье транспорта
    useEffect(() => {
        const hasActive = importJobs.some(j => j.status === 'queued' || j.status === 'running')
        if (hasActive && !pollRef.current) {
            pollRef.current = setInterval(async () => {
                try {
                    // Опрашиваем БД, скрапер (счётчики) и здоровье транспорта параллельно
                    const [fresh, progressRes, health] = await Promise.all([
                        getAllImportJobs(10),
                        fetch(`${process.env.NEXT_PUBLIC_MAX_SCRAPER_URL || 'http://localhost:3005'}/import-progress`).then(r => r.json()).catch(() => null),
                        checkScraperHealth(['max']),
                    ])
                    setImportJobs(fresh)

                    // Обновляем статус транспорта
                    if (health.max?.ok) {
                        setTransportStatus('online')
                        transportFailCount.current = 0
                    } else if (health.max?.status === 'initializing') {
                        setTransportStatus('initializing')
                        transportFailCount.current = 0
                    } else {
                        transportFailCount.current++
                        // Считаем offline после 2 последовательных неудач (4 сек)
                        if (transportFailCount.current >= 2) {
                            setTransportStatus('offline')
                        }
                    }

                    if (progressRes?.active) {
                        setLiveProgress(progressRes)
                    } else if (transportStatus === 'offline') {
                        setLiveProgress(null)
                    }

                    // Если больше нет активных — стоп
                    if (!fresh.some((j: ImportJob) => j.status === 'queued' || j.status === 'running')) {
                        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
                        setLiveProgress(null)
                        setTransportStatus('unknown')
                        transportFailCount.current = 0
                    }
                } catch {}
            }, 2000)
        }
        if (!hasActive && pollRef.current) {
            clearInterval(pollRef.current)
            pollRef.current = null
            setTransportStatus('unknown')
            transportFailCount.current = 0
        }
        return () => {
            if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
        }
    }, [importJobs])

    const activeJob = importJobs.find(j => j.status === 'queued' || j.status === 'running')
    // Таймер только от скрапера (server-side), чтобы не было проблем с часовыми поясами
    const elapsedSec = liveProgress?.active ? liveProgress.elapsed : null

    // PR9.4: handleStartImport теперь принимает forceProceed — позволяет
    // пользователю запустить импорт даже если health-check провалился
    // (например MAX scraper занят puppeteer'ом и не ответил за 3 сек,
    // но фактически работает). Раньше health был жёстким gate'ом.
    const handleStartImport = async (forceProceed: boolean = false) => {
        setPreflightState('checking')
        setPreflightError(null)

        try {
            if (!forceProceed) {
                // 1. Preflight: проверяем доступность транспортов
                const health = await checkScraperHealth(importChannels)

                // Ищем первый недоступный канал
                for (const ch of importChannels) {
                    const h = health[ch]
                    if (!h) continue
                    if (!h.ok) {
                        if (h.status === 'initializing') {
                            setPreflightState('needs_auth')
                            setPreflightError(`${CHANNEL_LABELS[ch] ?? ch}: скрапер запущен, но ещё инициализируется`)
                        } else {
                            setPreflightState('unavailable')
                            setPreflightError(`${CHANNEL_LABELS[ch] ?? ch}: ${h.error ?? 'скрапер не отвечает'}. Если уверены что подключение работает — нажмите «Всё равно запустить».`)
                        }
                        return
                    }
                }
            }

            // 2. Всё ок (либо forceProceed) — запускаем джобу
            setPreflightState('idle')
            setTransportStatus('online')
            transportFailCount.current = 0
            setImportLoading(true)
            const job = await createImportJob({
                channels: importChannels,
                mode: importMode as any,
                daysBack: importMode === 'last_n_days' ? importDays : undefined,
            })
            setImportJobs(j => [job, ...j])
            showToast('Импорт запущен')
        } catch (e: any) {
            setPreflightState('unavailable')
            setPreflightError(e.message)
        } finally {
            setImportLoading(false)
        }
    }

    const handleRetryPreflight = () => {
        setPreflightState('idle')
        setPreflightError(null)
    }

    const SyncTab = () => (
        <div className="space-y-5">
            <InlineInfo>
                Сколько сообщений из каждого аккаунта уже в базе.
                Чтобы догрузить старую историю — открой карточку аккаунта ниже
                и перейди на страницу мессенджера.
                Чтобы AI прочитал базу и собрал знания — перейди на вкладку «Ядро знаний».
            </InlineInfo>

            {/* PR9.9: per-account dashboard cards.
                Для каждого подключения показываем:
                  — channel + label (имя или телефон)
                  — статус-точка (зелёная live / красная отключён)
                  — сообщений в БД (real count)
                  — период (earliest sentAt — latest sentAt)
                  — клик на карточку = refresh per-connection stats. */}
            <div className="space-y-3 pt-1">
                {/* PR9.13: глобальный дашборд — 3 prominent карточки. */}
                {(() => {
                    const totalMessages = channelTotals.reduce((s, t) => s + t.messages, 0)
                    const totalChats    = channelTotals.reduce((s, t) => s + t.chats, 0)
                    const totalContacts = channelTotals.reduce((s, t) => s + t.contacts, 0)
                    return (
                        <div>
                            <div className="flex items-center justify-between mb-2">
                                <h3 className="text-[15px] font-semibold text-[#111]">База сообщений</h3>
                                <div className="flex items-center gap-2">
                                    {dbStatsRefreshedAt && (
                                        <span className="text-[11px] text-gray-500">
                                            обновлено {dbStatsRefreshedAt.toLocaleTimeString('ru')}
                                        </span>
                                    )}
                                    <button
                                        type="button"
                                        onClick={refreshDbStats}
                                        disabled={dbStatsRefreshing}
                                        title="Перезагрузить счётчики из БД"
                                        className="h-[28px] px-3 inline-flex items-center gap-1.5 text-[11px] font-semibold text-[#3390EC] border border-[#3390EC]/40 rounded-md hover:bg-[#F0F4FA] disabled:opacity-50 transition-colors"
                                    >
                                        {dbStatsRefreshing
                                            ? <Loader2 size={11} className="animate-spin" />
                                            : <RefreshCw size={11} />}
                                        {dbStatsRefreshing ? 'Обновляем…' : 'Обновить'}
                                    </button>
                                </div>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                <div className="rounded-xl border-2 border-[#3390EC]/30 bg-gradient-to-br from-[#F0F4FA] to-[#E1ECFA] px-4 py-4">
                                    <div className="text-[10px] uppercase tracking-wide text-[#3390EC] font-bold mb-1">Сообщений</div>
                                    <div className="text-[28px] font-bold text-[#111] leading-none">
                                        {totalMessages.toLocaleString('ru')}
                                    </div>
                                    <div className="text-[11px] text-gray-500 mt-1">
                                        входящие и исходящие, все каналы
                                    </div>
                                </div>
                                <div className="rounded-xl border-2 border-[#E0E8F4] bg-white px-4 py-4">
                                    <div className="text-[10px] uppercase tracking-wide text-gray-500 font-bold mb-1">Чатов</div>
                                    <div className="text-[28px] font-bold text-[#111] leading-none">
                                        {totalChats.toLocaleString('ru')}
                                    </div>
                                    <div className="text-[11px] text-gray-500 mt-1">
                                        диалогов с водителями
                                    </div>
                                </div>
                                <div className="rounded-xl border-2 border-[#E0E8F4] bg-white px-4 py-4">
                                    <div className="text-[10px] uppercase tracking-wide text-gray-500 font-bold mb-1">Контактов</div>
                                    <div className="text-[28px] font-bold text-[#111] leading-none">
                                        {totalContacts.toLocaleString('ru')}
                                    </div>
                                    <div className="text-[11px] text-gray-500 mt-1">
                                        уникальных собеседников
                                    </div>
                                </div>
                            </div>
                        </div>
                    )
                })()}
                <h4 className="text-[14px] font-semibold text-[#111] pt-1">По аккаунтам</h4>
                {channelConnections.length === 0 ? (
                    <div className="text-[12px] text-gray-500 px-3 py-3 rounded-lg border border-[#E8E8E8] bg-[#FAFBFC]">
                        Ни одного подключения нет. Добавьте WhatsApp / Telegram / MAX в разделе «Интеграции».
                    </div>
                ) : (
                    // PR9.12: группировка по каналу в фиксированном порядке WA → TG → MAX
                    <div className="space-y-4">
                        {(['whatsapp', 'telegram', 'max'] as const).map(channel => {
                            const channelConns = channelConnections.filter(c => c.channel === channel)
                            if (channelConns.length === 0) return null
                            const CHANNEL_TITLE: Record<string, string> = {
                                whatsapp: 'WhatsApp',
                                telegram: 'Telegram',
                                max:      'MAX',
                            }
                            return (
                            <div key={channel}>
                                <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
                                    {CHANNEL_TITLE[channel]} · {channelConns.length} {channelConns.length === 1 ? 'аккаунт' : channelConns.length < 5 ? 'аккаунта' : 'аккаунтов'}
                                </div>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                                    {channelConns.map(conn => {
                            const stat = connectionCounts.find(c => c.connectionId === conn.id)
                            const messages = stat?.messages ?? 0
                            const chats    = stat?.chats ?? 0
                            const earliest = stat?.earliestSentAt
                            const latest   = stat?.latestSentAt
                            const statusText =
                                conn.isReady ? 'подключён' :
                                conn.status === 'qr' ? 'ждёт QR' :
                                conn.status === 'authenticating' ? 'входит' :
                                conn.status === 'idle' ? 'не активен' :
                                conn.status === 'inactive' ? 'отключён' :
                                conn.status === 'disconnected' ? 'отключён' : '—'
                            const channelHref =
                                conn.channel === 'whatsapp' ? '/settings/integrations/whatsapp' :
                                conn.channel === 'telegram' ? '/settings/integrations/telegram' :
                                '/settings/integrations/max'
                            // PR9.10: color-coded background
                            // зелёный для подключённых, красный — отключённых,
                            // амбер — переходное состояние (qr/authenticating).
                            const isConnected = conn.isReady
                            const isPending   = conn.status === 'qr' || conn.status === 'authenticating'
                            const cardBg =
                                isConnected ? 'bg-emerald-50 border-emerald-300 hover:bg-emerald-100' :
                                isPending   ? 'bg-amber-50 border-amber-300 hover:bg-amber-100' :
                                              'bg-red-50 border-red-300 hover:bg-red-100'
                            const statusPillBg =
                                isConnected ? 'bg-emerald-600 text-white' :
                                isPending   ? 'bg-amber-600 text-white' :
                                              'bg-red-600 text-white'
                            return (
                                <button
                                    key={conn.id}
                                    type="button"
                                    onClick={async () => {
                                        await refreshDbStats()
                                        showToast(`Обновлено: ${conn.label}`)
                                    }}
                                    disabled={dbStatsRefreshing}
                                    className={`text-left rounded-xl border-2 transition-colors px-4 py-3.5 disabled:opacity-70 ${cardBg}`}
                                    title="Кликнуть по карточке — обновить счётчики. Подробнее об аккаунте — нажми «Открыть настройки» внизу карточки."
                                >
                                    {/* Header: label + status pill */}
                                    <div className="flex items-start justify-between gap-2 mb-2">
                                        <span className="text-[15px] font-semibold text-[#111] truncate">
                                            {conn.label}
                                        </span>
                                        <span className={`text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full shrink-0 ${statusPillBg}`}>
                                            {statusText}
                                        </span>
                                    </div>
                                    {/* Stats — увеличенные */}
                                    <div className="space-y-0.5">
                                        <div className="text-[13px] text-[#111]">
                                            <b className="text-[18px] font-bold">{messages.toLocaleString('ru')}</b>{' '}
                                            <span className="text-gray-600">сообщ. в БД</span>
                                        </div>
                                        {chats > 0 && (
                                            <div className="text-[12px] text-gray-600">
                                                {chats.toLocaleString('ru')} {chats === 1 ? 'чат' : chats < 5 ? 'чата' : 'чатов'}
                                            </div>
                                        )}
                                        {earliest && latest && (
                                            <div className="text-[11px] text-gray-500 pt-0.5">
                                                {new Date(earliest).toLocaleDateString('ru')} — {new Date(latest).toLocaleDateString('ru')}
                                            </div>
                                        )}
                                        {!earliest && messages === 0 && (
                                            <div className="text-[11px] text-gray-500">истории в БД пока нет</div>
                                        )}
                                    </div>
                                    {/* PR9.14: cross-ref всегда видимая.
                                        Раньше показывалась только на hover —
                                        пользователь не понимал что внутри карточки
                                        есть ссылка. Tooltip к ней ссылается, так
                                        что она должна быть прямо видна. */}
                                    <div className="text-[11px] mt-2">
                                        <a
                                            href={channelHref}
                                            onClick={e => e.stopPropagation()}
                                            className="text-[#3390EC] hover:underline font-semibold"
                                        >
                                            Открыть настройки →
                                        </a>
                                    </div>
                                </button>
                            )
                        })}
                                </div>
                            </div>
                            )
                        })}
                    </div>
                )}
                {/* Primary CTA: collect knowledge core */}
                <button
                    type="button"
                    onClick={() => setTab('knowledge')}
                    className="w-full text-left rounded-lg border border-[#3390EC]/40 bg-[#F0F4FA] hover:bg-[#E1ECFA] transition-colors px-3 py-2.5 mt-2"
                >
                    <div className="text-[12px] font-semibold text-[#3390EC]">Собрать ядро знаний →</div>
                    <div className="text-[11px] text-gray-500 mt-0.5">AI прочитает сообщения из БД и соберёт структурированную память</div>
                </button>
            </div>

            {/* PR9.9: блок «Прошлые загрузки» удалён — user feedback:
                «мусорный». Информация про импорты теперь видна
                per-account на странице конкретного мессенджера
                (/settings/integrations/{whatsapp|telegram|max}). */}
            {false && importJobs.length > 0 && (
                <div className="pt-1">
                    <h4 className="text-[13px] font-semibold text-[#111] mb-1">Прошлые загрузки</h4>
                    <p className="text-[11px] text-gray-500 mb-2 leading-relaxed">
                        ARCHIVED — see git history.
                    </p>
                    <div className="divide-y divide-[#F0F0F0] border-t border-b border-[#F0F0F0]">
                        {importJobs.slice(0, 5).map(job => {
                            const RESULT_LABELS: Record<string, string> = { full: 'Вся доступная история', partial: 'Частичный', 'live only': 'Только live', failed: 'Ошибка' }
                            const STATUS_LABELS: Record<string, string> = { queued: 'В очереди', running: 'Выполняется', completed: 'Завершён', failed: 'Ошибка' }
                            const hasStats = job.status === 'completed' || job.status === 'failed' || job.messagesImported > 0
                            const channelKey = [...job.channels].sort().join(',')
                            const olderSameChannel = importJobs.filter(j => j.id !== job.id && [...j.channels].sort().join(',') === channelKey && new Date(j.createdAt) < new Date(job.createdAt))
                            const isRepeat = olderSameChannel.length > 0
                            const prevSameJob = isRepeat ? olderSameChannel.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0] : null
                            const newMsgs = isRepeat && prevSameJob ? Math.max(0, job.messagesImported - prevSameJob.messagesImported) : null
                            return (
                            <div key={job.id} className="px-4 py-3">
                                {/* Верхняя строка: аккаунт (если известен) или
                                    каналы, режим, статус, дата.
                                    PR7.13: связываем аккаунт раньше каналов
                                    чтобы пользователь сразу видел «откуда импорт». */}
                                <div className="flex items-center gap-3 text-[12px]">
                                    {(job.status === 'queued' || job.status === 'running')
                                        ? <RefreshCw size={12} className="animate-spin text-yellow-500 shrink-0" />
                                        : <StatusDot status={job.status} />
                                    }
                                    {(() => {
                                        // PR7.13: показываем имя аккаунта на верхней строке
                                        // если он известен — это primary identifier.
                                        // Иначе fallback на список каналов.
                                        const connId = (job as any).connectionId as string | null
                                        const conn = connId
                                            ? channelConnections.find(c => c.id === connId)
                                            : null
                                        if (conn) {
                                            return (
                                                <span className="font-medium text-[#111]">{conn.label}</span>
                                            )
                                        }
                                        return (
                                            <span className="font-medium text-gray-700">
                                                {job.channels.map(c => CHANNEL_LABELS[c] ?? c).join(', ')}
                                            </span>
                                        )
                                    })()}
                                    <span className="text-gray-400">
                                        Импорт: {job.mode === 'available_history' ? 'вся доступная история' : job.mode === 'from_connection_time' ? 'с момента подключения' : job.mode === 'last_n_days' ? `${(job as any).daysBack ?? 'N'} дней` : job.mode}
                                    </span>
                                    {isRepeat && <span className="text-[10px] text-gray-400 italic">повторная синхронизация</span>}
                                    <span className={`ml-auto text-[10px] font-bold px-2 py-0.5 rounded-full ${
                                        job.status === 'completed' ? 'bg-green-50 text-green-700' :
                                        job.status === 'running'   ? 'bg-yellow-50 text-yellow-700' :
                                        job.status === 'failed'    ? 'bg-red-50 text-red-700' : 'bg-gray-100 text-gray-600'
                                    }`}>{STATUS_LABELS[job.status] ?? job.status}</span>
                                    <span className="text-gray-400 text-[10px]">{new Date(job.createdAt).toLocaleString('ru')}</span>
                                    {/* Кнопки Stop / Delete */}
                                    {(job.status === 'queued' || job.status === 'running') && (
                                        <button
                                            onClick={async () => {
                                                await cancelImportJob(job.id)
                                                const fresh = await getAllImportJobs(10)
                                                setImportJobs(fresh)
                                            }}
                                            title="Остановить"
                                            className="ml-1 p-1 rounded hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors"
                                        ><Square size={12} /></button>
                                    )}
                                    {(job.status === 'completed' || job.status === 'failed') && (
                                        <button
                                            onClick={async () => {
                                                if (!confirm('Удалить запись об этом импорте? Импортированные сообщения сохранятся — удалится только история запуска.')) return
                                                await deleteImportJob(job.id)
                                                const fresh = await getAllImportJobs(10)
                                                setImportJobs(fresh)
                                            }}
                                            title="Удалить запись о запуске"
                                            className="ml-1 p-1 rounded hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors"
                                        ><X size={12} /></button>
                                    )}
                                </div>
                                {/* PR7.6 + PR7.12: connection label + live
                                    status или явный fallback «источник
                                    аккаунта неизвестен» для legacy/TG/MAX
                                    jobs. Пользователь всегда видит ответ
                                    на «из какого аккаунта». */}
                                {(() => {
                                    const connId = (job as any).connectionId as string | null
                                    const conn = connId
                                        ? channelConnections.find(c => c.id === connId)
                                        : null
                                    const STATUS_LABEL: Record<string, string> = {
                                        ready: 'подключён',     qr: 'ждёт QR',
                                        authenticating: 'входит', idle: 'не активен',
                                        disconnected: 'отключён', inactive: 'отключён',
                                        unknown: '—',
                                    }
                                    if (conn) {
                                        // PR7.16: убрали дубликат conn.label —
                                        // он уже отображается в верхней строке
                                        // job-row (1608). Здесь оставляем только
                                        // live-статус аккаунта.
                                        const dotColor =
                                            conn.isReady ? 'bg-green-500' :
                                            conn.status === 'qr' || conn.status === 'authenticating' ? 'bg-amber-500' :
                                            'bg-gray-300'
                                        return (
                                            <div className="mt-1 ml-5 inline-flex items-center gap-1 text-[11px] text-gray-500">
                                                <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
                                                <span>аккаунт сейчас: {STATUS_LABEL[conn.status] ?? conn.status}</span>
                                            </div>
                                        )
                                    }
                                    if (connId) {
                                        return (
                                            <div className="mt-1 ml-5 text-[11px] text-gray-400"
                                                 title="Этот импорт был привязан к подключению, которого сейчас нет — возможно его удалили.">
                                                Аккаунт-источник недоступен (возможно подключение удалили)
                                            </div>
                                        )
                                    }
                                    // connectionId IS NULL — legacy job до PR7/PR8 backfill
                                    return (
                                        <div className="mt-1 ml-5 text-[11px] text-gray-400"
                                             title="Точный аккаунт-источник для этого импорта не сохранён — импорт был сделан до того, как мы стали запоминать привязку.">
                                            Источник аккаунта неизвестен — импорт сделан до сохранения привязки
                                        </div>
                                    )
                                })()}
                                {/* Статистика результата */}
                                {hasStats && (
                                    <div className="mt-2 ml-5 flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px]">
                                        <span className="text-gray-500"><span className="font-semibold text-gray-700">{job.messagesImported}</span> сообщ.</span>
                                        <span className="text-gray-500"><span className="font-semibold text-gray-700">{job.chatsScanned}</span> чатов</span>
                                        <span className="text-gray-500"><span className="font-semibold text-gray-700">{job.contactsFound}</span> контактов</span>
                                        {isRepeat && newMsgs !== null && (
                                            <span className="text-gray-400">Новых: <span className={`font-semibold ${newMsgs === 0 ? 'text-gray-400' : 'text-green-600'}`}>{newMsgs}</span></span>
                                        )}
                                        {job.resultType && !isRepeat && (
                                            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                                                job.resultType === 'full' ? 'bg-blue-50 text-blue-700' :
                                                job.resultType === 'partial' ? 'bg-yellow-50 text-yellow-700' :
                                                job.resultType === 'failed'  ? 'bg-red-50 text-red-700' : 'bg-gray-100 text-gray-600'
                                            }`}>{RESULT_LABELS[job.resultType] ?? job.resultType}</span>
                                        )}
                                        {job.coveredPeriodFrom && job.coveredPeriodTo && (
                                            <span className="text-gray-400 text-[10px]">
                                                {new Date(job.coveredPeriodFrom).toLocaleDateString('ru')} — {new Date(job.coveredPeriodTo).toLocaleDateString('ru')}
                                            </span>
                                        )}
                                    </div>
                                )}
                            </div>
                        )})}
                    </div>
                </div>
            )}
        </div>
    )

    // ─── Вкладка: AI Провайдер ────────────────────────────────────

    const [apiKey, setApiKey]             = useState('')
    const [testStatus, setTestStatus]     = useState<'idle' | 'testing' | 'ok' | 'error'>('idle')
    const [testError, setTestError]       = useState('')
    const [providerSaving, setProviderSaving] = useState(false)
    // PR9.19: auto-verify saved key при первом mount страницы.
    // Если БД хранит ключ + connectionStatus != 'ok' (мог устареть)
    // — тихо проверяем без необходимости user'у вводить заново.
    // useRef чтобы запуск был один раз за сессию, не на каждое
    // переключение tab'а.
    const autoTestedRef = useRef(false)
    useEffect(() => {
        if (autoTestedRef.current) return
        if (!config.apiKeyEncrypted) return
        if (config.connectionStatus === 'ok') return  // уже OK, ничего не делаем
        autoTestedRef.current = true
        setTestStatus('testing')
        testSavedConnection().then(result => {
            if (result.ok) {
                setTestStatus('ok')
                setConfig(c => ({
                    ...c,
                    connectionStatus: 'ok',
                    lastConnectionCheckAt: new Date().toISOString(),
                }))
            } else {
                setTestStatus('error')
                setTestError(result.error ?? 'Ошибка')
                setConfig(c => ({
                    ...c,
                    connectionStatus: 'error',
                    lastConnectionCheckAt: new Date().toISOString(),
                }))
            }
        }).catch(() => {
            setTestStatus('idle')
        })
    }, [config.apiKeyEncrypted, config.connectionStatus])

    const handleTestConnection = async () => {
        if (!apiKey.trim()) { showToast('Введите API ключ'); return }
        setTestStatus('testing')
        const result = await testAiConnection(config.provider, apiKey, config.classificationModel)
        if (result.ok) {
            // PR5 UX fix: раньше «Проверить» сохраняла только connectionStatus,
            // а сам apiKeyEncrypted оставался пустым в БД до клика «Сохранить».
            // Это создавало ловушку: зелёная галочка «ключ активен», но
            // «Собрать ядро» disabled с "API ключ не настроен". Теперь при
            // успешной проверке сразу персистим ключ — отдельный клик
            // «Сохранить» становится не обязательным.
            try {
                await saveAiConfig({
                    provider:            config.provider,
                    apiKeyEncrypted:     apiKey,
                    classificationModel: config.classificationModel,
                    responseModel:       config.responseModel,
                    connectionStatus:    'ok',
                    lastConnectionCheckAt: new Date(),
                })
                setConfig(c => ({
                    ...c,
                    apiKeyEncrypted:      apiKey,
                    connectionStatus:     'ok',
                    lastConnectionCheckAt: new Date().toISOString(),
                }))
                setTestStatus('ok')
                showToast('Ключ проверен и сохранён')
            } catch (e: any) {
                setTestStatus('ok')
                setConfig(c => ({ ...c, connectionStatus: 'ok', lastConnectionCheckAt: new Date().toISOString() }))
                showToast('Ключ проверен, но не удалось сохранить: ' + (e?.message ?? 'unknown'))
            }
        } else {
            setTestStatus('error')
            setTestError(result.error ?? 'Ошибка')
        }
    }

    const handleSaveProvider = async () => {
        setProviderSaving(true)
        try {
            await saveAiConfig({
                provider:            config.provider,
                ...(apiKey.trim() ? { apiKeyEncrypted: apiKey } : {}),
                classificationModel: config.classificationModel,
                responseModel:       config.responseModel,
            })
            showToast('Сохранено')
        } catch (e: any) {
            showToast('Ошибка: ' + e.message)
        } finally {
            setProviderSaving(false)
        }
    }

    // Дефолты моделей и подсказки per provider. Когда админ переключает
    // toggle Anthropic ↔ OpenAI, поля моделей должны меняться вместе —
    // иначе классические Claude-имена остаются при OpenAI-ключе и проверка
    // падает с «Модель "claude-haiku-4-5" не доступна в этом OpenAI аккаунте».
    const ProviderTab = () => {
    const PROVIDER_DEFAULTS: Record<string, { classification: string; response: string; keyPlaceholder: string }> = {
        anthropic: {
            classification: 'claude-haiku-4-5',
            response: 'claude-sonnet-4-5',
            keyPlaceholder: 'sk-ant-...',
        },
        openai: {
            classification: 'gpt-4o-mini',
            response: 'gpt-4o',
            keyPlaceholder: 'sk-proj-...',
        },
    }

    function switchProvider(newProvider: string) {
        setConfig(c => {
            const def = PROVIDER_DEFAULTS[newProvider]
            if (!def) return { ...c, provider: newProvider }
            const allDefaults = Object.values(PROVIDER_DEFAULTS).flatMap(d => [d.classification, d.response])
            const classIsKnownDefault = allDefaults.includes(c.classificationModel)
            const responseIsKnownDefault = allDefaults.includes(c.responseModel)
            return {
                ...c,
                provider: newProvider,
                classificationModel: classIsKnownDefault ? def.classification : c.classificationModel,
                responseModel: responseIsKnownDefault ? def.response : c.responseModel,
            }
        })
        // PR9.18: очищаем local input при switch — иначе ключ от
        // предыдущего провайдера остаётся в input field, что выглядит
        // как баг. БД-сохранённый ключ (config.apiKeyEncrypted)
        // продолжает работать; input просто пустой.
        setApiKey('')
        setTestStatus('idle')
    }

    const providerDef = PROVIDER_DEFAULTS[config.provider] ?? PROVIDER_DEFAULTS.anthropic

    // PR9.15: derive effective статус ключа из state + DB.
    // Логика осталась из PR5: testStatus → config.connectionStatus → unchecked → empty.
    const effectiveStatus = (() => {
        if (testStatus === 'testing') return 'testing'
        if (testStatus === 'ok')      return 'ok'
        if (testStatus === 'error')   return 'error'
        if (config.connectionStatus === 'ok')    return 'ok'
        if (config.connectionStatus === 'error') return 'error'
        if (apiKey.trim() || config.apiKeyEncrypted) return 'unchecked'
        return 'empty'
    })()
    // Color theme + texts per status
    const STATUS_THEME: Record<string, {
        cardBg: string; pillBg: string; titleColor: string;
        title: string; subtitle: string; buttonLabel: string;
    }> = {
        ok: {
            cardBg: 'bg-emerald-50 border-emerald-300',
            pillBg: 'bg-emerald-600 text-white',
            titleColor: 'text-emerald-900',
            title: 'Ключ активен',
            subtitle: 'AI отвечает через выбранный провайдер.',
            buttonLabel: 'Перепроверить',
        },
        error: {
            cardBg: 'bg-red-50 border-red-300',
            pillBg: 'bg-red-600 text-white',
            titleColor: 'text-red-900',
            title: 'Ключ не работает',
            subtitle: testError || 'Проверьте ключ, баланс и доступ к модели.',
            buttonLabel: 'Проверить снова',
        },
        testing: {
            cardBg: 'bg-amber-50 border-amber-300',
            pillBg: 'bg-amber-600 text-white',
            titleColor: 'text-amber-900',
            title: 'Проверяем…',
            subtitle: 'Отправляем тестовый запрос провайдеру.',
            buttonLabel: 'Проверяем…',
        },
        unchecked: {
            cardBg: 'bg-gray-50 border-gray-300',
            pillBg: 'bg-gray-600 text-white',
            titleColor: 'text-gray-900',
            title: 'Ключ не проверен',
            subtitle: 'Ключ есть, но мы ещё не проверяли, работает ли он.',
            buttonLabel: 'Проверить',
        },
        empty: {
            cardBg: 'bg-amber-50 border-amber-300',
            pillBg: 'bg-amber-600 text-white',
            titleColor: 'text-amber-900',
            title: 'Ключ не задан',
            subtitle: 'Введите API-ключ от Anthropic или OpenAI ниже.',
            buttonLabel: 'Проверить',
        },
    }
    const theme = STATUS_THEME[effectiveStatus]

    // PR9.16: per-provider card. Карточка показывает свой статус ТОЛЬКО
    // когда это активный провайдер (config.provider === p). Иначе —
    // нейтральный «не используется» с кнопкой «Сделать активным».
    const PROVIDER_META: Record<string, { name: string; sub: string; keysUrl: string }> = {
        anthropic: {
            name: 'Anthropic (Claude)',
            sub:  'Лучше понимает русский, выше качество на длинных ответах.',
            keysUrl: 'https://console.anthropic.com/settings/keys',
        },
        openai: {
            name: 'OpenAI (GPT)',
            sub:  'Дешевле и быстрее на коротких ответах, шире выбор моделей.',
            keysUrl: 'https://platform.openai.com/api-keys',
        },
    }

    return (
        <div className="space-y-5">
            <InlineInfo>
                AI работает через одного провайдера за раз: Anthropic (Claude) или OpenAI (GPT).
                Выберите карточку — это станет активным провайдером для всех ответов AI.
            </InlineInfo>

            {/* PR9.16: 2 карточки провайдеров, color-coded по статусу
                активного. Старая большая info-карточка статуса удалена —
                ту же инфу даёт цвет конкретной карточки. */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {/* PR9.18: порядок поменян — OpenAI первая (чаще используется),
                    Anthropic вторая. */}
                {(['openai', 'anthropic'] as const).map(p => {
                    const meta = PROVIDER_META[p]
                    const isActive = config.provider === p
                    const isWorking = effectiveStatus === 'ok'
                    const isTesting = effectiveStatus === 'testing'
                    const cardBg = !isActive
                        ? 'bg-white border-gray-200 hover:border-[#3390EC] hover:bg-[#FAFBFC] cursor-pointer'
                        : isTesting
                            ? 'bg-amber-50 border-amber-400'
                            : isWorking
                                ? 'bg-emerald-50 border-emerald-400'
                                : 'bg-red-50 border-red-400'
                    const pillBg = !isActive
                        ? 'bg-gray-200 text-gray-600'
                        : isTesting
                            ? 'bg-amber-600 text-white'
                            : isWorking
                                ? 'bg-emerald-600 text-white'
                                : 'bg-red-600 text-white'
                    const pillText = !isActive ? 'не используется'
                        : isTesting ? '… проверяем'
                        : isWorking ? '✓ ключ работает'
                        : effectiveStatus === 'error' ? '✗ ключ не работает'
                        : effectiveStatus === 'unchecked' ? '✗ нужна проверка'
                        : '✗ ключ не задан'
                    // PR9.18: вся карточка кликабельна когда неактивна
                    // → switchProvider. Раньше нужно было целить в
                    // мелкую ссылку «Сделать активным».
                    const handleCardClick = !isActive ? () => switchProvider(p) : undefined
                    return (
                        <div
                            key={p}
                            onClick={handleCardClick}
                            title={!isActive ? `Кликни чтобы переключиться на ${meta.name}` : undefined}
                            className={`rounded-xl border-2 px-4 py-3.5 transition-colors ${cardBg}`}
                        >
                            <div className="flex items-start justify-between gap-2 mb-2">
                                <div className="min-w-0">
                                    <div className="text-[15px] font-semibold text-[#111]">{meta.name}</div>
                                    <div className="text-[11px] text-gray-600 leading-snug mt-0.5">{meta.sub}</div>
                                </div>
                                <span className={`text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full shrink-0 ${pillBg}`}>
                                    {pillText}
                                </span>
                            </div>
                            {isActive && config.lastConnectionCheckAt && (
                                <div className="text-[10px] text-gray-500 mt-1">
                                    Последняя проверка: {new Date(config.lastConnectionCheckAt).toLocaleString('ru')}
                                </div>
                            )}
                            {isActive && (
                                <div className="text-[11px] text-[#3390EC] font-semibold mt-1">
                                    ● активный провайдер
                                </div>
                            )}
                            {!isActive && (
                                <div className="text-[12px] font-semibold text-[#3390EC] mt-2">
                                    Кликни чтобы переключиться →
                                </div>
                            )}
                        </div>
                    )
                })}
            </div>

            <div className="space-y-4 pt-1">
                <div>
                    <label className="text-[12px] text-gray-500 mb-1.5 flex items-center gap-1.5">
                        API ключ для <b className="text-[#111]">{PROVIDER_META[config.provider]?.name ?? config.provider}</b>
                        <a href={PROVIDER_META[config.provider]?.keysUrl ?? '#'} target="_blank" rel="noreferrer" className="text-[#3390EC] hover:underline">— где взять</a>
                    </label>
                    <div className="flex gap-2">
                        <input
                            type="password"
                            value={apiKey}
                            onChange={e => {
                                setApiKey(e.target.value)
                                setTestStatus('idle')
                                if (config.connectionStatus) {
                                    setConfig(c => ({ ...c, connectionStatus: null }))
                                }
                            }}
                            placeholder={config.apiKeyEncrypted ? '••••••••••••••••' : providerDef.keyPlaceholder}
                            className="flex-1 h-[36px] border border-[#E0E0E0] rounded-lg px-3 text-[13px] outline-none focus:border-[#3390EC] font-mono"
                        />
                        <button
                            onClick={handleTestConnection}
                            disabled={testStatus === 'testing'}
                            className={`h-[36px] px-4 text-[12px] font-semibold rounded-lg disabled:opacity-50 transition-colors ${
                                effectiveStatus === 'ok'
                                    ? 'bg-white border border-emerald-300 text-emerald-700 hover:bg-emerald-50'
                                    : effectiveStatus === 'error'
                                    ? 'bg-red-600 text-white hover:bg-red-700'
                                    : 'bg-[#3390EC] text-white hover:bg-[#2B7FD4]'
                            }`}
                        >
                            {testStatus === 'testing' ? 'Проверка...' : theme.buttonLabel}
                        </button>
                    </div>
                    {testStatus === 'error' && testError && (
                        <div className="flex items-center gap-1 mt-1.5 text-[11px] text-red-500">
                            <XCircle size={11} /> {testError}
                        </div>
                    )}
                    {/* PR9.19: явное пояснение про сохранённый ключ +
                        last-4 chars для уверенности «он реально есть». */}
                    {config.apiKeyEncrypted && !apiKey.trim() ? (
                        <div className="mt-1.5 flex items-center gap-2 text-[11px] text-gray-600">
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-emerald-50 border border-emerald-200 rounded font-mono text-emerald-700">
                                <CheckCircle2 size={11} /> сохранён ключ •••{(config.apiKeyEncrypted as string).slice(-4)}
                            </span>
                            <span className="text-gray-500">— работает автоматически. Введи новый чтобы заменить.</span>
                        </div>
                    ) : apiKey.trim() ? (
                        <div className="text-[11px] text-gray-500 mt-1.5 leading-relaxed">
                            Чтобы сохранить введённый ключ — нажми «Проверить» (при успехе сохранится автоматически) или «Сохранить» внизу.
                        </div>
                    ) : (
                        <div className="text-[11px] text-gray-500 mt-1.5 leading-relaxed">
                            Введите API-ключ от {PROVIDER_META[config.provider]?.name ?? config.provider}.
                        </div>
                    )}
                </div>

                {/* Расширенные настройки — в свёрнутом блоке, чтобы основной
                    флоу «выбрал провайдера → вставил ключ → проверил → сохранил»
                    не загромождался моделями и роутингом. */}
                <details className="group rounded-lg border border-[#F0F0F0] bg-[#FAFAFA]">
                    <summary className="flex items-center gap-1.5 cursor-pointer select-none px-3 py-2 text-[12px] font-medium text-gray-600 hover:text-[#111]">
                        <ChevronDown size={13} className="transition-transform group-open:rotate-180" />
                        Дополнительно: модели и маршрутизация
                    </summary>
                    <div className="px-3 pb-3 space-y-3">
                        <p className="text-[11px] text-gray-500 leading-[1.5]">
                            AI использует две модели. Дешёвая определяет, о чём вопрос, и отвечает на простое;
                            дорогая включается на сложных и длинных диалогах. Менять имена моделей не обязательно.
                        </p>
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label className="text-[12px] text-gray-500 block mb-1">
                                    Дешёвая модель <Hint text="Определяет тип вопроса (FAQ / жалоба / сложный) и отвечает на простое. Тратится в каждом сообщении." />
                                </label>
                                <input
                                    value={config.classificationModel}
                                    onChange={e => setConfig(c => ({ ...c, classificationModel: e.target.value }))}
                                    placeholder={providerDef.classification}
                                    className="w-full h-[32px] border border-[#E0E0E0] bg-white rounded-lg px-3 text-[12px] outline-none focus:border-[#3390EC] font-mono"
                                />
                                <div className="text-[10px] text-gray-400 mt-0.5">
                                    По умолчанию: <code className="font-mono">{providerDef.classification}</code>
                                </div>
                            </div>
                            <div>
                                <label className="text-[12px] text-gray-500 block mb-1">
                                    Дорогая модель <Hint text="Генерирует финальный текст ответа на сложные и длинные вопросы." />
                                </label>
                                <input
                                    value={config.responseModel}
                                    onChange={e => setConfig(c => ({ ...c, responseModel: e.target.value }))}
                                    placeholder={providerDef.response}
                                    className="w-full h-[32px] border border-[#E0E0E0] bg-white rounded-lg px-3 text-[12px] outline-none focus:border-[#3390EC] font-mono"
                                />
                                <div className="text-[10px] text-gray-400 mt-0.5">
                                    По умолчанию: <code className="font-mono">{providerDef.response}</code>
                                </div>
                            </div>
                        </div>

                        <div className="pt-1">
                            <h5 className="text-[12px] font-medium text-gray-600 mb-1.5">Что какая модель делает</h5>
                            <div className="space-y-1.5 text-[11px] text-gray-600">
                                <div className="flex items-center gap-2 bg-white rounded-lg px-3 py-1.5 border border-[#F0F0F0]">
                                    <span className="w-[140px] text-gray-500">Понять, о чём вопрос</span>
                                    <span className="text-gray-300">→</span>
                                    <span className="font-mono">{config.classificationModel}</span>
                                </div>
                                <div className="flex items-center gap-2 bg-white rounded-lg px-3 py-1.5 border border-[#F0F0F0]">
                                    <span className="w-[140px] text-gray-500">FAQ / простой ответ</span>
                                    <span className="text-gray-300">→</span>
                                    <span className="font-mono">{config.classificationModel}</span>
                                </div>
                                <div className="flex items-center gap-2 bg-white rounded-lg px-3 py-1.5 border border-[#F0F0F0]">
                                    <span className="w-[140px] text-gray-500">Сложный / длинный</span>
                                    <span className="text-gray-300">→</span>
                                    <span className="font-mono">{config.responseModel}</span>
                                </div>
                                <div className="flex items-center gap-2 bg-red-50 rounded-lg px-3 py-1.5 text-red-600">
                                    <span className="w-[140px]">Жалоба / конфликт</span>
                                    <span>→</span>
                                    <span className="font-semibold">Всегда оператор</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </details>

                {/* PR9.15: lastConnectionCheckAt уже виден в карточке
                    статуса сверху — duplicate-строка убрана. */}

                <button
                    onClick={handleSaveProvider}
                    disabled={providerSaving}
                    className="h-[36px] px-5 bg-[#3390EC] text-white text-[13px] font-semibold rounded-lg hover:bg-[#2B7FD4] disabled:opacity-50 transition-colors flex items-center gap-1.5"
                >
                    <Save size={12} />
                    {providerSaving ? 'Сохраняем...' : 'Сохранить'}
                </button>
            </div>
        </div>
    )
    }

    // ─── Вкладка: Правила ─────────────────────────────────────────

    const [rulesSaving, setRulesSaving] = useState(false)

    const handleSaveRules = async () => {
        // Промпт-поля (role/tone/allowed/forbidden) больше не идут через
        // saveAiConfig — они живут в AiAgentProfile и сохраняются
        // отдельно через updateAiProfile внутри ProfilesEditor.
        setRulesSaving(true)
        try {
            await saveAiConfig({
                mode:                  config.mode,
                language:              config.language,
                confidenceThreshold:   config.confidenceThreshold,
                maxAutoRepliesPerChat: config.maxAutoRepliesPerChat,
                activeChannels:        config.activeChannels,
            })
            showToast('Правила сохранены')
        } catch (e: any) {
            showToast('Ошибка: ' + e.message)
        } finally {
            setRulesSaving(false)
        }
    }

    const RulesTab = () => (
        <div className="space-y-6">
            <InlineInfo>
                Начните с «Советует». Когда в Журнале увидите, что AI отвечает правильно — переключитесь на «Автоответ».
            </InlineInfo>
            {/* Режим — flat-секция, без обёртки. Заголовок + spacing
                разделяют её от Промпта ниже. */}
            <div className="space-y-3 pt-1">
                <h4 className="text-[14px] font-semibold text-[#111]">Что AI делает</h4>
                <div className="grid grid-cols-2 gap-2">
                    {([
                        { val: 'off',             label: 'Выключен', hint: 'AI не работает совсем.' },
                        { val: 'suggest_only',    label: 'Советует', hint: 'AI пишет ответ в подсказку. Отправляет менеджер вручную.' },
                        { val: 'auto_reply',      label: 'Автоответ', hint: 'AI отвечает сам, если уверен. Иначе передаёт менеджеру.' },
                        { val: 'operator_locked', label: 'Оператор', hint: 'AI не отвечает — все диалоги уходят менеджеру.' },
                    ]).map(({ val, label, hint }) => (
                        <button
                            key={val}
                            onClick={() => setConfig(c => ({ ...c, mode: val }))}
                            title={hint}
                            className={`h-[36px] rounded-lg text-[12px] font-semibold border transition-colors ${
                                config.mode === val
                                    ? 'bg-[#3390EC] text-white border-[#3390EC]'
                                    : 'bg-white text-gray-600 border-[#E0E0E0] hover:border-[#3390EC]'
                            }`}
                        >
                            {label}
                        </button>
                    ))}
                </div>

                {/* Каналы */}
                <div>
                    <label className="text-[12px] text-gray-500 block mb-1.5">Активные каналы</label>
                    <div className="flex gap-2">
                        {(['max', 'telegram', 'whatsapp'] as const).map(ch => (
                            <button
                                key={ch}
                                onClick={() => setConfig(c => ({
                                    ...c,
                                    activeChannels: c.activeChannels.includes(ch)
                                        ? c.activeChannels.filter(x => x !== ch)
                                        : [...c.activeChannels, ch]
                                }))}
                                className={`px-3 h-[28px] rounded-lg text-[11px] font-semibold border transition-colors ${
                                    config.activeChannels.includes(ch)
                                        ? 'bg-[#3390EC] text-white border-[#3390EC]'
                                        : 'bg-white text-gray-600 border-[#E0E0E0] hover:border-[#3390EC]'
                                }`}
                            >
                                {CHANNEL_LABELS[ch]}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Пороги */}
                <div className="grid grid-cols-2 gap-3">
                    <div>
                        <label className="text-[12px] text-gray-500 mb-1 flex items-center gap-1.5">
                            Уверенность для автоответа
                            <Hint text="Чем выше порог, тем реже AI отвечает сам и чаще передаёт менеджеру. 0.75 — рекомендуемое стартовое значение." />
                            <span className="ml-auto text-[12px] font-mono font-semibold text-[#111]">{Math.round(config.confidenceThreshold * 100)}%</span>
                        </label>
                        <input
                            type="range" min={0} max={1} step={0.05}
                            value={config.confidenceThreshold}
                            onChange={e => setConfig(c => ({ ...c, confidenceThreshold: parseFloat(e.target.value) }))}
                            className="w-full h-[32px] accent-[#3390EC]"
                        />
                        <div className="flex justify-between text-[10px] text-gray-400">
                            <span>отвечает чаще</span>
                            <span>отвечает реже</span>
                        </div>
                    </div>
                    <div>
                        <label className="text-[12px] text-gray-500 mb-1 flex items-center gap-1.5">
                            Макс. автоответов подряд
                            <Hint text="После N автоответов в одном чате AI замолкает и передаёт диалог менеджеру — даже если уверен. Защита от бесконечного диалога с ботом." />
                        </label>
                        <input
                            type="number" min={1} max={50}
                            value={config.maxAutoRepliesPerChat}
                            onChange={e => setConfig(c => ({ ...c, maxAutoRepliesPerChat: parseInt(e.target.value) }))}
                            className="w-full h-[32px] border border-[#E0E0E0] rounded-lg px-3 text-[12px] outline-none focus:border-[#3390EC]"
                        />
                        <div className="text-[10px] text-gray-400 mt-0.5">После — диалог уходит менеджеру</div>
                    </div>
                </div>
            </div>

            {/* Стиль общения — управляется через профили. Раньше тут
                жили 4 textarea, напрямую писавшие в AiAgentConfig
                (promptRole/Tone/Allowed/Forbidden). Теперь — отдельная
                сущность AiAgentProfile, можно держать несколько стилей
                и переключать активный (по аналогии с проектами в
                /settings/integrations/ai-call-scenarios). */}
            <ProfilesEditor
                profiles={profiles}
                setProfiles={setProfiles}
                activeProfileId={activeProfileId}
                setActiveProfileId={setActiveProfileId}
                canEdit={canEdit}
                showToast={showToast}
            />

            <button
                onClick={handleSaveRules}
                disabled={rulesSaving}
                className="h-[32px] px-4 bg-[#3390EC] text-white text-[12px] font-semibold rounded-lg hover:bg-[#2B7FD4] disabled:opacity-50 transition-colors flex items-center gap-1.5"
            >
                <Save size={11} />
                {rulesSaving ? 'Сохраняем...' : 'Сохранить правила'}
            </button>
        </div>
    )

    // ─── Вкладка: База знаний ─────────────────────────────────────

    const [showKbForm, setShowKbForm] = useState(false)
    const [kbForm, setKbForm] = useState({
        title: '', category: 'general', answer: '',
        sampleQuestions: '', tags: '', channels: ['max'], priority: 0
    })
    const [kbSaving, setKbSaving] = useState(false)

    const handleCreateKb = async () => {
        if (!kbForm.title || !kbForm.answer) { showToast('Заполните заголовок и ответ'); return }
        setKbSaving(true)
        try {
            const entry = await createKnowledgeEntry({
                title:           kbForm.title,
                category:        kbForm.category,
                sampleQuestions: kbForm.sampleQuestions.split('\n').filter(Boolean),
                answer:          kbForm.answer,
                tags:            kbForm.tags.split(',').map(t => t.trim()).filter(Boolean),
                channels:        kbForm.channels,
                priority:        kbForm.priority,
            })
            setKb(prev => [entry, ...prev])
            setKbForm({ title: '', category: 'general', answer: '', sampleQuestions: '', tags: '', channels: ['max'], priority: 0 })
            setShowKbForm(false)
            showToast('Запись добавлена')
        } catch (e: any) {
            showToast('Ошибка: ' + e.message)
        } finally {
            setKbSaving(false)
        }
    }

    const handleToggleKb = async (entry: KbEntry) => {
        await updateKnowledgeEntry(entry.id, { active: !entry.active })
        setKb(prev => prev.map(e => e.id === entry.id ? { ...e, active: !e.active } : e))
    }

    const handleDeleteKb = async (id: string) => {
        const entry = kb.find(e => e.id === id)
        const label = entry?.title ? `«${entry.title}»` : 'эту запись'
        if (!confirm(`Удалить ${label}? Действие нельзя отменить.`)) return
        await deleteKnowledgeEntry(id)
        setKb(prev => prev.filter(e => e.id !== id))
        showToast('Удалено')
    }

    // PR5: Legacy KB migration. State машина: idle → preview → running →
    // result. Открывается из KbTab по кнопке "Перенести в Ядро".
    const [migrationOpen, setMigrationOpen]       = useState(false)
    const [migrationPreview, setMigrationPreview] =
        useState<LegacyMigrationPreview | null>(null)
    const [migrationLoading, setMigrationLoading] = useState(false)
    const [migrationRunning, setMigrationRunning] = useState(false)
    const [migrationResult, setMigrationResult]   =
        useState<LegacyMigrationResult | null>(null)
    // Свёрнутость legacy KB block — namespace по-умолчанию: если есть
    // KbEntry, разворачиваем; иначе свёрнуто.
    const [legacyExpanded, setLegacyExpanded] = useState(initialKb.length > 0)

    async function openMigrationModal() {
        setMigrationOpen(true)
        setMigrationResult(null)
        setMigrationLoading(true)
        try {
            const p = await getLegacyMigrationPreview()
            setMigrationPreview(p as LegacyMigrationPreview)
        } catch (e: any) {
            showToast('Ошибка preview: ' + (e?.message ?? 'unknown'))
        } finally {
            setMigrationLoading(false)
        }
    }
    async function runMigration() {
        if (migrationRunning) return
        setMigrationRunning(true)
        try {
            const r = await migrateLegacyKnowledgeBase()
            setMigrationResult(r as LegacyMigrationResult)
            // После миграции — обновим readiness и текущую секцию ядра.
            refreshReadiness()
            if (selectedSectionId) {
                const arr = await listItemsBySection(selectedSectionId, {
                    includeArchived: knowledgeSubtab === 'archive',
                })
                setKnowledgeItems(arr as KnowledgeItem[])
            }
            const stats = await getKnowledgeStatsAction()
            setKnowledgeStats(stats as KnowledgeStats)
            if ((r as LegacyMigrationResult).migrated > 0) {
                showToast(`Перенесено в ядро: ${(r as LegacyMigrationResult).migrated}`)
            }
        } catch (e: any) {
            showToast('Ошибка миграции: ' + (e?.message ?? 'unknown'))
        } finally {
            setMigrationRunning(false)
        }
    }

    const KbTab = () => (
        <div className="space-y-4">
            {/* PR5: deprecation banner — старая база остаётся доступной,
                но рекомендуем переносить в Ядро знаний. Без physical
                delete — reversible path. */}
            <div className="rounded-md border border-[#FFE8B0] bg-[#FFFBED] px-4 py-3 text-[12px] text-[#8B6914] leading-relaxed">
                <strong className="block mb-1 text-[#8B6914]">База знаний — устаревший раздел</strong>
                Это ручные FAQ-карточки старого формата. Теперь AI берёт ответы из{' '}
                <strong>Ядра знаний</strong> — оно собирается автоматически из реальных
                переписок. Старые записи остаются доступными до миграции, потом их
                можно скрыть.{' '}
                <a
                    href="/settings/integrations/ai-knowledge-help#a-overview"
                    target="_blank"
                    rel="noopener"
                    className="text-[#3390EC] hover:underline"
                >
                    В чём разница →
                </a>
            </div>

            <InlineInfo>
                Точные ответы, которые AI должен знать без выдумок: условия работы,
                цены, график, частые вопросы.
            </InlineInfo>
            <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="text-[12px] text-gray-500">{kb.length} {kb.length === 1 ? 'запись' : kb.length >= 2 && kb.length <= 4 ? 'записи' : 'записей'}</span>
                <div className="flex items-center gap-2">
                    {kb.length > 0 && (
                        <button
                            onClick={openMigrationModal}
                            disabled={!canEdit}
                            title={canEdit
                                ? 'Перенести записи из базы знаний в Ядро (как verified-факты). Базу не удаляет.'
                                : 'Доступно только Администратору'}
                            className="h-[28px] px-3 inline-flex items-center gap-1 rounded-lg border border-[#3390EC] text-[#3390EC] text-[11px] font-semibold hover:bg-[#F0F4FA] disabled:opacity-40 transition-colors"
                        >
                            Перенести в Ядро
                        </button>
                    )}
                    <button
                        onClick={() => setShowKbForm(v => !v)}
                        className="h-[28px] px-3 bg-[#3390EC] text-white text-[11px] font-semibold rounded-lg hover:bg-[#2B7FD4] transition-colors flex items-center gap-1"
                    >
                        <Plus size={11} /> Добавить
                    </button>
                </div>
            </div>

            {showKbForm && (
                <div className="bg-[#F8F9FA] border border-[#E8E8E8] rounded-xl p-4 space-y-2.5 animate-in fade-in duration-150">
                    {/* Список существующих категорий — datalist подсказывает админу
                        уже использованные значения, чтобы не плодить «general» /
                        «General» / «общее» вариантов. Свободный ввод остаётся. */}
                    <datalist id="kb-categories">
                        {Array.from(new Set(kb.map(e => e.category).filter(Boolean))).map(c => (
                            <option key={c} value={c} />
                        ))}
                        <option value="general" />
                        <option value="driver" />
                        <option value="payments" />
                        <option value="docs" />
                    </datalist>
                    <div className="grid grid-cols-2 gap-2">
                        <div>
                            <label className="text-[11px] text-gray-500 block mb-1">Заголовок *</label>
                            <input value={kbForm.title} onChange={e => setKbForm(f => ({ ...f, title: e.target.value }))}
                                placeholder="Как получить справку?" className="w-full h-[30px] border border-[#E0E0E0] bg-white rounded-lg px-2 text-[12px] outline-none focus:border-[#3390EC]" />
                        </div>
                        <div>
                            <label className="text-[11px] text-gray-500 mb-1 flex items-center gap-1.5">
                                Категория <Hint text="Произвольная метка для группировки. Выпадающий список подсказывает уже использованные значения." />
                            </label>
                            <input list="kb-categories" value={kbForm.category} onChange={e => setKbForm(f => ({ ...f, category: e.target.value }))}
                                placeholder="general" className="w-full h-[30px] border border-[#E0E0E0] bg-white rounded-lg px-2 text-[12px] outline-none focus:border-[#3390EC]" />
                        </div>
                    </div>
                    <div>
                        <label className="text-[11px] text-gray-500 mb-1 flex items-center gap-1.5">
                            Примеры вопросов (по одному на строку)
                            <Hint text="Как водитель может спросить о том же самом. Помогает AI узнать запрос в живой переписке." />
                        </label>
                        <textarea rows={2} value={kbForm.sampleQuestions} onChange={e => setKbForm(f => ({ ...f, sampleQuestions: e.target.value }))}
                            placeholder={"Как мне получить справку?\nГде взять документы?"} className="w-full border border-[#E0E0E0] bg-white rounded-lg px-2 py-1.5 text-[12px] outline-none focus:border-[#3390EC] resize-none" />
                    </div>
                    <div>
                        <label className="text-[11px] text-gray-500 block mb-1">Ответ *</label>
                        <textarea rows={3} value={kbForm.answer} onChange={e => setKbForm(f => ({ ...f, answer: e.target.value }))}
                            placeholder="Справки выдаются в офисе по адресу..." className="w-full border border-[#E0E0E0] bg-white rounded-lg px-2 py-1.5 text-[12px] outline-none focus:border-[#3390EC] resize-none" />
                    </div>
                    {/* Расширенные поля: теги / приоритет — большинству админов
                        не нужны на старте, поэтому скрыты в свёрнутом блоке. */}
                    <details className="group rounded-lg border border-[#E8E8E8] bg-white">
                        <summary className="flex items-center gap-1.5 cursor-pointer select-none px-3 py-1.5 text-[11px] font-medium text-gray-500 hover:text-[#111]">
                            <ChevronDown size={12} className="transition-transform group-open:rotate-180" />
                            Дополнительно
                        </summary>
                        <div className="px-3 pb-3 grid grid-cols-2 gap-2 pt-1">
                            <div>
                                <label className="text-[11px] text-gray-500 mb-1 flex items-center gap-1.5">
                                    Теги <Hint text="Через запятую. Для поиска и фильтрации внутри базы знаний." />
                                </label>
                                <input value={kbForm.tags} onChange={e => setKbForm(f => ({ ...f, tags: e.target.value }))}
                                    placeholder="справка, документы" className="w-full h-[30px] border border-[#E0E0E0] bg-[#F8F9FA] rounded-lg px-2 text-[12px] outline-none focus:border-[#3390EC]" />
                            </div>
                            <div>
                                <label className="text-[11px] text-gray-500 mb-1 flex items-center gap-1.5">
                                    Приоритет <Hint text="Если несколько записей подходят к одному вопросу — AI берёт ту, у которой число больше. 0 — обычная запись." />
                                </label>
                                <input type="number" min={0} max={100} value={kbForm.priority} onChange={e => setKbForm(f => ({ ...f, priority: +e.target.value }))}
                                    className="w-full h-[30px] border border-[#E0E0E0] bg-[#F8F9FA] rounded-lg px-2 text-[12px] outline-none focus:border-[#3390EC]" />
                            </div>
                        </div>
                    </details>
                    <div className="flex gap-2 pt-1">
                        <button onClick={handleCreateKb} disabled={kbSaving}
                            className="h-[28px] px-3 bg-[#3390EC] text-white text-[11px] font-semibold rounded-lg hover:bg-[#2B7FD4] disabled:opacity-50 transition-colors">
                            {kbSaving ? 'Сохраняем...' : 'Сохранить'}
                        </button>
                        <button onClick={() => setShowKbForm(false)} className="h-[28px] px-3 bg-gray-100 text-gray-600 text-[11px] rounded-lg hover:bg-gray-200 transition-colors">Отмена</button>
                    </div>
                </div>
            )}

            {kb.length === 0 && (
                <div className="text-center py-10 text-gray-500 text-[13px]">
                    <div className="font-medium text-[#111] mb-1">Пока ничего</div>
                    <div className="text-[12px]">Добавьте 3–5 базовых FAQ — без них AI будет «фантазировать» по контексту.</div>
                </div>
            )}

            {/* PR5: список обёрнут в свёртываемый "Legacy" блок.
                Не physical delete — reversible: можно развернуть и
                продолжить работу со старой базой при необходимости. */}
            {kb.length > 0 && (
                <div className="rounded-md border border-[#E8E8E8]">
                    <button
                        type="button"
                        onClick={() => setLegacyExpanded(v => !v)}
                        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-[12px] text-gray-500 hover:bg-[#FAFBFC] transition-colors"
                    >
                        <span>
                            <span className="font-medium text-[#111]">Старая база FAQ</span>
                            <span className="ml-2 text-gray-400">{kb.length}</span>
                        </span>
                        <span className="text-[11px] text-gray-400">
                            {legacyExpanded ? 'свернуть' : 'развернуть'}
                        </span>
                    </button>
                    {legacyExpanded && (
                <div className="divide-y divide-[#F0F0F0] border-t border-[#F0F0F0]">
                    {kb.map(entry => (
                        <div key={entry.id} className={`py-3.5 flex items-start gap-2 px-3 transition-opacity ${entry.active ? '' : 'opacity-50'}`}>
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-0.5">
                                    <span className="text-[13px] font-semibold text-[#111] truncate">{entry.title}</span>
                                    <span className="text-[10px] text-gray-400">{entry.category}</span>
                                    {entry.priority > 0 && (
                                        <span title={`Приоритет ${entry.priority} из 100 — выше шанс быть выбранной AI`}
                                              className="text-[10px] text-[#3390EC] cursor-help">★ {entry.priority}</span>
                                    )}
                                </div>
                                <p className="text-[12px] text-gray-600 line-clamp-2 leading-[1.5]">{entry.answer}</p>
                                {entry.tags.length > 0 && (
                                    <div className="flex flex-wrap gap-x-2 mt-1 text-[11px] text-gray-400">
                                        {entry.tags.map(t => (
                                            <span key={t}>#{t}</span>
                                        ))}
                                    </div>
                                )}
                            </div>
                            <div className="flex items-center gap-2 shrink-0 text-[11px]">
                                <button onClick={() => handleToggleKb(entry)}
                                    className={`transition-colors ${entry.active ? 'text-green-600 hover:underline' : 'text-gray-400 hover:text-[#111]'}`}>
                                    {entry.active ? 'вкл' : 'выкл'}
                                </button>
                                <button onClick={() => handleDeleteKb(entry.id)}
                                    title="Удалить запись"
                                    className="text-gray-300 hover:text-red-500 transition-colors">
                                    <Trash2 size={12} />
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
                    )}
                </div>
            )}
        </div>
    )

    // ─── Вкладка: Ядро знаний (AI Knowledge Core, PR1 read-only) ──
    //
    // Book-style layout: оглавление слева, items выбранного раздела
    // справа. Под-табы Ядро/Источники/Архив. Кнопка "Собрать ядро"
    // disabled — extraction появится в PR2.

    const KnowledgeItemRow = ({ item }: { item: KnowledgeItem }) => {
        const confidenceLabel =
            item.confidence >= 0.8 ? 'высокая' :
            item.confidence >= 0.5 ? 'средняя' : 'низкая'
        const confidenceColor =
            item.confidence >= 0.8 ? 'text-green-600' :
            item.confidence >= 0.5 ? 'text-gray-500' : 'text-amber-600'
        const isArchived = item.status === 'archived' || item.status === 'superseded' || !item.isActive
        const displayTags = item.tags.filter(t => !t.startsWith('type:'))
        return (
            <div className={`py-3.5 flex items-start gap-3 group ${!item.isActive ? 'opacity-60' : ''}`}>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                        <span className="text-[13px] font-semibold text-[#111] truncate">{item.title}</span>
                        {item.isVerified && (
                            <span title={item.verifiedAt
                                ? `Админ подтвердил точность этого факта ${new Date(item.verifiedAt).toLocaleDateString('ru')}. AI делает на нём упор в ответе.`
                                : 'Админ подтвердил точность этого факта. AI делает на нём упор.'}
                                  className="inline-flex items-center gap-0.5 text-[10px] text-green-700 cursor-help">
                                <CheckCircle2 size={11} /> подтверждено
                            </span>
                        )}
                        {item.sourceCount === 1 && (
                            <span title="Этот факт встретился только в одной переписке — желательно подтвердить ещё в одной перед runtime."
                                  className="text-[10px] text-gray-400 cursor-help">один источник</span>
                        )}
                        {item.safetyLevel === 'sensitive' && (
                            <span title="Чувствительная тема — AI отвечает фактом, но добавляет более осторожную формулировку."
                                  className="text-[10px] text-amber-600 cursor-help">чувствительное</span>
                        )}
                        {item.safetyLevel === 'requires_human' && (
                            <span title="AI не отвечает сам — даже если факт точный, тема требует менеджера. Diff показывает в explainability как «пропущено: требует менеджера»."
                                  className="text-[10px] text-red-600 cursor-help">только менеджер</span>
                        )}
                        {item.conflictGroupId && (
                            <button
                                onClick={() => canEdit && openConflictResolver(item)}
                                disabled={!canEdit}
                                className="text-[10px] text-amber-600 hover:underline disabled:no-underline disabled:cursor-default"
                                title={canEdit
                                    ? 'Два факта противоречат друг другу. Откройте, чтобы выбрать правильный — остальные уйдут в архив.'
                                    : 'Два факта противоречат друг другу. Админ должен разрешить конфликт.'}
                            >
                                ⚠ конфликт
                            </button>
                        )}
                        {/* PR6: trustedGuard заблокировал этот candidate
                            потому что он противоречит подтверждённому
                            правилу. Tag формат "conflicts_with_trusted:<id>". */}
                        {(() => {
                            const trustedConflictTag = item.tags.find(t => t.startsWith('conflicts_with_trusted:'))
                            if (!trustedConflictTag) return null
                            const trustedId = trustedConflictTag.slice('conflicts_with_trusted:'.length)
                            const trustedItem = knowledgeItems.find(k => k.id === trustedId)
                            return (
                                <span
                                    title={trustedItem
                                        ? `Менеджер в чате сказал что-то, что расходится с подтверждённым правилом «${trustedItem.title}». В runtime AI это не использует — нужно ручное решение администратора.`
                                        : 'Менеджер в чате сказал что-то, что расходится с подтверждённым правилом компании. В runtime AI это не использует — нужно ручное решение администратора.'}
                                    className="text-[10px] text-red-600 cursor-help"
                                >
                                    ⛔ противоречит правилу
                                </span>
                            )
                        })()}
                        {/* PR6: trustedGuard пометил этот candidate как
                            подтверждение verified/legacy правила. */}
                        {item.tags.some(t => t.startsWith('matches_trusted:')) && (
                            <span
                                title="Менеджеры в чатах подтверждают это правило — оно совпадает с подтверждённым фактом. Можно усилить."
                                className="text-[10px] text-green-700 cursor-help"
                            >
                                ✓ подтверждает правило
                            </span>
                        )}
                        {/* PR7.9: Verified/manual item, у которого все
                            исходные source-аккаунты отключены — UI-сигнал
                            что evidence ушло, но запись сохранилась
                            намеренно из-за trust-level. */}
                        {item.tags.includes('sources_all_disabled') && (
                            <span
                                title="Все исходные аккаунты, откуда AI узнал об этом, отключены админом. Знание оставлено активным, потому что подтверждено вручную или добавлено как ручная запись. Рекомендуется проверить актуальность."
                                className="text-[10px] text-amber-700 cursor-help"
                            >
                                ⚠ источники отключены
                            </span>
                        )}
                        {item.status === 'superseded' && (() => {
                            const successor = item.supersededByItemId
                                ? knowledgeItems.find(k => k.id === item.supersededByItemId)
                                : null
                            return (
                                <span
                                    title="Факт устарел и заменён новой версией. Старые ответы AI всё равно ссылаются на него — это нужно для истории explainability."
                                    className="text-[10px] text-gray-400 cursor-help inline-flex items-center gap-1"
                                >
                                    → заменено{successor && `: ${successor.title}`}
                                </span>
                            )
                        })()}
                        {item.status === 'draft' && (
                            <span title="Не прошло порог уверенности — ждёт ручной проверки"
                                  className="text-[10px] text-blue-500">черновик</span>
                        )}
                    </div>
                    <p className="text-[12px] text-gray-600 line-clamp-2 leading-[1.5]">
                        {item.canonicalStatement}
                    </p>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1 text-[10px] text-gray-400">
                        <span>
                            {item.sourceCount === 0
                                ? 'создано вручную'
                                : `найдено в ${item.sourceCount} ${plural(item.sourceCount,'диалоге','диалогах','диалогах')}`}
                        </span>
                        {item.uniqueManagerCount > 0 && (
                            <span>· {item.uniqueManagerCount} {plural(item.uniqueManagerCount,'менеджер','менеджера','менеджеров')}</span>
                        )}
                        {item.sourceCount > 0 && (
                            <span>· уверенность <span className={confidenceColor}>{confidenceLabel}</span></span>
                        )}
                        {displayTags.length > 0 && (
                            <span>· {displayTags.map(t => `#${t}`).join(' ')}</span>
                        )}
                    </div>
                    {/* PR7.12: compact source-account line — «откуда взято»
                        одной строкой. Не дублирует existing sources_all_disabled
                        badge выше (тот amber-warning), а просто перечисляет
                        конкретные аккаунты. Для manual-entry (sourceCount=0)
                        и не-доступных badges — не рисуем. */}
                    {(() => {
                        const badges = itemBadges[item.id]
                        if (!badges || item.sourceCount === 0) return null
                        const named = badges.rows
                            .filter(r => r.connectionId !== null)
                            .slice(0, 2)
                            .map(r => channelConnections.find(c => c.id === r.connectionId))
                            .filter(Boolean) as ChannelConnection[]
                        const extra = badges.distinctConnections - named.length
                        // case 1: только NULL connectionIds (legacy/manual_entry)
                        if (named.length === 0 && badges.hasUnknownSource) {
                            return (
                                <div className="mt-1 text-[10px] text-gray-400 leading-[1.4]"
                                     title="Эти сообщения были загружены до того, как мы стали запоминать привязку к аккаунту, поэтому точный источник не сохранён.">
                                    Источник аккаунта неизвестен
                                </div>
                            )
                        }
                        // case 2: есть известные connectionIds — рисуем список
                        if (named.length > 0) {
                            return (
                                <div className="mt-1 text-[10px] text-gray-500 leading-[1.4] flex flex-wrap gap-x-1.5">
                                    <span className="text-gray-400">Откуда взято:</span>
                                    {named.map((c, i) => (
                                        <span key={c.id} className={i === 0 ? 'text-gray-600' : 'text-gray-500'}>
                                            {c.label}
                                        </span>
                                    ))}
                                    {extra > 0 && (
                                        <span className="text-gray-400">
                                            · ещё {extra}
                                        </span>
                                    )}
                                    {badges.hasUnknownSource && (
                                        <span className="text-gray-400"
                                              title="Часть источников этого знания была загружена до того, как мы стали запоминать привязку к аккаунту.">
                                            · и часть без точного аккаунта
                                        </span>
                                    )}
                                </div>
                            )
                        }
                        return null
                    })()}
                </div>
                {canEdit && (
                    <div className="shrink-0 flex items-start gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button onClick={() => openEditFor(item)} title="Редактировать"
                            className="h-7 w-7 inline-flex items-center justify-center text-gray-400 hover:text-[#3390EC] hover:bg-[#F0F4FA] rounded-md">
                            <Save size={13} />
                        </button>
                        {item.isActive && (
                            <button onClick={() => handleVerify(item, !item.isVerified)}
                                title={item.isVerified ? 'Снять подтверждение' : 'Подтвердить'}
                                className={`h-7 w-7 inline-flex items-center justify-center rounded-md ${
                                    item.isVerified
                                        ? 'text-green-600 hover:bg-green-50'
                                        : 'text-gray-400 hover:text-green-600 hover:bg-green-50'
                                }`}>
                                <CheckCircle2 size={13} />
                            </button>
                        )}
                        {isArchived ? (
                            <button onClick={() => handleRestore(item)} title="Восстановить из архива"
                                disabled={item.status === 'superseded'}
                                className="h-7 w-7 inline-flex items-center justify-center text-gray-400 hover:text-[#3390EC] hover:bg-[#F0F4FA] rounded-md disabled:opacity-40 disabled:cursor-not-allowed">
                                <RefreshCw size={13} />
                            </button>
                        ) : (
                            <button onClick={() => handleArchive(item)} title="В архив"
                                className="h-7 w-7 inline-flex items-center justify-center text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-md">
                                <Trash2 size={13} />
                            </button>
                        )}
                    </div>
                )}
            </div>
        )
    }

    // PR3.8: runtime mode pill (legend в шапке Sources).
    // PR5: clickable — открывает RuntimeRolloutModal с checklist'ом
    // готовности. PR5 humanization: убрали Runtime/Shadow/Legacy
    // англицизмы, теперь человеческие подписи.
    const RuntimeModePill = ({ state }: { state: typeof runtimeState }) => {
        const cfg =
            state.mode === 'runtime' ? { bg: 'bg-green-100',  txt: 'text-green-700', label: 'AI отвечает из ядра' } :
            state.mode === 'shadow'  ? { bg: 'bg-amber-100',  txt: 'text-amber-700', label: 'Тестовый режим' } :
                                       { bg: 'bg-gray-100',   txt: 'text-gray-500',  label: 'Старая система' }
        const title =
            state.mode === 'runtime' ? 'AI уже отвечает водителям из нового ядра знаний. Нажмите для проверки готовности.' :
            state.mode === 'shadow'  ? 'Новое ядро работает в фоне для наблюдения, водителям отвечает старая система. Нажмите для проверки готовности.' :
                                       'Новое ядро знаний пока не подключено к ответам AI. Нажмите для проверки готовности.'
        return (
            <button
                type="button"
                onClick={() => setRolloutOpen(true)}
                title={title}
                className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-opacity hover:opacity-80 ${cfg.bg} ${cfg.txt}`}
            >
                <span className="w-1.5 h-1.5 rounded-full bg-current"></span>
                {cfg.label}
            </button>
        )
    }

    // PR5: operational readiness — компактная строка с counters +
    // overall-pill + ссылкой на checklist. Не дашборд, а "пульс ядра".
    const KnowledgeReadinessRow = () => {
        const c = readiness.counts
        const lastExtr = readiness.lastExtraction
        const ago = lastExtr
            ? humanizeAgo(lastExtr.finishedAt ?? lastExtr.startedAt ?? lastExtr.createdAt)
            : 'нет данных'

        const overallCfg =
            readiness.overall === 'ok'   ? { bg: 'bg-green-100', txt: 'text-green-700', label: 'Готов' } :
            readiness.overall === 'warn' ? { bg: 'bg-amber-100', txt: 'text-amber-700', label: 'Нужна доводка' } :
                                            { bg: 'bg-red-100',   txt: 'text-red-700',   label: 'Не готов' }

        const h = readiness.health7d
        // health row показываем только если есть хоть одно значение
        const hasHealth = h.escalationPct != null || h.noMatchPct != null
            || h.verifiedUsagePct != null || h.shadowRuntimeMismatchPct != null
        const pct = (v: number | null) => v == null ? '—' : `${Math.round(v * 100)}%`

        return (
            <div className="space-y-1.5">
                <div className="flex items-center gap-3 flex-wrap rounded-md border border-[#E8E8E8] bg-[#FAFBFC] px-3 py-2 text-[12px] text-gray-600">
                    <span
                        title="Общая готовность ядра — самая слабая из 5 проверок ниже. Кликните «Проверить готовность» чтобы увидеть подробности."
                        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${overallCfg.bg} ${overallCfg.txt}`}
                    >
                        <span className="w-1.5 h-1.5 rounded-full bg-current"></span>
                        {overallCfg.label}
                    </span>
                    <span><strong className="text-[#111]">{c.activeItems}</strong> активных знаний</span>
                    <span className="text-gray-400">·</span>
                    <span><strong className="text-[#111]">{c.verifiedItems}</strong> подтверждённых</span>
                    {c.draftItems > 0 && (
                        <>
                            <span className="text-gray-400">·</span>
                            <span>{c.draftItems} черновиков</span>
                        </>
                    )}
                    {c.conflictGroups > 0 && (
                        <>
                            <span className="text-gray-400">·</span>
                            <span className="text-amber-700">{c.conflictGroups} конфликтов</span>
                        </>
                    )}
                    <span className="text-gray-400">·</span>
                    <span>сбор: {ago}</span>
                    <RuntimeModePill state={runtimeState} />
                    <button
                        type="button"
                        onClick={() => setRolloutOpen(true)}
                        className="ml-auto text-[12px] text-[#3390EC] hover:underline"
                    >
                        Проверить готовность
                    </button>
                </div>
                {/* PR5.10: health 7d — fitness "хорошо ли работает сейчас".
                    PR5-humanization: убрали "эскалация", "shadow≠actual"
                    и прочий dev-jargon. */}
                {hasHealth && (
                    <div className="flex items-center gap-3 flex-wrap px-3 py-1 text-[11px] text-gray-500">
                        <span className="uppercase tracking-wide text-[10px] text-gray-400">За 7 дней:</span>
                        {h.escalationPct != null && (
                            <span title={`AI передал менеджеру в ${pct(h.escalationPct)} диалогов из ${h.decisionsBase}. Низкий процент — AI справляется сам. Высокий — ему не хватает знаний.`}>
                                передал менеджеру <strong className={h.escalationPct > 0.65 ? 'text-red-600' : h.escalationPct > 0.4 ? 'text-amber-600' : 'text-[#111]'}>{pct(h.escalationPct)}</strong>
                            </span>
                        )}
                        {h.noMatchPct != null && (
                            <>
                                <span className="text-gray-300">·</span>
                                <span title={`AI не нашёл подходящих знаний в ${pct(h.noMatchPct)} диалогов из ${h.decisionsBase}. Если много — стоит добавить факты или собрать ядро заново.`}>
                                    не нашёл ответ <strong className="text-[#111]">{pct(h.noMatchPct)}</strong>
                                </span>
                            </>
                        )}
                        {h.verifiedUsagePct != null && (
                            <>
                                <span className="text-gray-300">·</span>
                                <span title={`Из ${h.usageBase} использованных знаний ${pct(h.verifiedUsagePct)} были проверены админом. Чем выше — тем безопаснее ответы AI.`}>
                                    из проверенных <strong className={h.verifiedUsagePct >= 0.6 ? 'text-green-700' : 'text-[#111]'}>{pct(h.verifiedUsagePct)}</strong>
                                </span>
                            </>
                        )}
                        {h.shadowRuntimeMismatchPct != null && (
                            <>
                                <span className="text-gray-300">·</span>
                                <span title="В тестовом режиме AI пробует ответить из ядра, но реально отвечает старая система. Этот процент — где они разошлись. Чем меньше — тем ближе ядро к готовности.">
                                    разошлось с реальностью <strong className={h.shadowRuntimeMismatchPct > 0.3 ? 'text-amber-600' : 'text-[#111]'}>{pct(h.shadowRuntimeMismatchPct)}</strong>
                                </span>
                            </>
                        )}
                    </div>
                )}
            </div>
        )
    }

    // PR5: rollout-checklist модал. PR5-humanization: убрали Runtime/
    // Shadow/Legacy/env-флаги из основного UI. Технические детали — в
    // collapsible accordion внизу для админа/разработчика.
    //
    // Operational language:
    //   "Runtime" → "AI отвечает из ядра знаний"
    //   "Shadow"  → "Тестовый режим"
    //   "Legacy"  → "Старая система ответов"
    //
    // Каждый check имеет tooltip "что/зачем/хорошо или плохо".
    const RuntimeRolloutModal = () => {
        if (!rolloutOpen) return null
        const r = readiness
        const checkIcon = (status: 'ok' | 'warn' | 'fail') =>
            status === 'ok' ? <span className="text-green-600">●</span> :
            status === 'warn' ? <span className="text-amber-600">●</span> :
                                <span className="text-red-600">●</span>

        // Tooltip-словарь "что/зачем/хорошо или плохо" для каждого check.
        const CHECK_HELP: Record<string, string> = {
            conflicts:          'Когда AI извлёк из переписок два противоречащих факта (например, разные цифры комиссии), он не может выбрать сам — нужен админ. Чем меньше противоречий, тем увереннее AI отвечает.',
            verified_coverage:  'Подтверждённые знания — это факты, точность которых уже проверил админ. AI делает на них упор. Чем больше подтверждено, тем безопаснее переключать AI на ответы из ядра.',
            extraction_recency: 'Сбор знаний из переписок нужно повторять время от времени — иначе ядро отстанет от живой жизни компании. Свежее = ближе к реальности.',
            shadow_activity:    'Прежде чем доверить AI отвечать из ядра, мы наблюдаем — какие ответы он БЫ дал, если бы отвечал сам. Чем больше таких наблюдений, тем точнее видно, готов он или нет.',
            escalation_rate:    'Процент диалогов, где AI решил «не отвечать сам, передать менеджеру». Здоровый уровень — небольшой процент. Если AI почти всегда передаёт менеджеру, значит ему не хватает знаний.',
        }

        // Описание текущего режима для humanized header.
        const modeDescription =
            runtimeState.mode === 'runtime' ? {
                title: 'AI отвечает из ядра знаний',
                body:  'AI уже использует новое ядро для ответов водителям. Старая база больше не применяется.',
            } : runtimeState.mode === 'shadow' ? {
                title: 'Тестовый режим',
                body:  'Новое ядро работает в фоне для наблюдения. Водителям отвечает старая система ответов — никаких рисков для реальных диалогов.',
            } : {
                title: 'Старая система ответов',
                body:  'Новое ядро ещё не подключено. AI отвечает по старым правилам / FAQ-карточкам.',
            }

        return (
            <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-16" onClick={() => setRolloutOpen(false)}>
                <div
                    className="bg-white rounded-lg shadow-xl w-full max-w-2xl flex flex-col max-h-[85vh] overflow-hidden"
                    onClick={e => e.stopPropagation()}
                >
                    <div className="px-6 py-4 border-b border-[#F0F0F0] flex items-center justify-between">
                        <div>
                            <h2 className="text-[16px] font-semibold text-[#111]">Готовность ядра знаний</h2>
                            <p className="text-[12px] text-gray-500 mt-0.5">
                                Видно, как продвигается подготовка AI к самостоятельным ответам.
                            </p>
                        </div>
                        <button
                            onClick={() => setRolloutOpen(false)}
                            className="text-gray-400 hover:text-[#111] text-[20px] leading-none"
                            aria-label="Закрыть"
                        >×</button>
                    </div>

                    <div className="px-6 py-4 overflow-y-auto space-y-5">
                        {/* Текущий режим — без env-флагов в основном UI */}
                        <div className="rounded-md border border-[#E8E8E8] bg-[#FAFBFC] p-3">
                            <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1.5">Сейчас</div>
                            <div className="flex items-center gap-2 mb-1">
                                <RuntimeModePill state={runtimeState} />
                                <span className="text-[13px] font-semibold text-[#111]">{modeDescription.title}</span>
                            </div>
                            <p className="text-[12px] text-gray-600 leading-relaxed">{modeDescription.body}</p>
                        </div>

                        {/* Checklist готовности — humanized labels, каждый с tooltip */}
                        <div>
                            <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-2">Готовность ядра</div>
                            <ul className="space-y-2">
                                {r.checks.map(ch => (
                                    <li key={ch.id} className="flex items-start gap-2 text-[13px]">
                                        <span className="mt-[2px] text-[14px] leading-none">{checkIcon(ch.status)}</span>
                                        <div className="flex-1">
                                            <div className="flex items-center gap-1.5">
                                                <span className="font-medium text-[#111]">{ch.label}</span>
                                                <span
                                                    title={CHECK_HELP[ch.id] ?? ''}
                                                    className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full border border-gray-300 text-[9px] text-gray-400 cursor-help"
                                                    aria-label="Подсказка"
                                                >?</span>
                                            </div>
                                            <div className="text-[12px] text-gray-500">{ch.detail}</div>
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        </div>

                        {/* Активность за 7 дней — humanized labels */}
                        <div>
                            <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-2">Что было за 7 дней</div>
                            <div className="grid grid-cols-2 gap-2 text-[12px]">
                                <Stat label="Всего ответов AI" value={r.activity7d.decisionsTotal} />
                                <Stat label="Тестовых наблюдений" value={r.activity7d.shadowDecisions} />
                                <Stat label="Передано менеджеру" value={r.activity7d.escalated} />
                                <Stat label="AI не нашёл ответ" value={r.activity7d.noMatch} />
                            </div>
                        </div>

                        {/* Humanized warning: не про env-флаги, а про процесс */}
                        <div className="rounded-md border border-[#FFE8B0] bg-[#FFFBED] p-3 text-[12px] text-[#8B6914] leading-relaxed">
                            <strong className="block mb-1 text-[#8B6914]">Новый режим включается отдельно</strong>
                            Сейчас новое ядро знаний работает только в тестовом режиме — водителям отвечает старая система. Прежде чем перевести AI на ответы из ядра, нужно:
                            <ul className="list-disc ml-5 mt-1.5 space-y-0.5">
                                <li>собрать знания (кнопка «Собрать ядро»)</li>
                                <li>посмотреть, что AI отвечает в тестовом режиме</li>
                                <li>подтвердить ключевые факты — тарифы, требования, документы</li>
                                <li>разрешить спорные знания, если они появятся</li>
                            </ul>
                            <p className="mt-2">
                                Когда все четыре пункта выше зелёные — разработчик отдельно включит новый режим на сервере. Это страховка от случайного переключения кнопкой.
                            </p>
                        </div>

                        {/* Технические детали — скрыто по-умолчанию, для админа/разработчика */}
                        <details className="group rounded-md border border-[#E8E8E8] bg-[#FAFAFA]">
                            <summary className="flex items-center gap-1.5 cursor-pointer select-none px-3 py-2 text-[11px] font-medium text-gray-500 hover:text-[#111]">
                                <ChevronDown size={12} className="transition-transform group-open:rotate-180" />
                                Технические детали (для разработчика)
                            </summary>
                            <div className="px-3 pb-3 text-[11px] text-gray-600 space-y-2">
                                <div>
                                    Режим управляется переменными окружения сервера. UI только показывает их фактическое значение, не флипает.
                                </div>
                                <div className="bg-white border border-[#E8E8E8] rounded px-2 py-1.5 font-mono text-[10px] leading-relaxed">
                                    AI_KNOWLEDGE_SHADOW_MODE = <strong>{runtimeState.shadowOn ? '1' : '0'}</strong><br/>
                                    AI_KNOWLEDGE_RUNTIME_ENABLED = <strong>{runtimeState.runtimeOn ? '1' : '0'}</strong>
                                </div>
                                <div>
                                    Чтобы перевести AI на ответы из ядра: установите{' '}
                                    <code className="bg-white px-1 rounded border border-[#E8E8E8]">AI_KNOWLEDGE_RUNTIME_ENABLED=1</code>{' '}
                                    в .env и перезапустите CRM.
                                </div>
                            </div>
                        </details>
                    </div>

                    <div className="px-6 py-3 border-t border-[#F0F0F0] flex items-center justify-between gap-2">
                        <a
                            href="/settings/integrations/ai-knowledge-help"
                            target="_blank"
                            rel="noopener"
                            className="text-[12px] text-[#3390EC] hover:underline"
                        >
                            Открыть инструкцию →
                        </a>
                        <button
                            onClick={() => setRolloutOpen(false)}
                            className="h-9 px-4 rounded-md bg-[#3390EC] text-white text-[13px] font-medium hover:opacity-90"
                        >
                            Понятно
                        </button>
                    </div>
                </div>
            </div>
        )
    }

    function Stat({ label, value }: { label: string; value: number }) {
        return (
            <div className="rounded-md border border-[#E8E8E8] bg-white px-3 py-2">
                <div className="text-[10px] text-gray-500 uppercase tracking-wide">{label}</div>
                <div className="text-[15px] font-semibold text-[#111]">{value}</div>
            </div>
        )
    }

    function humanizeAgo(iso: string | null): string {
        if (!iso) return 'нет данных'
        const ms = Date.now() - new Date(iso).getTime()
        const h = ms / 3600000
        if (h < 1)  return 'меньше часа назад'
        if (h < 2)  return '1 ч назад'
        if (h < 24) return `${Math.floor(h)} ч назад`
        const days = Math.floor(h / 24)
        const last = days % 10
        const tail =
            last === 1 && days % 100 !== 11 ? 'день' :
            last >= 2 && last <= 4 && (days % 100 < 10 || days % 100 >= 20) ? 'дня' : 'дней'
        return `${days} ${tail} назад`
    }

    // PR3.8: одна строка retrieval-трейса в "Активность ответов".
    const RetrievalTraceRow = ({ trace }: { trace: typeof retrievalTraces[number] }) => {
        const DECISION_TXT: Record<string, string> = {
            answer:       'ответ из ядра',
            escalate:     'передано менеджеру',
            no_knowledge: 'нет подходящих знаний',
        }
        const REASON_TXT: Record<string, string> = {
            conflict:        'конфликт знаний',
            requires_human:  'требует менеджера',
            low_confidence:  'низкая уверенность',
            no_relevant:     'нечего ответить',
            only_drafts:     'только черновики',
            ambiguous:       'неоднозначно',
            safety_block:    'сработал защитный фильтр',
        }
        const isShadow = trace.retrievalMode === 'shadow'
        const dec = trace.retrievalDecision ?? '—'
        const decColor =
            dec === 'answer'   ? 'text-green-600' :
            dec === 'escalate' ? 'text-amber-600' :
                                 'text-gray-500'
        const summary = trace.shadowRetrievalSummary
        return (
            <div className="py-2.5">
                <div className="flex items-baseline gap-2 flex-wrap">
                    <span className={`text-[12px] font-medium ${decColor}`}>
                        {DECISION_TXT[dec] ?? dec}
                    </span>
                    {trace.escalationReason && (
                        <span className="text-[10px] text-gray-400">
                            · {REASON_TXT[trace.escalationReason] ?? trace.escalationReason}
                        </span>
                    )}
                    {isShadow && (
                        <span className="text-[10px] text-amber-600"
                              title="Это наблюдение из тестового режима — ядро работало в фоне, водителю отвечала старая система.">
                            · тестовый режим
                        </span>
                    )}
                    {trace.channel && (
                        <span className="text-[10px] text-gray-400">
                            · {CHANNEL_LABELS[trace.channel] ?? trace.channel}
                        </span>
                    )}
                    <span className="text-[10px] text-gray-400 ml-auto">
                        {new Date(trace.createdAt).toLocaleString('ru')}
                    </span>
                </div>
                {summary && summary.candidateCount != null && (
                    <div className="text-[10px] text-gray-500 mt-0.5">
                        {summary.candidateCount} кандидатов
                        {summary.durationMs != null && ` · ${summary.durationMs} мс`}
                        {summary.topItemIds && summary.topItemIds.length > 0 && ` · top: ${summary.topItemIds.slice(0,3).join(', ')}`}
                    </div>
                )}
                {trace.knowledgeRuntimeVersion && (
                    <div className="text-[10px] text-gray-400 mt-0.5">
                        {trace.knowledgeRuntimeVersion}
                    </div>
                )}
            </div>
        )
    }

    const KnowledgeSourcesPanel = () => {
        const STATUS_LABEL: Record<string, string> = {
            queued: 'В очереди', running: 'Идёт сбор',
            completed: 'Завершено', partial: 'Завершено частично', failed: 'Ошибка',
        }
        const TIER_LABEL: Record<string, string> = {
            economy: 'Экономичная', balanced: 'Сбалансированная', quality: 'Повышенное качество',
        }
        // PR7.9: «Подключённые аккаунты» — список connections со
        // статистикой и кнопкой «Отключить». Для WA — реальный
        // disable. Для TG/MAX legacy items с connectionId=NULL —
        // отдельный honest блок «Старые записи без точной привязки».
        const STATUS_LABEL_LOCAL: Record<string, string> = {
            ready: 'подключён', qr: 'ждёт QR', authenticating: 'входит',
            idle: 'не активен', disconnected: 'отключён',
            inactive: 'отключён', unknown: '—',
        }
        // Group stats by connectionId for quick lookup.
        const statsByConnId = new Map<string, SourceStatsRow>()
        const orphanStats: SourceStatsRow[] = []
        for (const s of sourceStats) {
            if (s.connectionId) statsByConnId.set(s.connectionId, s)
            else orphanStats.push(s)
        }
        // Group connections by channel for rendering.
        const connsByChannel = new Map<string, ChannelConnection[]>()
        for (const c of channelConnections) {
            const arr = connsByChannel.get(c.channel) ?? []
            arr.push(c)
            connsByChannel.set(c.channel, arr)
        }

        return (
            <div className="border-t border-[#F0F0F0] pt-4 space-y-6">
                {/* PR7.12: Заглавный блок «Источники памяти AI» —
                    точка опоры для пользователя на этой sub-tab. */}
                <div className="rounded-lg border border-[#E4ECFC] bg-[#F8FBFF] px-3 py-2.5">
                    <div className="text-[13px] font-semibold text-[#111] mb-0.5">
                        Источники памяти AI
                    </div>
                    <p className="text-[12px] text-gray-600 leading-relaxed">
                        Источник — это аккаунт мессенджера, из переписок которого AI собирал знания.
                        Здесь видно, какие аккаунты подключены, что из них уже взято и как
                        отключить знания, если аккаунт оказался тестовым или больше не нужен.
                    </p>
                </div>

                {/* PR7.13 Block 1: Аккаунты и каналы — главный блок
                    источников. Раньше был «Подключённые аккаунты» —
                    переименовали, чтобы выделить, что это и есть
                    «откуда AI берёт память». */}
                <div>
                    <div className="text-[12px] font-semibold text-[#111] mb-1 flex items-center gap-2">
                        Аккаунты и каналы
                        <Hint text="Это все мессенджеры, которые когда-либо были подключены к CRM. AI собирает память из их переписок. Можно отключить знания одного WhatsApp-аккаунта — записи из него уйдут в архив (подтверждённые и ручные останутся с пометкой)." />
                    </div>
                    {channelConnections.length === 0 ? (
                        <div className="text-[12px] text-gray-400 px-3 py-3 rounded-lg border border-[#E8E8E8] bg-[#FAFBFC]">
                            Нет подключённых аккаунтов. Подключите WhatsApp / Telegram / MAX в разделе «Интеграции».
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {[...connsByChannel.entries()].map(([channel, conns]) => {
                                const CHANNEL_LABEL_LOCAL: Record<string, string> = {
                                    whatsapp: 'WhatsApp', telegram: 'Telegram', max: 'MAX',
                                }
                                return (
                                    <div key={channel} className="rounded-lg border border-[#E8E8E8] overflow-hidden">
                                        <div className="px-3 py-1.5 text-[11px] font-semibold text-gray-500 uppercase tracking-wide bg-[#FAFBFC] flex items-center justify-between">
                                            <span>{CHANNEL_LABEL_LOCAL[channel] ?? channel}</span>
                                            {/* PR8.B5: disclaimer «точечный disable в работе»
                                                удалён — теперь disable работает для всех каналов
                                                через Chat.metadata.connectionId. */}
                                        </div>
                                        {conns.map(conn => {
                                            const stat = statsByConnId.get(conn.id)
                                            const dotColor =
                                                conn.isReady ? 'bg-green-500' :
                                                conn.status === 'qr' || conn.status === 'authenticating' ? 'bg-amber-500' :
                                                'bg-gray-300'
                                            const itemsTouched = stat?.itemsTouched ?? 0
                                            const itemsActive  = stat?.itemsActive ?? 0
                                            const verified     = stat?.itemsVerified ?? 0
                                            const manual       = stat?.itemsManual ?? 0
                                            const sourcesActive = stat?.sourcesActive ?? 0
                                            // PR8.B3: disable теперь для всех каналов
                                            // (TG/MAX тоже после backfill через
                                            // Chat.metadata.connectionId).
                                            const canDisable = canEdit
                                                && itemsActive > 0
                                                && disableInFlight !== conn.id
                                            return (
                                                <div key={conn.id} className="border-t border-[#F0F0F0] first:border-t-0 px-3 py-2.5 flex items-start gap-3">
                                                    <div className="flex-1 min-w-0">
                                                        <div className="flex items-center gap-2 flex-wrap">
                                                            <span className="text-[13px] font-medium text-[#111]">
                                                                {conn.label.replace(/^(WhatsApp|Telegram|MAX) /, '')}
                                                            </span>
                                                            <span className="inline-flex items-center gap-1 text-[10px] text-gray-500">
                                                                <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
                                                                {STATUS_LABEL_LOCAL[conn.status] ?? conn.status}
                                                            </span>
                                                        </div>
                                                        <div className="text-[11px] text-gray-500 mt-0.5 flex flex-wrap gap-x-3">
                                                            {itemsTouched > 0 ? (
                                                                <>
                                                                    <span>{itemsActive} активных знаний</span>
                                                                    {verified > 0 && <span>· {verified} проверено</span>}
                                                                    {manual > 0 && <span>· {manual} вручную</span>}
                                                                    <span className="text-gray-400">· {sourcesActive} активных источников</span>
                                                                </>
                                                            ) : (
                                                                <span className="text-gray-400">из этого аккаунта пока ничего не собрано</span>
                                                            )}
                                                        </div>
                                                    </div>
                                                    {canDisable ? (
                                                        <button
                                                            type="button"
                                                            onClick={() => handleDisableSource(conn, stat)}
                                                            disabled={disableInFlight !== null}
                                                            title="Записи из этого аккаунта уйдут в архив. Подтверждённые и ручные сохранятся с пометкой «Источники отключены». Обратимо."
                                                            className="h-[28px] px-2.5 text-[11px] font-medium text-red-700 border border-red-200 rounded-md hover:bg-red-50 disabled:opacity-50 transition-colors shrink-0"
                                                        >
                                                            {disableInFlight === conn.id
                                                                ? <Loader2 size={11} className="animate-spin inline" />
                                                                : 'Отключить знания'}
                                                        </button>
                                                    ) : null}
                                                </div>
                                            )
                                        })}
                                    </div>
                                )
                            })}
                        </div>
                    )}
                </div>

                {/* PR7.13 Block 2: Последние сборы ядра. Раньше
                    был «Сбор ядра из истории» — переименовали,
                    чтобы было понятнее, что это история сборов. */}
                <div>
                    <div className="text-[12px] font-semibold text-[#111] mb-1">
                        Последние сборы ядра
                    </div>
                {extractionJobs.length === 0 ? (
                    <div className="text-center py-12 text-[12px] text-gray-400">
                        <div className="font-medium text-[#111] text-[13px] mb-1">Извлечения ещё не запускались</div>
                        Когда вы запустите «Собрать ядро», здесь появятся отчёты:<br />
                        сколько диалогов проанализировано, сколько новых знаний добавлено.
                    </div>
                ) : (
                    <div className="divide-y divide-[#F0F0F0]">
                        {extractionJobs.map((rawJob, idx) => {
                            const j = rawJob as ExtractionJobLite & {
                                createdAt?: string
                                scope?: { mode?: string }
                            }
                            const p = j.progress ?? {}
                            return (
                                <div key={j.id ?? idx} className="py-3">
                                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                                        <StatusDot status={j.status} />
                                        <span className="text-[13px] font-medium text-[#111]">
                                            {STATUS_LABEL[j.status] ?? j.status}
                                        </span>
                                        {j.scope?.mode && (() => {
                                            // PR7.12: убрали «scope: <mode>» — это
                                            // внутренний термин. Подменяем human label.
                                            const SCOPE_HUMAN: Record<string, string> = {
                                                last_30d: 'за 30 дней',
                                                last_90d: 'за 90 дней',
                                                all:      'вся доступная история',
                                            }
                                            const lbl = SCOPE_HUMAN[j.scope!.mode!] ?? j.scope!.mode!
                                            return (
                                                <span className="text-[11px] text-gray-400">· {lbl}</span>
                                            )
                                        })()}
                                        {j.extractionQualityTier && (
                                            <span className="text-[11px] text-gray-400">
                                                · {TIER_LABEL[j.extractionQualityTier] ?? j.extractionQualityTier}
                                            </span>
                                        )}
                                        {j.createdAt && (
                                            <span className="text-[11px] text-gray-400 ml-auto">
                                                {new Date(j.createdAt).toLocaleString('ru')}
                                            </span>
                                        )}
                                    </div>
                                    {j.errorMessage && (
                                        <p className="text-[11px] text-red-600 mb-1">{j.errorMessage}</p>
                                    )}
                                    {/* PR8.D: явный алерт о массовых LLM-ошибках.
                                        Если pairsBuilt > 0 но itemsCreated == 0 и
                                        llmErrors > 0 — extraction провалился по
                                        AI-провайдеру, а не по данным. Пользователь
                                        иначе видит «completed» зелёненький, но
                                        в ядре пусто. */}
                                    {(() => {
                                        const p = j.progress ?? {} as Record<string, unknown>
                                        const llmErrors = typeof p.llmErrors === 'number' ? p.llmErrors : 0
                                        const llmCalls  = typeof p.llmCalls === 'number' ? p.llmCalls : 0
                                        const itemsCreated = typeof p.itemsCreated === 'number' ? p.itemsCreated : 0
                                        if (llmErrors === 0 || llmCalls === 0) return null
                                        const allFailed = llmErrors === llmCalls && itemsCreated === 0
                                        return (
                                            <div className="rounded-md border border-red-200 bg-red-50 px-2.5 py-2 mb-1 text-[11px] text-red-700 leading-relaxed">
                                                <div className="font-semibold">
                                                    {allFailed
                                                        ? `Сбор не удался: все ${llmCalls} запросов к AI завершились ошибкой`
                                                        : `Часть запросов к AI завершилась ошибкой: ${llmErrors} из ${llmCalls}`}
                                                </div>
                                                <div className="text-[10px] text-red-600 mt-0.5">
                                                    Проверьте API-ключ AI Провайдера и доступность модели{' '}
                                                    ({j.extractionProvider}/{j.extractionModel}) — частые причины:
                                                    неверный ключ, исчерпан баланс, rate limit, сетевая ошибка.
                                                </div>
                                            </div>
                                        )
                                    })()}
                                    {/* PR7.6: scope source info — из каких аккаунтов
                                        собирали ядро. Если scope.connectionIds
                                        задан — показываем list labels из
                                        channelConnections, иначе «все ready
                                        аккаунты». Для transparency PR4
                                        explainability. */}
                                    {(() => {
                                        const scopeAny = (j.scope ?? {}) as Record<string, unknown>
                                        const ids = Array.isArray(scopeAny.connectionIds) ? scopeAny.connectionIds as string[] : null
                                        if (!ids || ids.length === 0) return null
                                        const labels = ids
                                            .map(id => channelConnections.find(c => c.id === id)?.label)
                                            .filter(Boolean) as string[]
                                        if (labels.length === 0) {
                                            return (
                                                <p className="text-[11px] text-gray-400 mb-1">
                                                    Собрано из {ids.length} {ids.length === 1 ? 'аккаунта' : 'аккаунтов'} (имена недоступны — возможно подключение удалили)
                                                </p>
                                            )
                                        }
                                        return (
                                            <p className="text-[11px] text-gray-500 mb-1">
                                                Собрано из: <b className="text-gray-700">{labels.join(', ')}</b>
                                            </p>
                                        )
                                    })()}
                                    {Object.keys(p).length > 0 && (
                                        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-gray-500">
                                            {p.pairsBuilt != null && <span>{p.pairsBuilt} пар</span>}
                                            {p.itemsCreated != null && <span>· {p.itemsCreated} новых знаний</span>}
                                            {p.itemsMerged != null && p.itemsMerged > 0 && <span>· {p.itemsMerged} объединено</span>}
                                            {p.itemsAsDraft != null && p.itemsAsDraft > 0 && <span>· {p.itemsAsDraft} черновиков</span>}
                                            {p.conflictsDetected != null && p.conflictsDetected > 0 && (
                                                <span className="text-amber-600">· {p.conflictsDetected} конфликтов</span>
                                            )}
                                            {/* PR6.1: Trusted Knowledge Guard counters. Видимы
                                                только если защитный слой реально что-то отловил.
                                                Зелёное "подтверждает" — позитивный сигнал что
                                                менеджеры говорят по правилам. Красное
                                                "противоречит" — сигнал к admin-review. */}
                                            {p.trustedConflictsBlocked != null && p.trustedConflictsBlocked > 0 && (
                                                <span title="Менеджеры в чатах сказали что-то, что противоречит подтверждённым правилам компании. Эти записи заблокированы и не попали в активное ядро — но видны для проверки в фильтре «Черновики» / «Без подтверждения»."
                                                      className="text-red-600 cursor-help">
                                                    · {p.trustedConflictsBlocked} противоречит правилам — заблокировано
                                                </span>
                                            )}
                                            {p.trustedMatchesBoosted != null && p.trustedMatchesBoosted > 0 && (
                                                <span title="Менеджеры в чатах подтверждают уже проверенные правила компании. Хороший сигнал — официальная линия совпадает с тем, что менеджеры реально говорят водителям."
                                                      className="text-green-700 cursor-help">
                                                    · {p.trustedMatchesBoosted} подтверждает проверенные правила
                                                </span>
                                            )}
                                            {p.llmErrors != null && p.llmErrors > 0 && (
                                                <span className="text-red-600">· {p.llmErrors} ошибок LLM</span>
                                            )}
                                        </div>
                                    )}
                                    {(j.extractionProvider || j.extractionModel) && (
                                        <p className="text-[10px] text-gray-400 mt-1">
                                            модель: {j.extractionProvider}/{j.extractionModel}
                                            {j.extractionPromptVersion && ` · prompt ${j.extractionPromptVersion}`}
                                        </p>
                                    )}
                                </div>
                            )
                        })}
                    </div>
                )}
                </div>

                {/* PR7.13 Block 3: Неизвестные источники. Раньше
                    жил как маленький orphan-блок внутри «Аккаунты и
                    каналы» — теперь выделен в самостоятельный блок
                    с явным заголовком и пояснением, как просил
                    пользователь в спеке. */}
                {orphanStats.length > 0 && (
                    <div>
                        <div className="text-[12px] font-semibold text-[#111] mb-1">
                            Неизвестные источники
                        </div>
                        <div className="rounded-lg border border-[#FFE8B0] bg-[#FFFBED] px-3 py-2.5 text-[12px] text-[#8B6914] space-y-1.5">
                            <div className="leading-relaxed">
                                Есть знания без точной привязки к аккаунту.
                                Они были собраны до того, как система начала сохранять точный аккаунт.
                                Их можно проверить вручную или архивировать.
                            </div>
                            {orphanStats.map(s => {
                                const CHANNEL_LABEL_LOCAL: Record<string, string> = {
                                    whatsapp: 'WhatsApp', telegram: 'Telegram', max: 'MAX',
                                }
                                return (
                                    <div key={s.channel} className="text-[11px]">
                                        <b>{CHANNEL_LABEL_LOCAL[s.channel] ?? s.channel}:</b>{' '}
                                        {s.itemsActive} активных знаний из {s.itemsTouched} затронутых,{' '}
                                        {s.sourcesActive} активных источников.
                                    </div>
                                )
                            })}
                            <div className="text-[11px] leading-relaxed">
                                После PR8 для новых сборов точная привязка работает для всех каналов.
                                Эти записи остались из старых сборов до сохранения провенанс.
                            </div>
                        </div>
                    </div>
                )}

                {/* PR7.13 Block 4: Активность ответов (PR3 shadow/runtime) */}
                <div>
                    <div className="flex items-baseline gap-2 mb-2">
                        <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">
                            Активность ответов
                        </span>
                        <RuntimeModePill state={runtimeState} />
                    </div>
                    {retrievalTraces.length === 0 ? (
                        <div className="text-center py-6 text-[12px] text-gray-400">
                            {runtimeState.mode === 'legacy' ? (
                                <>
                                    Knowledge Core ещё не подключён к ответам AI.<br />
                                    Включается через env-флаги (см. описание ниже).
                                </>
                            ) : (
                                <>Пока нет ответов через ядро. Записи появятся при обработке входящих сообщений.</>
                            )}
                        </div>
                    ) : (
                        <div className="divide-y divide-[#F0F0F0]">
                            {retrievalTraces.slice(0, 20).map(t => (
                                <RetrievalTraceRow key={t.id} trace={t} />
                            ))}
                        </div>
                    )}
                    <div className="mt-3 text-[10px] text-gray-400 leading-relaxed">
                        <strong>Тестовый режим</strong> — новое ядро работает в фоне,
                        чтобы можно было посмотреть какие ответы оно бы давало.
                        Водителям отвечает старая система — никаких рисков.{' '}
                        <strong>Активный режим</strong> — AI начинает отвечать
                        водителям из ядра. Включается разработчиком только когда
                        ядро готово (см. <button
                            type="button"
                            onClick={() => setRolloutOpen(true)}
                            className="text-[#3390EC] hover:underline"
                        >проверка готовности</button>).{' '}
                        <a
                            href="/settings/integrations/ai-knowledge-help#a-shadow"
                            target="_blank"
                            rel="noopener"
                            className="text-[#3390EC] hover:underline"
                        >Подробнее
                        </a>
                    </div>
                </div>

                {/* PR7.13: Опасная зона удалена отсюда — кнопка
                    «Очистить и собрать заново» теперь в Current Core
                    Passport сверху как primary action. Чтобы не
                    дублировать одно и то же действие в двух местах. */}
            </div>
        )
    }

    // PR7.9: Reset modal — три варианта soft-archive, no default,
    // typed confirm для full. Доступен только Admin/Lead через
    // openResetModal() из «Источники» panel.
    const ResetCoreModal = () => {
        if (!resetModalOpen) return null
        const runtimeOn = runtimeState.runtimeOn
        const submitDisabled = resetRunning
            || !resetMode
            || (resetMode === 'full' && resetTypedConfirm !== 'ОЧИСТИТЬ')

        const MODES: Array<{
            value: ResetMode; title: string; body: string; tone: 'normal' | 'caution' | 'danger'
        }> = [
            {
                value: 'auto_only',
                title: 'Только автоматически собранные',
                body:  'Уйдут в архив записи, которые AI собрал из переписок и которые ещё не подтверждены. Подтверждённые правила и записи, добавленные вручную (включая перенесённые из старой базы), сохранятся.',
                tone:  'normal',
            },
            {
                value: 'unverified',
                title: 'Всё, что не подтверждено',
                body:  'Уйдут в архив все знания, кроме тех, что админ лично подтвердил. Ручные записи без подтверждения тоже архивируются.',
                tone:  'caution',
            },
            {
                value: 'full',
                title: 'Полностью очистить ядро',
                body:  'В архив уйдут ВСЕ активные знания, включая подтверждённые и ручные. Понадобится подтверждение текстом.',
                tone:  'danger',
            },
        ]

        return (
            <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-16"
                 onClick={closeResetModal}>
                <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl flex flex-col max-h-[85vh] overflow-hidden"
                     onClick={e => e.stopPropagation()}>
                    <div className="px-6 py-4 border-b border-[#F0F0F0] flex items-center justify-between">
                        <div>
                            <h2 className="text-[16px] font-semibold text-[#111]">Очистить ядро знаний</h2>
                            <p className="text-[12px] text-gray-500 mt-0.5">
                                Мягкое архивирование — данные не удаляются. Восстановление — через карточку знания в разделе «Архив».
                            </p>
                        </div>
                        <button onClick={closeResetModal} disabled={resetRunning}
                                className="text-gray-400 hover:text-[#111] text-[20px] leading-none disabled:opacity-50"
                                aria-label="Закрыть">×</button>
                    </div>

                    <div className="px-6 py-4 overflow-y-auto space-y-4">
                        {resetResult ? (
                            <>
                                <div className="rounded-md border border-green-200 bg-green-50 p-3 text-[13px] text-green-900 space-y-1">
                                    <div className="font-semibold">Ядро очищено</div>
                                    <div>В архив: <b>{resetResult.archivedCount}</b> ·{' '}
                                         Сохранено: <b>{resetResult.keptCount}</b></div>
                                </div>
                                {/* PR7.10: explicit Rebuild CTA — не просто
                                    "закройте и нажмите Собрать ядро в шапке",
                                    а конкретное действие здесь и сейчас.
                                    Закрывает Reset modal, открывает
                                    Extraction modal с preserved scope/tier
                                    из последнего запуска (или default).
                                    Восстановить отдельные знания всё ещё
                                    можно через «Архив». */}
                                <div className="rounded-md border border-[#3390EC]/30 bg-[#F0F4FA] p-3 space-y-2">
                                    <div className="text-[13px] font-semibold text-[#111]">
                                        Собрать ядро заново
                                    </div>
                                    <p className="text-[12px] text-gray-600 leading-relaxed">
                                        Теперь можно проанализировать переписки и собрать обновлённое ядро.{' '}
                                        Выбор аккаунтов сохранится — можно скорректировать перед запуском.
                                    </p>
                                    {/* PR7.12: preview итогового scope —
                                        пользователь видит «откуда» ещё до
                                        открытия Extraction modal. Также
                                        блок «Не участвуют» — какие
                                        аккаунты сейчас не попадут и почему. */}
                                    {(() => {
                                        const willInclude = channelConnections.filter(c =>
                                            selectedConnectionIds.has(c.id) && (!onlyConnectedNow || c.isReady)
                                        )
                                        // Не участвуют: либо не отмечен, либо
                                        // отмечен но не ready при включённом
                                        // onlyConnectedNow filter.
                                        const willNotInclude = channelConnections.filter(c =>
                                            !willInclude.some(w => w.id === c.id)
                                        )
                                        // Источник отключённый администратором —
                                        // sourceStats.sourcesActive === 0 при
                                        // sourcesTotal > 0.
                                        const disabledByAdmin = new Set(sourceStats
                                            .filter(s => s.connectionId && s.sourcesTotal > 0 && s.sourcesActive === 0)
                                            .map(s => s.connectionId!) as string[])
                                        const reasonFor = (c: ChannelConnection): string => {
                                            if (disabledByAdmin.has(c.id)) return 'источник отключён администратором'
                                            if (!c.isReady && onlyConnectedNow) {
                                                if (c.status === 'qr' || c.status === 'authenticating') return 'ждёт QR'
                                                return 'не активен'
                                            }
                                            if (!selectedConnectionIds.has(c.id)) return 'не отмечен'
                                            return ''
                                        }
                                        if (willInclude.length === 0 && willNotInclude.length === 0) {
                                            return (
                                                <div className="text-[11px] text-gray-500">
                                                    Сейчас не выбрано ни одного аккаунта — сбор пройдёт только по уже загруженной истории.
                                                </div>
                                            )
                                        }
                                        return (
                                            <div className="text-[11px] text-gray-600 space-y-1.5">
                                                {willInclude.length > 0 && (
                                                    <div className="space-y-0.5">
                                                        <div className="text-gray-500">Будет участвовать:</div>
                                                        {willInclude.slice(0, 5).map(c => (
                                                            <div key={c.id}>· {c.label}</div>
                                                        ))}
                                                        {willInclude.length > 5 && (
                                                            <div className="text-gray-400">и ещё {willInclude.length - 5}</div>
                                                        )}
                                                    </div>
                                                )}
                                                {willNotInclude.length > 0 && (
                                                    <div className="space-y-0.5 pt-1">
                                                        <div className="text-gray-500">Не участвуют:</div>
                                                        {willNotInclude.slice(0, 5).map(c => {
                                                            const reason = reasonFor(c)
                                                            return (
                                                                <div key={c.id} className="text-gray-500">
                                                                    · {c.label}
                                                                    {reason && <span className="text-gray-400"> — {reason}</span>}
                                                                </div>
                                                            )
                                                        })}
                                                        {willNotInclude.length > 5 && (
                                                            <div className="text-gray-400">и ещё {willNotInclude.length - 5}</div>
                                                        )}
                                                        <div className="text-gray-400 pt-0.5">
                                                            Можно скорректировать в модале сбора.
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        )
                                    })()}
                                    <div className="pt-1">
                                        <button
                                            type="button"
                                            onClick={() => {
                                                closeResetModal()
                                                openExtractionModal()
                                            }}
                                            className="h-9 px-4 inline-flex items-center gap-1.5 rounded-md bg-[#3390EC] text-white text-[13px] font-semibold hover:bg-[#2B7FD4]"
                                        >
                                            <Sparkles size={13} />
                                            Собрать заново
                                        </button>
                                        {/* PR7.13: «Открыть архив» — второй
                                            путь после reset для тех, кто
                                            хочет проверить что было
                                            заархивировано до повторного
                                            сбора. */}
                                        <button
                                            type="button"
                                            onClick={() => {
                                                closeResetModal()
                                                setKnowledgeSubtab('archive')
                                            }}
                                            className="h-9 px-3 inline-flex items-center gap-1.5 rounded-md border border-[#E0E0E0] text-[13px] font-semibold text-gray-700 hover:bg-[#F0F4FA] hover:text-[#3390EC]"
                                        >
                                            Открыть архив
                                        </button>
                                    </div>
                                    <p className="text-[11px] text-gray-500 leading-relaxed pt-1">
                                        Восстановить отдельные знания из архива можно в разделе «Архив» в любой момент.
                                    </p>
                                </div>
                            </>
                        ) : (
                            <>
                                {runtimeOn && (
                                    /* PR7.13: strong warning при runtime — было
                                       спокойное «лучше отложить», теперь явный
                                       красный alert с прямой рекомендацией
                                       выключить runtime сначала. */
                                    <div className="rounded-md border-2 border-red-300 bg-red-50 p-3 text-[12px] text-red-900 leading-relaxed">
                                        <strong className="block mb-1 text-[13px]">⚠ AI сейчас может отвечать из ядра</strong>
                                        <p>
                                            После очистки ответы клиентам изменятся — AI будет отдавать пустые или неполные ответы, пока ядро не пересобрано.{' '}
                                            <strong>Рекомендуется сначала выключить активный режим</strong> (через переменную окружения AI_KNOWLEDGE_RUNTIME_ENABLED=0 + перезапуск сервера).
                                        </p>
                                    </div>
                                )}

                                <div className="text-[11px] uppercase tracking-wide text-gray-500">Что архивировать</div>
                                <div className="flex flex-col gap-2">
                                    {MODES.map(m => {
                                        const selected = resetMode === m.value
                                        const borderActive =
                                            m.tone === 'danger' ? 'border-red-300 bg-red-50/40' :
                                            m.tone === 'caution' ? 'border-amber-300 bg-amber-50/40' :
                                            'border-[#3390EC] bg-[#F0F4FA]'
                                        return (
                                            <label key={m.value}
                                                className={`flex items-start gap-2 px-3 py-2.5 rounded-lg cursor-pointer border transition-colors ${
                                                    selected ? borderActive : 'border-[#E8E8E8] hover:border-[#C8C8C8]'
                                                }`}>
                                                <input type="radio" name="reset-mode" className="mt-0.5"
                                                    checked={selected}
                                                    onChange={() => setResetMode(m.value)} />
                                                <div className="flex-1 min-w-0">
                                                    <div className="text-[13px] font-medium text-[#111]">{m.title}</div>
                                                    <p className="text-[12px] text-gray-600 mt-0.5 leading-relaxed">{m.body}</p>
                                                </div>
                                            </label>
                                        )
                                    })}
                                </div>

                                {resetMode === 'full' && (
                                    <div className="rounded-md border border-red-300 bg-red-50 p-3 space-y-2">
                                        <div className="text-[12px] text-red-800">
                                            Чтобы подтвердить полную очистку, введите слово <b>ОЧИСТИТЬ</b> заглавными буквами:
                                        </div>
                                        <input
                                            type="text"
                                            value={resetTypedConfirm}
                                            onChange={e => setResetTypedConfirm(e.target.value)}
                                            placeholder="ОЧИСТИТЬ"
                                            className="w-full h-[34px] border border-red-200 rounded-md px-3 text-[13px] outline-none focus:border-red-400 bg-white"
                                            autoFocus
                                        />
                                    </div>
                                )}
                            </>
                        )}
                    </div>

                    <div className="px-6 py-3 border-t border-[#F0F0F0] flex items-center justify-end gap-2">
                        <button
                            onClick={closeResetModal}
                            disabled={resetRunning}
                            className="h-9 px-4 rounded-md border border-[#E0E0E0] text-[13px] text-gray-600 hover:bg-[#F8F9FA] disabled:opacity-50"
                        >
                            {resetResult ? 'Закрыть' : 'Отмена'}
                        </button>
                        {!resetResult && (
                            <button
                                onClick={handleResetCore}
                                disabled={submitDisabled}
                                className={`h-9 px-4 rounded-md text-white text-[13px] font-medium disabled:opacity-50 inline-flex items-center gap-1.5 ${
                                    resetMode === 'full' ? 'bg-red-600 hover:bg-red-700' : 'bg-[#3390EC] hover:opacity-90'
                                }`}
                            >
                                {resetRunning && <Loader2 size={13} className="animate-spin" />}
                                {resetMode === 'full' ? 'Очистить полностью' : 'Архивировать'}
                            </button>
                        )}
                    </div>
                </div>
            </div>
        )
    }

    const KnowledgeTab = () => {
        const selectedSection = sections.find(s => s.id === selectedSectionId) ?? null

        // ─── PR7.13: Current Core Passport ─────────────────────────
        //
        // Главный блок вкладки. До PR7.13 пользователь видел только
        // technical readiness row и stats line — не было «паспорта»
        // current core. Теперь сверху — единый блок со статусом,
        // sources participation, last update summary, counters и
        // основными actions (включая reset). Reset больше не спрятан
        // внизу sources panel — он primary action.
        const coreEmpty = readiness.counts.activeItems === 0
        const lastExtr = readiness.lastExtraction
        const noKey = !config.apiKeyEncrypted || (config.apiKeyEncrypted as string).trim() === ''
        const extractionRunning = activeExtractionJob &&
            (activeExtractionJob.status === 'queued' || activeExtractionJob.status === 'running')

        // Status config — берётся из runtimeState. Совпадает с
        // RuntimeModePill, но в passport отрисовывается крупнее.
        const STATUS_CFG: Record<string, {
            dot: string; label: string; bg: string; txt: string; desc: string
        }> = {
            legacy: {
                dot:   '⚪', label: 'Старая система',
                bg:    'bg-gray-100', txt: 'text-gray-700',
                desc:  'AI пока отвечает по старой базе FAQ. Новое ядро ещё не подключено к ответам.',
            },
            shadow: {
                dot:   '🟡', label: 'Тестовый режим',
                bg:    'bg-amber-100', txt: 'text-amber-700',
                desc:  'Новое ядро работает в фоне для наблюдения. Клиентам пока отвечает старая система — никаких рисков.',
            },
            runtime: {
                dot:   '🟢', label: 'AI отвечает из ядра',
                bg:    'bg-green-100', txt: 'text-green-700',
                desc:  'Новое ядро активно: AI отвечает клиентам из собранной памяти.',
            },
        }
        const statusCfg = STATUS_CFG[runtimeState.mode] ?? STATUS_CFG.legacy

        // Participating connections: те, у которых есть активные
        // sources в текущем ядре. Раньше эта инфа была разбросана —
        // sourceStats показывалась только в Sources sub-tab.
        const CHANNEL_LABEL_LOCAL: Record<string, string> = {
            whatsapp: 'WhatsApp', telegram: 'Telegram', max: 'MAX',
        }
        const STATUS_LABEL_LOCAL: Record<string, string> = {
            ready: 'подключён', qr: 'ждёт QR', authenticating: 'входит',
            idle: 'не активен', disconnected: 'отключён',
            inactive: 'отключён', unknown: '—',
        }
        const participatingByChannel = new Map<string, Array<{
            conn: ChannelConnection; stat: SourceStatsRow | undefined; participated: boolean
        }>>()
        for (const conn of channelConnections) {
            const stat = sourceStats.find(s => s.connectionId === conn.id)
            const participated = !!stat && stat.sourcesActive > 0
            const arr = participatingByChannel.get(conn.channel) ?? []
            arr.push({ conn, stat, participated })
            participatingByChannel.set(conn.channel, arr)
        }
        // PR7.16.2: channel-level entries для TG/MAX источников
        // с connectionId=NULL. Schema пока не хранит точечную
        // привязку chat→connection для TG/MAX, поэтому в
        // AiKnowledgeSource они идут с NULL. Без этого блока
        // пользователь не видит что TG/MAX «участвовали» в ядре
        // — он видит только WA-аккаунты. Channel-level entries
        // покрывают этот пробел honest-way: «канал участвовал,
        // точечный аккаунт не сохранён».
        const channelLevelParticipation = sourceStats
            .filter(s => s.connectionId === null && s.sourcesActive > 0)
            .map(s => ({ channel: s.channel, stat: s }))

        // Last extraction progress — pull человеческие counts из
        // progress JSON блоба (без типизации со стороны readiness).
        const lastExtrProgress = (lastExtr?.progress ?? {}) as Record<string, unknown>
        const pn = (k: string) => {
            const v = lastExtrProgress[k]
            return typeof v === 'number' ? v : null
        }
        // PR8.D: детект полного провала last extraction по AI-провайдеру.
        // Если llmErrors == llmCalls > 0 и itemsCreated == 0 — все
        // запросы упали, ядро не собралось из-за provider настроек.
        const lastExtrAllFailed =
            !!lastExtr
            && (pn('llmCalls') ?? 0) > 0
            && (pn('llmErrors') ?? 0) === (pn('llmCalls') ?? 0)
            && (pn('itemsCreated') ?? 0) === 0

        // PR8.D: сообщения «доступные для анализа» для empty-state
        // из реальной БД (connectionCounts), а не из importJobs.
        // Это покрывает live-streamed MAX/TG которые не имеют
        // HistoryImportJob записей.
        const importsByConnection = new Map<string, number>()
        for (const c of connectionCounts) {
            importsByConnection.set(c.connectionId, c.messages)
        }

        return (
            <>
            <div className="space-y-4">
                <InlineInfo>
                    Ядро знаний — структурированная память AI: тарифы, требования,
                    условия, документы, частые вопросы. AI отвечает фактами из ядра,
                    а стиль берёт из «Правил».{' '}
                    <a
                        href="/settings/integrations/ai-knowledge-help"
                        target="_blank"
                        rel="noopener"
                        className="text-[#3390EC] hover:underline"
                    >
                        Подробнее в инструкции →
                    </a>
                </InlineInfo>

                {/* PR7.13: Current Core Passport — главный блок-паспорт */}
                <section className="rounded-lg border border-[#E4ECFC] bg-[#F8FBFF] p-4 space-y-3">
                    {/* Header: title + status */}
                    <header className="flex items-start justify-between gap-3 flex-wrap">
                        <div className="min-w-0">
                            <h2 className="text-[15px] font-semibold text-[#111]">Текущее ядро AI</h2>
                            <p className="text-[12px] text-gray-600 leading-relaxed mt-0.5 max-w-2xl">
                                Это память AI: тарифы, условия, документы, частые вопросы и ограничения.
                                AI использует эти знания, когда отвечает клиентам.
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={() => setRolloutOpen(true)}
                            title={statusCfg.desc + ' Нажмите для проверки готовности.'}
                            className={`shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium hover:opacity-80 transition-opacity ${statusCfg.bg} ${statusCfg.txt}`}
                        >
                            <span>{statusCfg.dot}</span>
                            <span>{statusCfg.label}</span>
                        </button>
                    </header>

                    {/* PR8.D: prominent alert если последний сбор полностью
                        провалился по AI-провайдеру. Показываем ВСЕГДА (не
                        только в empty-state), потому что пользователь должен
                        видеть это первым, а не разглядывать stats. */}
                    {lastExtrAllFailed && (
                        <div className="rounded-md border-2 border-red-300 bg-red-50 px-3 py-2.5 text-[12px] text-red-900 leading-relaxed">
                            <div className="font-semibold text-[13px] mb-1">
                                ⚠ Последний сбор не удался — AI Провайдер не отвечает
                            </div>
                            <p>
                                Все {pn('llmCalls')} запросов к AI завершились ошибкой. Ядро не собралось.
                                Проверьте на вкладке <strong>AI Провайдер</strong> — нажмите «Проверить»,
                                чтобы убедиться что API-ключ действителен и модель доступна.
                                Частые причины: неверный ключ, исчерпан баланс, rate limit.
                            </p>
                        </div>
                    )}
                    {coreEmpty ? (
                        /* PR7.13: empty state — «Ядро ещё не собрано» */
                        <div className="rounded-md border border-[#E0E8F4] bg-white px-4 py-4 space-y-3">
                            <div>
                                <h3 className="text-[14px] font-semibold text-[#111]">Ядро ещё не собрано</h3>
                                <p className="text-[12px] text-gray-600 leading-relaxed mt-1">
                                    AI пока не собрал память компании. Сначала выберите источники — WhatsApp,
                                    Telegram или MAX. Затем AI прочитает историю переписок и соберёт знания:
                                    тарифы, документы, ограничения и частые вопросы.
                                </p>
                            </div>
                            {channelConnections.length > 0 && (
                                <div className="text-[11px] text-gray-600 space-y-0.5">
                                    <div className="text-gray-500 font-medium">Сейчас доступно для анализа:</div>
                                    {channelConnections.slice(0, 6).map(conn => {
                                        const msgs = importsByConnection.get(conn.id) ?? 0
                                        return (
                                            <div key={conn.id} className="flex flex-wrap items-center gap-1.5">
                                                <span>· {conn.label}</span>
                                                <span className="text-gray-400">
                                                    {msgs > 0 ? `${msgs.toLocaleString('ru')} сообщений` : 'нет истории'}
                                                </span>
                                            </div>
                                        )
                                    })}
                                </div>
                            )}
                        </div>
                    ) : (
                        /* PR7.13: «Собрано из» + «Последнее обновление» — 2 column layout */
                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                            {/* «Собрано из» */}
                            <div className="rounded-md border border-[#E0E8F4] bg-white px-3 py-2.5">
                                <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
                                    Собрано из
                                </div>
                                {participatingByChannel.size === 0 && channelLevelParticipation.length === 0 ? (
                                    <div className="text-[12px] text-gray-500">
                                        Источники недоступны. Нужно подключить мессенджер.
                                    </div>
                                ) : (
                                    <div className="space-y-1.5">
                                        {/* PR7.16.2 + PR9.2: показываем каналы в стабильном порядке.
                                            Сначала per-account entries (WA + TG + MAX через
                                            metadata), потом — channel-level orphan ТОЛЬКО когда
                                            у канала вообще нет per-account participated entries.
                                            Это убирает дубль типа «TG +79221853150 · участвовал»
                                            И «канал участвовал · 15 источников» рядом. */}
                                        {(['whatsapp', 'telegram', 'max'] as const).map(channel => {
                                            const conns = participatingByChannel.get(channel) ?? []
                                            const channelLevel = channelLevelParticipation.find(p => p.channel === channel)
                                            const anyPerAccountParticipated = conns.some(c => c.participated)
                                            // Channel-level orphan показываем ТОЛЬКО когда нет
                                            // per-account participated. Если есть — orphan-данные
                                            // это legacy, они уже косвенно отражены в общем числе
                                            // знаний; отдельную строку убираем.
                                            const showChannelLevel = !!channelLevel && !anyPerAccountParticipated
                                            const hasParticipated = anyPerAccountParticipated || showChannelLevel
                                            if (!hasParticipated && conns.length === 0) return null
                                            return (
                                                <div key={channel} className="text-[12px]">
                                                    <div className="font-medium text-[#111]">
                                                        {CHANNEL_LABEL_LOCAL[channel] ?? channel}
                                                    </div>
                                                    {/* Per-account rows */}
                                                    {conns.slice(0, 4).map(({ conn, participated }) => {
                                                        const status = STATUS_LABEL_LOCAL[conn.status] ?? conn.status
                                                        return (
                                                            <div key={conn.id} className="text-[11px] text-gray-600 leading-snug pl-2">
                                                                — {conn.label.replace(/^(WhatsApp|Telegram|MAX) /, '')}
                                                                <span className="text-gray-400"> · {status}</span>
                                                                <span className={participated ? 'text-green-700' : 'text-gray-400'}>
                                                                    {' '}· {participated ? 'участвовал' : 'не участвовал'}
                                                                </span>
                                                            </div>
                                                        )
                                                    })}
                                                    {conns.length > 4 && (
                                                        <div className="text-[11px] text-gray-400 pl-2">
                                                            и ещё {conns.length - 4}
                                                        </div>
                                                    )}
                                                    {/* Channel-level orphan — ТОЛЬКО если нет
                                                        per-account participated. Honest wording:
                                                        это legacy данные, не относятся к
                                                        выбору пользователя в Шаге 2. */}
                                                    {showChannelLevel && (
                                                        <div className="text-[11px] text-gray-500 leading-snug pl-2">
                                                            — <span className="text-gray-500">из старых сборов:</span>
                                                            <span className="text-gray-400">
                                                                {' '}{channelLevel!.stat.sourcesActive} источников · аккаунт не сохранён
                                                            </span>
                                                        </div>
                                                    )}
                                                </div>
                                            )
                                        })}
                                        {/* PR9.2: honest disclaimer ТОЛЬКО когда есть orphan
                                            БЕЗ per-account конкурента у того же канала. Если
                                            пользователь видит TG +XXX · участвовал, ему не нужно
                                            знать про 15 legacy orphan'ов — они не относятся к
                                            его текущему выбору. */}
                                        {knowledgeStats.totalSources > 0 && readiness.counts.activeItems > 0 && (() => {
                                            // Показываем disclaimer только если есть orphan каналы
                                            // без participated per-account.
                                            const hasOrphanOnly = channelLevelParticipation.some(p => {
                                                const conns = participatingByChannel.get(p.channel) ?? []
                                                return !conns.some(c => c.participated)
                                            })
                                            if (!hasOrphanOnly) return null
                                            return (
                                                <div className="text-[11px] text-gray-400 pt-1.5 border-t border-[#F0F0F0] leading-relaxed">
                                                    Часть знаний из старых сборов без точной привязки к аккаунту —
                                                    это можно очистить через «Очистить ядро» (режим «Только авто-собранные»),
                                                    тогда новый сбор пересоберёт всё с точной привязкой.
                                                </div>
                                            )
                                        })()}
                                    </div>
                                )}
                            </div>

                            {/* «Последнее обновление» */}
                            <div className="rounded-md border border-[#E0E8F4] bg-white px-3 py-2.5">
                                <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
                                    Последнее обновление
                                </div>
                                {!lastExtr ? (
                                    <div className="text-[12px] text-gray-500">
                                        Сбор ещё не запускался.
                                    </div>
                                ) : (
                                    <div className="text-[12px] text-gray-600 space-y-1">
                                        <div>
                                            <b className="text-[#111]">
                                                {new Date(lastExtr.finishedAt ?? lastExtr.startedAt ?? lastExtr.createdAt).toLocaleString('ru')}
                                            </b>
                                            <span className="text-gray-400"> · {humanizeAgo(lastExtr.finishedAt ?? lastExtr.startedAt ?? lastExtr.createdAt)}</span>
                                        </div>
                                        {lastExtr.status === 'failed' ? (
                                            <div className="text-red-600 text-[11px]">
                                                Сбор завершился с ошибкой{lastExtr.errorMessage ? `: ${lastExtr.errorMessage}` : ''}
                                            </div>
                                        ) : (
                                            <div className="text-[11px] text-gray-500 space-y-0.5">
                                                {pn('itemsCreated') != null && pn('itemsCreated')! > 0 && (
                                                    <div>· создано {pn('itemsCreated')} {plural(pn('itemsCreated')!,'знание','знания','знаний')}</div>
                                                )}
                                                {pn('itemsMerged') != null && pn('itemsMerged')! > 0 && (
                                                    <div>· объединено {pn('itemsMerged')}</div>
                                                )}
                                                {pn('itemsAsDraft') != null && pn('itemsAsDraft')! > 0 && (
                                                    <div>· черновиков {pn('itemsAsDraft')}</div>
                                                )}
                                                {pn('trustedConflictsBlocked') != null && pn('trustedConflictsBlocked')! > 0 && (
                                                    <div className="text-red-600">⛔ заблокировано противоречий с правилами: {pn('trustedConflictsBlocked')}</div>
                                                )}
                                                {pn('trustedMatchesBoosted') != null && pn('trustedMatchesBoosted')! > 0 && (
                                                    <div className="text-green-700">✓ подтверждает проверенные правила: {pn('trustedMatchesBoosted')}</div>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {/* Состояние ядра — counters line */}
                    {!coreEmpty && (
                        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12px] text-gray-600 pt-1 border-t border-[#E4ECFC]">
                            <span><b className="text-[#111]">{readiness.counts.activeItems}</b> активных знаний</span>
                            <span className="text-gray-400">·</span>
                            <span><b className="text-[#111]">{readiness.counts.verifiedItems}</b> подтверждено</span>
                            {readiness.counts.draftItems > 0 && (
                                <>
                                    <span className="text-gray-400">·</span>
                                    <span>{readiness.counts.draftItems} {plural(readiness.counts.draftItems,'черновик','черновика','черновиков')}</span>
                                </>
                            )}
                            {readiness.counts.conflictGroups > 0 && (
                                <>
                                    <span className="text-gray-400">·</span>
                                    <span className="text-amber-600">{readiness.counts.conflictGroups} {plural(readiness.counts.conflictGroups,'спорное','спорных','спорных')}</span>
                                </>
                            )}
                            {(() => {
                                const fromDisabled = sourceStats
                                    .filter(s => s.connectionId && s.sourcesTotal > 0 && s.sourcesActive === 0)
                                    .reduce((sum, s) => sum + s.itemsActive, 0)
                                if (fromDisabled === 0) return null
                                return (
                                    <>
                                        <span className="text-gray-400">·</span>
                                        <span className="text-gray-500"
                                              title="Знания, у которых все исходные аккаунты отключены администратором. Сохранены, потому что подтверждены вручную или добавлены как ручная запись.">
                                            {fromDisabled} из отключённых источников
                                        </span>
                                    </>
                                )
                            })()}
                        </div>
                    )}

                    {/* PR7.13: Основные действия — primary actions сверху */}
                    <div className="flex flex-wrap gap-2 pt-1">
                        {extractionRunning ? (
                            <div className="h-[32px] px-3 inline-flex items-center gap-1.5 rounded-md bg-[#3390EC]/10 text-[#3390EC] text-[12px] font-semibold">
                                <Loader2 size={12} className="animate-spin" />
                                {activeExtractionJob!.status === 'queued' ? 'В очереди' : 'Идёт сбор'}
                                {activeExtractionJob!.progress?.pairsProcessed != null && activeExtractionJob!.progress?.pairsBuilt != null && activeExtractionJob!.progress.pairsBuilt > 0 && (
                                    <span className="text-gray-500 font-normal">
                                        · {activeExtractionJob!.progress.pairsProcessed}/{activeExtractionJob!.progress.pairsBuilt}
                                    </span>
                                )}
                            </div>
                        ) : (
                            <button
                                type="button"
                                onClick={() => canEdit && !noKey && openExtractionModal()}
                                disabled={!canEdit || noKey}
                                title={!canEdit
                                    ? 'Доступно только Администратору'
                                    : noKey
                                        ? 'Сначала настройте AI Провайдер (вкладка слева) — добавьте API ключ'
                                        : coreEmpty
                                            ? 'Запустить первый сбор ядра из истории переписок'
                                            : 'Дособрать ядро из свежих переписок (старые знания сохранятся)'}
                                className="h-[32px] px-3.5 inline-flex items-center gap-1.5 rounded-md bg-[#3390EC] text-white text-[12px] font-semibold hover:bg-[#2B7FD4] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            >
                                <Sparkles size={12} />
                                {coreEmpty ? 'Собрать ядро' : 'Собрать / обновить ядро'}
                            </button>
                        )}
                        {/* PR8.A: reset button всегда видна. Раньше пряталась
                            при coreEmpty — но даже если activeItems=0, могут
                            быть черновики или архивные записи, которые
                            пользователь хочет полностью очистить перед
                            новым сбором. */}
                        {canEdit && (
                            <button
                                type="button"
                                onClick={openResetModal}
                                title={coreEmpty
                                    ? 'Активных знаний сейчас нет — но можно очистить черновики и архив, чтобы начать с чистого листа перед новым сбором.'
                                    : 'Перевести активные знания в архив (мягкое действие, обратимо) и собрать ядро заново.'}
                                className="h-[32px] px-3 inline-flex items-center gap-1.5 rounded-md text-[12px] font-semibold text-red-700 border border-red-200 hover:bg-red-50 transition-colors"
                            >
                                <Trash2 size={12} />
                                {coreEmpty ? 'Очистить ядро' : 'Очистить и собрать заново'}
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={() => setKnowledgeSubtab('sources')}
                            className="h-[32px] px-3 inline-flex items-center gap-1.5 rounded-md text-[12px] font-semibold text-gray-700 border border-[#E0E0E0] hover:bg-[#F0F4FA] hover:text-[#3390EC] transition-colors"
                        >
                            Посмотреть источники
                        </button>
                        <a
                            href="/settings/integrations/ai-knowledge-help"
                            target="_blank"
                            rel="noopener"
                            className="h-[32px] px-3 inline-flex items-center gap-1.5 rounded-md text-[12px] font-semibold text-gray-700 border border-[#E0E0E0] hover:bg-[#F0F4FA] hover:text-[#3390EC] transition-colors"
                        >
                            Инструкция
                        </a>
                    </div>
                </section>

                {/* PR5: detailed readiness row — оставлен как secondary
                    view для technical health 7d (escalation%, no_match%,
                    verified%, mismatch%). Passport выше — primary UX. */}
                <KnowledgeReadinessRow />

                {/* Под-табы. Кнопка «Собрать ядро» теперь в passport выше. */}
                <div className="flex items-center justify-between">
                    <div className="flex gap-1">
                        {(['core','sources','archive'] as const).map(k => (
                            <button
                                key={k}
                                onClick={() => setKnowledgeSubtab(k)}
                                className={`h-[28px] px-3 rounded-lg text-[12px] font-medium transition-colors ${
                                    knowledgeSubtab === k
                                        ? 'bg-[#F0F4FA] text-[#3390EC]'
                                        : 'text-gray-500 hover:text-[#111]'
                                }`}
                            >
                                {k === 'core' ? 'Ядро' : k === 'sources' ? 'Источники' : 'Архив'}
                            </button>
                        ))}
                    </div>
                </div>

                {knowledgeSubtab === 'sources' ? (
                    <KnowledgeSourcesPanel />
                ) : (
                    /* Book-style: оглавление + контент выбранной секции */
                    <div className="grid grid-cols-[260px_1fr] gap-6 border-t border-[#F0F0F0] pt-4">
                        {/* Оглавление */}
                        <div className="space-y-0.5">
                            {sections.length === 0 ? (
                                <p className="text-[11px] text-gray-400 px-2 py-3 leading-relaxed">
                                    Разделы не настроены. Запустите{' '}
                                    <code className="text-[10px]">node scripts/seed_knowledge_sections.js</code>.
                                </p>
                            ) : sections.map(s => {
                                const Icon = (s.iconKey && SECTION_ICONS[s.iconKey]) || BookOpen
                                const isSelected = s.id === selectedSectionId
                                return (
                                    <button
                                        key={s.id}
                                        onClick={() => setSelectedSectionId(s.id)}
                                        className={`w-full flex items-center gap-2 px-2 py-2 rounded-lg text-left transition-colors ${
                                            isSelected
                                                ? 'bg-[#F0F4FA] text-[#3390EC]'
                                                : 'text-[#111] hover:bg-[#F8F9FA]'
                                        }`}
                                    >
                                        <Icon size={14} className={isSelected ? 'text-[#3390EC]' : 'text-gray-400'} />
                                        <span className="flex-1 text-[13px] font-medium truncate">{s.title}</span>
                                        <span className={`text-[11px] tabular-nums ${isSelected ? 'text-[#3390EC]' : 'text-gray-400'}`}>
                                            {s.itemCount}
                                        </span>
                                        <ChevronRight size={12} className={`transition-opacity ${isSelected ? 'opacity-100' : 'opacity-0'}`} />
                                    </button>
                                )
                            })}
                        </div>

                        {/* Контент */}
                        <div>
                            {!selectedSection ? (
                                <div className="text-[12px] text-gray-400 italic">Выберите раздел слева.</div>
                            ) : (
                                <>
                                    <div className="mb-3 flex items-start justify-between gap-3">
                                        <div className="flex-1 min-w-0">
                                            <h3 className="text-[15px] font-semibold text-[#111]">{selectedSection.title}</h3>
                                            {selectedSection.description && (
                                                <p className="text-[12px] text-gray-500 mt-0.5">{selectedSection.description}</p>
                                            )}
                                        </div>
                                        {canEdit && knowledgeSubtab === 'core' && (
                                            <button
                                                onClick={() => {
                                                    setManualForm({ title: '', canonicalStatement: '', tagsCsv: '', safetyLevel: 'normal' })
                                                    setManualCreateOpen(true)
                                                }}
                                                className="h-[28px] px-3 inline-flex items-center gap-1.5 rounded-lg border border-[#E0E0E0] bg-white hover:border-[#3390EC] hover:text-[#3390EC] text-[11px] font-medium text-gray-600 transition-colors shrink-0"
                                            >
                                                <Plus size={11} /> Добавить вручную
                                            </button>
                                        )}
                                    </div>
                                    {/* PR5: client-side filter (только Ядро под-таб).
                                        Архив имеет свою отдельную секцию items. */}
                                    {knowledgeSubtab === 'core' && knowledgeItems.length > 0 && (() => {
                                        const conflictCount   = knowledgeItems.filter(i => i.conflictGroupId).length
                                        const draftCount      = knowledgeItems.filter(i => i.status === 'draft').length
                                        const unverifiedCount = knowledgeItems.filter(i => !i.isVerified && i.status === 'active').length
                                        const unverifiedIds   = knowledgeItems.filter(i => !i.isVerified && i.status === 'active').map(i => i.id)
                                        return (
                                        <div className="flex items-center gap-x-3 gap-y-1 text-[11px] mb-2 flex-wrap">
                                            <button
                                                onClick={() => setCoreFilter('all')}
                                                className={`transition-colors ${coreFilter === 'all' ? 'text-[#3390EC] font-medium' : 'text-gray-500 hover:text-[#111]'}`}
                                            >
                                                Все ({knowledgeItems.length})
                                            </button>
                                            {conflictCount > 0 && (
                                                <button
                                                    onClick={() => setCoreFilter('conflicts')}
                                                    className={`transition-colors ${coreFilter === 'conflicts' ? 'text-amber-600 font-medium' : 'text-gray-500 hover:text-[#111]'}`}
                                                >
                                                    Конфликты ({conflictCount})
                                                </button>
                                            )}
                                            {draftCount > 0 && (
                                                <button
                                                    onClick={() => setCoreFilter('drafts')}
                                                    className={`transition-colors ${coreFilter === 'drafts' ? 'text-blue-500 font-medium' : 'text-gray-500 hover:text-[#111]'}`}
                                                >
                                                    Черновики ({draftCount})
                                                </button>
                                            )}
                                            {unverifiedCount > 0 && (
                                                <button
                                                    onClick={() => setCoreFilter('unverified')}
                                                    className={`transition-colors ${coreFilter === 'unverified' ? 'text-gray-700 font-medium' : 'text-gray-500 hover:text-[#111]'}`}
                                                >
                                                    Без подтверждения ({unverifiedCount})
                                                </button>
                                            )}
                                            {/* PR5: bulk action — показывается только если выбран
                                                соответствующий filter с непустым набором. */}
                                            {canEdit && coreFilter === 'unverified' && unverifiedCount > 0 && (
                                                <button
                                                    onClick={() => handleBulkVerify(unverifiedIds)}
                                                    disabled={bulkRunning}
                                                    title="Подтвердить все знания в текущей выборке. Каждое попадает в audit отдельной записью."
                                                    className="ml-auto h-[24px] px-2.5 inline-flex items-center gap-1 rounded border border-green-500/40 text-green-700 text-[10px] font-medium hover:bg-green-50 disabled:opacity-50 transition-colors"
                                                >
                                                    {bulkRunning && <Loader2 size={10} className="animate-spin" />}
                                                    Подтвердить все
                                                </button>
                                            )}
                                            {canEdit && coreFilter === 'drafts' && draftCount > 0 && (
                                                <button
                                                    onClick={() => handleBulkArchiveDrafts(selectedSectionId)}
                                                    disabled={bulkRunning}
                                                    title="Архивировать все черновики в этом разделе. Обратимо через «Архив → Восстановить»."
                                                    className="ml-auto h-[24px] px-2.5 inline-flex items-center gap-1 rounded border border-amber-500/40 text-amber-700 text-[10px] font-medium hover:bg-amber-50 disabled:opacity-50 transition-colors"
                                                >
                                                    {bulkRunning && <Loader2 size={10} className="animate-spin" />}
                                                    Архивировать все черновики
                                                </button>
                                            )}
                                        </div>
                                        )
                                    })()}
                                    {knowledgeItemsLoading ? (
                                        <div className="flex items-center gap-2 text-[12px] text-gray-400 py-6">
                                            <Loader2 size={12} className="animate-spin" /> Загружаем…
                                        </div>
                                    ) : knowledgeItems.length === 0 ? (
                                        <div className="text-center py-12 text-[12px] text-gray-400">
                                            {knowledgeSubtab === 'archive' ? (
                                                <>В этом разделе нет архивных знаний.</>
                                            ) : (
                                                <>
                                                    <div className="font-medium text-[#111] text-[13px] mb-1">Пока пусто</div>
                                                    В этом разделе нет извлечённых знаний.<br />
                                                    Нажмите «Собрать ядро» — AI проанализирует<br />
                                                    импортированные переписки и сам соберёт факты.
                                                </>
                                            )}
                                        </div>
                                    ) : (() => {
                                        const filtered = knowledgeSubtab !== 'core' ? knowledgeItems :
                                            coreFilter === 'conflicts'  ? knowledgeItems.filter(i => i.conflictGroupId) :
                                            coreFilter === 'drafts'     ? knowledgeItems.filter(i => i.status === 'draft') :
                                            coreFilter === 'unverified' ? knowledgeItems.filter(i => !i.isVerified && i.status === 'active') :
                                                                          knowledgeItems
                                        if (filtered.length === 0) {
                                            return (
                                                <div className="text-center py-8 text-[12px] text-gray-400">
                                                    По выбранному фильтру ничего не найдено.
                                                </div>
                                            )
                                        }
                                        return (
                                            <div className="divide-y divide-[#F0F0F0] border-t border-[#F0F0F0]">
                                                {filtered.map(it => (
                                                    <KnowledgeItemRow key={it.id} item={it} />
                                                ))}
                                            </div>
                                        )
                                    })()}
                                </>
                            )}
                        </div>
                    </div>
                )}
            </div>
            {/* PR2.5 Edit / History modal */}
            {editingItem && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
                     onClick={() => !editSaving && setEditingItem(null)}>
                    <div onClick={e => e.stopPropagation()}
                         className="bg-white rounded-xl shadow-xl w-[520px] max-w-[94vw] max-h-[88vh] flex flex-col">
                        <div className="px-6 pt-5 pb-3">
                            <h2 className="text-[17px] font-semibold text-[#111]">Знание</h2>
                            <p className="text-[11px] text-gray-400 mt-0.5">
                                {editingItem.isVerified ? 'подтверждено · ' : ''}
                                {editingItem.sourceCount === 0
                                    ? 'создано вручную'
                                    : `${editingItem.sourceCount} ${plural(editingItem.sourceCount,'источник','источника','источников')}`}
                            </p>
                        </div>
                        <div className="flex gap-1 px-6 border-b border-[#F0F0F0]">
                            {(['fields','history'] as const).map(k => (
                                <button key={k}
                                    onClick={() => {
                                        setEditTab(k)
                                        if (k === 'history' && editingItem) loadAuditHistory(editingItem.id)
                                    }}
                                    className={`px-3 h-[32px] text-[12px] font-medium -mb-px border-b transition-colors ${
                                        editTab === k
                                            ? 'border-[#3390EC] text-[#3390EC]'
                                            : 'border-transparent text-gray-500 hover:text-[#111]'
                                    }`}>
                                    {k === 'fields' ? 'Поля' : 'История'}
                                </button>
                            ))}
                        </div>
                        <div className="flex-1 overflow-y-auto px-6 py-4">
                            {editTab === 'fields' ? (
                                <div className="space-y-3">
                                    <div>
                                        <label className="text-[11px] text-gray-500 block mb-1">Заголовок</label>
                                        <input value={editForm.title}
                                            onChange={e => setEditForm(f => ({ ...f, title: e.target.value }))}
                                            className="w-full h-[34px] border border-[#E0E0E0] rounded-lg px-3 text-[13px] outline-none focus:border-[#3390EC]" />
                                    </div>
                                    <div>
                                        <label className="text-[11px] text-gray-500 block mb-1">Формулировка</label>
                                        <textarea rows={4} value={editForm.canonicalStatement}
                                            onChange={e => setEditForm(f => ({ ...f, canonicalStatement: e.target.value }))}
                                            className="w-full border border-[#E0E0E0] rounded-lg px-3 py-2 text-[13px] outline-none focus:border-[#3390EC] resize-none leading-relaxed" />
                                    </div>
                                    <div className="grid grid-cols-2 gap-3">
                                        <div>
                                            <label className="text-[11px] text-gray-500 mb-1 block">Теги (через запятую)</label>
                                            <input value={editForm.tagsCsv}
                                                onChange={e => setEditForm(f => ({ ...f, tagsCsv: e.target.value }))}
                                                placeholder="комиссия, тариф"
                                                className="w-full h-[34px] border border-[#E0E0E0] rounded-lg px-3 text-[13px] outline-none focus:border-[#3390EC]" />
                                        </div>
                                        <div>
                                            <label className="text-[11px] text-gray-500 mb-1 flex items-center gap-1.5">
                                                Категория <Hint text="«Чувствительное» — финансы. «Только менеджер» — индивидуальные условия, AI всегда эскалирует." />
                                            </label>
                                            <select value={editForm.safetyLevel}
                                                onChange={e => setEditForm(f => ({ ...f, safetyLevel: e.target.value as typeof f.safetyLevel }))}
                                                className="w-full h-[34px] border border-[#E0E0E0] rounded-lg px-3 text-[13px] outline-none focus:border-[#3390EC] bg-white">
                                                <option value="normal">обычное</option>
                                                <option value="sensitive">чувствительное</option>
                                                <option value="requires_human">только менеджер</option>
                                            </select>
                                        </div>
                                    </div>
                                    {editingItem.status === 'active' && (
                                        <button onClick={() => setSupersedeFor(editingItem)}
                                            className="text-[12px] text-[#3390EC] hover:underline inline-flex items-center gap-1">
                                            Заменить новым знанием →
                                        </button>
                                    )}
                                </div>
                            ) : (
                                auditEntries.length === 0 ? (
                                    <div className="text-center text-[12px] text-gray-400 py-8">История пока пуста.</div>
                                ) : (
                                    <div className="space-y-2">
                                        {auditEntries.map(a => (
                                            <div key={a.id} className="border-l-2 border-[#E8E8E8] pl-3 py-1">
                                                <div className="text-[12px] text-[#111]">
                                                    <strong className="font-semibold">{ACTION_LABEL[a.action] ?? a.action}</strong>
                                                    {a.actor && <span className="text-gray-400"> · {a.actor}</span>}
                                                </div>
                                                <div className="text-[11px] text-gray-400">{new Date(a.createdAt).toLocaleString('ru')}</div>
                                            </div>
                                        ))}
                                    </div>
                                )
                            )}
                        </div>
                        <div className="flex justify-end gap-2 px-6 py-4 border-t border-[#F0F0F0]">
                            <button onClick={() => setEditingItem(null)} disabled={editSaving}
                                className="h-[36px] px-4 text-[13px] text-gray-600 hover:text-[#111] rounded-md transition-colors disabled:opacity-50">
                                Закрыть
                            </button>
                            {editTab === 'fields' && (
                                <button onClick={handleSaveEdit} disabled={editSaving}
                                    className="h-[36px] px-4 inline-flex items-center gap-1.5 bg-[#3390EC] text-white text-[13px] font-semibold rounded-md hover:bg-[#2B7FD4] disabled:opacity-50">
                                    {editSaving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                                    Сохранить
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* PR2.5 Manual create modal */}
            {manualCreateOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
                     onClick={() => !manualSaving && setManualCreateOpen(false)}>
                    <div onClick={e => e.stopPropagation()}
                         className="bg-white rounded-xl shadow-xl p-6 w-[480px] max-w-[94vw] space-y-3">
                        <div>
                            <h2 className="text-[17px] font-semibold text-[#111]">Добавить знание вручную</h2>
                            <p className="text-[12px] text-gray-500 mt-1">
                                Будет добавлено в раздел «{sections.find(s => s.id === selectedSectionId)?.title}»
                                как подтверждённое знание.
                            </p>
                        </div>
                        <div>
                            <label className="text-[11px] text-gray-500 block mb-1">Заголовок *</label>
                            <input value={manualForm.title}
                                onChange={e => setManualForm(f => ({ ...f, title: e.target.value }))}
                                placeholder="Минимальный возраст водителя"
                                className="w-full h-[34px] border border-[#E0E0E0] rounded-lg px-3 text-[13px] outline-none focus:border-[#3390EC]" />
                        </div>
                        <div>
                            <label className="text-[11px] text-gray-500 block mb-1">Формулировка *</label>
                            <textarea rows={3} value={manualForm.canonicalStatement}
                                onChange={e => setManualForm(f => ({ ...f, canonicalStatement: e.target.value }))}
                                placeholder="Минимальный возраст водителя — 21 год."
                                className="w-full border border-[#E0E0E0] rounded-lg px-3 py-2 text-[13px] outline-none focus:border-[#3390EC] resize-none leading-relaxed" />
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label className="text-[11px] text-gray-500 block mb-1">Теги</label>
                                <input value={manualForm.tagsCsv}
                                    onChange={e => setManualForm(f => ({ ...f, tagsCsv: e.target.value }))}
                                    placeholder="возраст, требования"
                                    className="w-full h-[34px] border border-[#E0E0E0] rounded-lg px-3 text-[13px] outline-none focus:border-[#3390EC]" />
                            </div>
                            <div>
                                <label className="text-[11px] text-gray-500 block mb-1">Категория</label>
                                <select value={manualForm.safetyLevel}
                                    onChange={e => setManualForm(f => ({ ...f, safetyLevel: e.target.value as typeof f.safetyLevel }))}
                                    className="w-full h-[34px] border border-[#E0E0E0] rounded-lg px-3 text-[13px] outline-none focus:border-[#3390EC] bg-white">
                                    <option value="normal">обычное</option>
                                    <option value="sensitive">чувствительное</option>
                                    <option value="requires_human">только менеджер</option>
                                </select>
                            </div>
                        </div>
                        <div className="flex justify-end gap-2 pt-2">
                            <button onClick={() => setManualCreateOpen(false)} disabled={manualSaving}
                                className="h-[36px] px-4 text-[13px] text-gray-600 hover:text-[#111] rounded-md disabled:opacity-50">
                                Отмена
                            </button>
                            <button onClick={handleCreateManual}
                                disabled={manualSaving || !manualForm.title.trim() || !manualForm.canonicalStatement.trim()}
                                className="h-[36px] px-4 inline-flex items-center gap-1.5 bg-[#3390EC] text-white text-[13px] font-semibold rounded-md hover:bg-[#2B7FD4] disabled:opacity-50">
                                {manualSaving ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
                                Создать
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* PR2.5 Conflict resolver modal */}
            {conflictFor && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
                     onClick={() => setConflictFor(null)}>
                    <div onClick={e => e.stopPropagation()}
                         className="bg-white rounded-xl shadow-xl p-6 w-[540px] max-w-[94vw] space-y-3 max-h-[80vh] overflow-y-auto">
                        <div>
                            <h2 className="text-[17px] font-semibold text-[#111]">Конфликт знаний</h2>
                            <p className="text-[12px] text-gray-500 mt-1">
                                AI извлёк противоречивые формулировки. Выберите, какое
                                оставить, или снимите конфликт, если оба верны.
                            </p>
                        </div>
                        <div className="divide-y divide-[#F0F0F0] border-t border-[#F0F0F0]">
                            {conflictMembers.map(m => (
                                <div key={m.id} className="py-3 flex items-start gap-2">
                                    <div className="flex-1 min-w-0">
                                        <div className="text-[13px] font-semibold text-[#111]">
                                            {m.title}
                                            {!m.isActive && <span className="ml-2 text-[10px] text-gray-400">в архиве</span>}
                                            {m.id === conflictFor.id && <span className="ml-2 text-[10px] text-[#3390EC]">(этот)</span>}
                                        </div>
                                        <p className="text-[12px] text-gray-600 mt-0.5">{m.canonicalStatement}</p>
                                        <div className="text-[10px] text-gray-400 mt-0.5">
                                            {m.sourceCount} {plural(m.sourceCount,'диалог','диалога','диалогов')} ·
                                            уверенность {(m.confidence*100|0)}%
                                        </div>
                                    </div>
                                    {m.isActive && (
                                        <button onClick={() => handleResolveConflict(m.id, 'keep_this_archive_others')}
                                            className="h-7 px-2.5 text-[11px] text-[#3390EC] hover:bg-[#F0F4FA] rounded-md font-medium shrink-0">
                                            Оставить это
                                        </button>
                                    )}
                                </div>
                            ))}
                        </div>
                        <div className="flex justify-end gap-2 pt-2">
                            <button onClick={() => handleResolveConflict(conflictFor.id, 'unmark_all')}
                                className="h-[36px] px-4 text-[13px] text-gray-600 hover:text-[#111] rounded-md">
                                Снять конфликт без действий
                            </button>
                            <button onClick={() => setConflictFor(null)}
                                className="h-[36px] px-4 text-[13px] text-gray-600 hover:text-[#111] rounded-md">
                                Закрыть
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* PR2.5 Supersede picker modal */}
            {supersedeFor && (
                <SupersedePickerModal
                    oldItem={supersedeFor}
                    onClose={() => setSupersedeFor(null)}
                    onPick={(newId) => handleSupersede(supersedeFor, newId)}
                />
            )}

            {/* Extraction modal */}
            {extractionModalOpen && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
                    onClick={() => !extractionStarting && setExtractionModalOpen(false)}
                >
                    <div onClick={e => e.stopPropagation()}
                         className="bg-white rounded-xl shadow-xl p-6 w-[480px] max-w-[94vw] space-y-4 max-h-[90vh] overflow-y-auto">
                        <div>
                            <h2 className="text-[17px] font-semibold text-[#111]">Сбор ядра знаний</h2>
                            <p className="text-[12px] text-gray-500 mt-1 leading-relaxed">
                                AI проанализирует импортированную историю переписок
                                и обновит ядро. Не влияет на ответы клиентам.
                            </p>
                        </div>

                        {/* PR7.13: явный 3-шаговый flow. Контекст-summary
                            переехал в Шаг 3 «Что будет сделано» как
                            итоговый блок перед запуском. */}
                        <div>
                            <label className="text-[11px] uppercase tracking-wide text-[#3390EC] font-semibold mb-1.5 block">
                                Шаг 1 · Что анализировать
                            </label>
                            {/* PR9.3: показываем РЕАЛЬНЫЙ диапазон данных
                                в БД для выбранных аккаунтов. Без этого
                                пользователь думал что «Всю историю» = качай
                                из мессенджера; на самом деле AI работает
                                только с тем что физически в БД. */}
                            {extractionRange && extractionRange.totalMessages > 0 && (
                                <div className="mb-2 rounded-md bg-[#F0F4FA] border border-[#E0E8F4] px-3 py-2 text-[11px] text-gray-700 leading-relaxed">
                                    <div>
                                        <strong className="text-[#111]">В БД сейчас есть:</strong>{' '}
                                        {extractionRange.totalMessages.toLocaleString('ru')} сообщений
                                        {extractionRange.earliestSentAt && extractionRange.latestSentAt && (
                                            <>
                                                {' '}с <b>{new Date(extractionRange.earliestSentAt).toLocaleDateString('ru')}</b>
                                                {' '}по <b>{new Date(extractionRange.latestSentAt).toLocaleDateString('ru')}</b>
                                            </>
                                        )}.
                                    </div>
                                    <div className="text-gray-500 mt-0.5">
                                        AI анализирует то, что уже загружено в БД. Чтобы дозагрузить — «Синхронизация».
                                    </div>
                                </div>
                            )}
                            {extractionRange && extractionRange.totalMessages === 0 && !extractionRangeLoading && (
                                <div className="mb-2 rounded-md bg-[#FFFBED] border border-[#FFE8B0] px-3 py-2 text-[11px] text-[#8B6914] leading-relaxed">
                                    Для выбранных аккаунтов в БД ещё нет сообщений. Сначала загрузите историю через «Синхронизацию».
                                </div>
                            )}
                            <div className="flex flex-col gap-1.5">
                                {(() => {
                                    // PR9.3: per-scope real counts из extractionRange.
                                    // Пользователь видит «Последние 30 дней (450 сообщ.)»
                                    // вместо абстрактного «быстро».
                                    const opts = [
                                        { v: 'last_30d' as const, label: 'Последние 30 дней',  count: extractionRange?.last30dMessages, hint: 'быстро, свежие данные' },
                                        { v: 'last_90d' as const, label: 'Последние 90 дней',  count: extractionRange?.last90dMessages, hint: 'рекомендуется для первой сборки' },
                                        { v: 'all'      as const, label: 'Все что есть в БД',  count: extractionRange?.totalMessages,   hint: 'максимум знаний из загруженной истории' },
                                    ]
                                    return opts.map(opt => (
                                        <label key={opt.v}
                                            className={`flex items-start gap-2 px-3 py-2 rounded-lg cursor-pointer border transition-colors ${
                                                extractionScopeMode === opt.v
                                                    ? 'border-[#3390EC] bg-[#F0F4FA]'
                                                    : 'border-[#E8E8E8] hover:border-[#C8C8C8]'
                                            }`}>
                                            <input type="radio" name="extraction-scope" className="mt-0.5"
                                                checked={extractionScopeMode === opt.v}
                                                onChange={() => setExtractionScopeMode(opt.v)} />
                                            <div className="flex-1 min-w-0">
                                                <div className="text-[13px] font-medium text-[#111] flex items-baseline gap-1.5">
                                                    {opt.label}
                                                    {opt.count !== undefined && (
                                                        <span className="text-[11px] font-normal text-gray-500">
                                                            ({opt.count.toLocaleString('ru')} сообщ.)
                                                        </span>
                                                    )}
                                                </div>
                                                <div className="text-[11px] text-gray-500">{opt.hint}</div>
                                            </div>
                                        </label>
                                    ))
                                })()}
                            </div>
                        </div>
                        {/* PR7.4 + 7.13: Шаг 2 — Из каких источников.
                            Показывает реальные подключения с честным
                            разделением на WA (filter работает) и TG/MAX
                            (best-effort, берётся вся история канала). */}
                        <div>
                            <label className="text-[11px] uppercase tracking-wide text-[#3390EC] font-semibold mb-1.5 flex items-center gap-1.5">
                                Шаг 2 · Из каких источников собрать знания
                                <Hint text="Выбрать конкретные аккаунты WhatsApp работает напрямую — будут проанализированы только их чаты. Для Telegram и MAX сбор пока берёт всю историю канала независимо от отметок." />
                            </label>
                            {channelConnectionsLoading ? (
                                <div className="flex items-center gap-2 text-[12px] text-gray-400 py-3 px-3">
                                    <Loader2 size={12} className="animate-spin" /> Загружаем список подключений…
                                </div>
                            ) : channelConnections.length === 0 ? (
                                <div className="text-[12px] text-gray-500 px-3 py-3 rounded-lg border border-[#FFE8B0] bg-[#FFFBED]">
                                    Нет подключённых мессенджеров. Можно собрать только из уже загруженной истории — нажмите «Запустить».
                                </div>
                            ) : (
                                <>
                                    {(() => {
                                        const STATUS_LABEL: Record<string, string> = {
                                            ready:          'подключён',
                                            qr:             'ждёт QR',
                                            authenticating: 'входит',
                                            idle:           'не активен',
                                            disconnected:   'отключён',
                                            inactive:       'отключён',
                                            unknown:        '—',
                                        }
                                        const CHANNEL_LABEL: Record<string, string> = {
                                            whatsapp: 'WhatsApp',
                                            telegram: 'Telegram',
                                            max:      'MAX',
                                        }
                                        // group by channel
                                        const byChannel = new Map<string, ChannelConnection[]>()
                                        for (const c of channelConnections) {
                                            const arr = byChannel.get(c.channel) ?? []
                                            arr.push(c)
                                            byChannel.set(c.channel, arr)
                                        }
                                        return (
                                            <div className="flex flex-col gap-2">
                                                {[...byChannel.entries()].map(([channel, conns]) => {
                                                    // PR7.15: вычисляем, есть ли у канала хоть один effective-selected
                                                    // (с учётом onlyConnectedNow), чтобы показывать честный header.
                                                    const channelHasEffective = conns.some(c => {
                                                        const isEffectivelySelected =
                                                            selectedConnectionIds.has(c.id)
                                                            && (!onlyConnectedNow || c.isReady)
                                                        return isEffectivelySelected
                                                    })
                                                    // PR7.15.1: дополнительно различаем кейсы:
                                                    // (а) все галочки сняты руками — пользователь сам исключил канал
                                                    // (б) галочки disabled фильтром «Только подключённые сейчас»
                                                    // (в) хоть одна effective ☑ — канал в сборе
                                                    const allRowsBlockedByFilter = conns.every(c => onlyConnectedNow && !c.isReady)
                                                    // PR7.15.2: one-click «включить канал» — снимает фильтр И
                                                    // автоматически добавляет все подключения этого канала
                                                    // в выбор. Раньше пользователь сначала кликал «снять
                                                    // фильтр», потом ещё раз должен был явно тыкнуть чекбокс
                                                    // — и это было неочевидно.
                                                    const handleEnableChannel = () => {
                                                        setOnlyConnectedNow(false)
                                                        setSelectedConnectionIds(prev => {
                                                            const next = new Set(prev)
                                                            for (const c of conns) next.add(c.id)
                                                            return next
                                                        })
                                                    }
                                                    return (
                                                    <div key={channel} className="rounded-lg border border-[#E8E8E8]">
                                                        <div className="px-3 py-1.5 text-[11px] font-semibold text-gray-500 uppercase tracking-wide bg-[#FAFBFC] rounded-t-lg flex items-center justify-between">
                                                            <span>{CHANNEL_LABEL[channel] ?? channel}</span>
                                                            {/* PR8.B5: убран amber-дисклеймер «берётся вся
                                                                история канала» — теперь TG/MAX тоже точечно
                                                                фильтруются через Chat.metadata.connectionId.
                                                                Оставлены useful action-buttons для всех каналов. */}
                                                            {!channelHasEffective && (
                                                                allRowsBlockedByFilter ? (
                                                                    <button
                                                                        type="button"
                                                                        onClick={(e) => { e.preventDefault(); handleEnableChannel() }}
                                                                        title="Снимет фильтр «Только подключённые сейчас» И автоматически поставит галки на все аккаунты этого канала. Один клик вместо двух."
                                                                        className="text-[10px] font-medium text-amber-700 hover:underline normal-case tracking-normal cursor-pointer"
                                                                    >
                                                                        включить канал в сбор
                                                                    </button>
                                                                ) : (
                                                                    <button
                                                                        type="button"
                                                                        onClick={(e) => { e.preventDefault(); handleEnableChannel() }}
                                                                        title="Поставить галки на все аккаунты этого канала, чтобы они попали в сбор."
                                                                        className="text-[10px] font-medium text-gray-500 hover:text-[#3390EC] hover:underline normal-case tracking-normal cursor-pointer"
                                                                    >
                                                                        канал не участвует — включить?
                                                                    </button>
                                                                )
                                                            )}
                                                        </div>
                                                        {/* PR7.15.3: explanation для MAX-архитектуры.
                                                            Теперь у MAX два типа источников: корпоративный
                                                            бот (через webhook) и личный аккаунт (через
                                                            web-скрейпер). Объясняем что они разные. */}
                                                        {channel === 'max' && (
                                                            <div className="px-3 py-1.5 text-[10px] text-gray-500 leading-relaxed border-t border-[#F0F0F0] bg-[#FAFBFC]">
                                                                MAX подключается двумя способами: через корпоративного бота (webhook) и через
                                                                личный аккаунт (web-скрейпер). Поставьте галки на нужные источники.
                                                            </div>
                                                        )}
                                                        {conns.map(conn => {
                                                            const checked = selectedConnectionIds.has(conn.id)
                                                            const disabled = onlyConnectedNow && !conn.isReady
                                                            const statusLabel = STATUS_LABEL[conn.status] ?? conn.status
                                                            const dotColor =
                                                                conn.isReady ? 'bg-green-500' :
                                                                conn.status === 'qr' || conn.status === 'authenticating' ? 'bg-amber-500' :
                                                                'bg-gray-300'
                                                            // PR7.12: hint о наличии загруженной истории —
                                                            // помогает понять «есть ли что собирать»
                                                            // именно из этого аккаунта.
                                                            const stat = sourceStats.find(s => s.connectionId === conn.id)
                                                            const hasHistory = !!stat && stat.itemsTouched > 0
                                                            // PR7.15.1: явная причина disabled — без неё
                                                            // пользователь не понимает почему чекбокс
                                                            // не реагирует. Главная причина — фильтр
                                                            // «Только подключённые сейчас» внизу.
                                                            const disabledTitle = disabled
                                                                ? `Снимите галку «Только подключённые сейчас» ниже, чтобы включить этот аккаунт в сбор. Сейчас он помечен как «${statusLabel}» и фильтр его блокирует.`
                                                                : ''
                                                            return (
                                                                <label key={conn.id}
                                                                    title={disabledTitle || undefined}
                                                                    className={`flex items-center gap-2 px-3 py-2 border-t border-[#F0F0F0] first:border-t-0 ${
                                                                        disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer hover:bg-[#FAFBFC]'
                                                                    }`}>
                                                                    <input type="checkbox"
                                                                        checked={checked && !disabled}
                                                                        disabled={disabled}
                                                                        onChange={() => !disabled && toggleConnectionSelection(conn.id)} />
                                                                    <span className="flex-1 text-[13px] text-[#111]">
                                                                        {conn.label.replace(/^(WhatsApp|Telegram|MAX) /, '') || 'безымянное подключение'}
                                                                        {disabled && (
                                                                            <span className="ml-1.5 text-[10px] text-amber-700 font-normal">
                                                                                · заблокирован фильтром
                                                                            </span>
                                                                        )}
                                                                    </span>
                                                                    <span className="inline-flex items-center gap-2 text-[10px] text-gray-500">
                                                                        {hasHistory ? (
                                                                            <span className="text-green-700" title="Этот аккаунт уже участвовал в сборе — есть сохранённая история">
                                                                                есть история
                                                                            </span>
                                                                        ) : (
                                                                            <span className="text-gray-400" title="Этот аккаунт ещё не участвовал в сборе ядра">
                                                                                истории нет
                                                                            </span>
                                                                        )}
                                                                        <span className="inline-flex items-center gap-1">
                                                                            <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
                                                                            {statusLabel}
                                                                        </span>
                                                                    </span>
                                                                </label>
                                                            )
                                                        })}
                                                    </div>
                                                    )
                                                })}
                                            </div>
                                        )
                                    })()}
                                    {/* PR7.15.1: показываем, сколько подключений заблокировано
                                        этим фильтром — даже если у них есть история. */}
                                    {(() => {
                                        const blockedCount = onlyConnectedNow
                                            ? channelConnections.filter(c => !c.isReady).length
                                            : 0
                                        return (
                                            <label className="flex items-center gap-2 mt-2.5 cursor-pointer text-[12px] text-gray-600">
                                                <input type="checkbox"
                                                    checked={onlyConnectedNow}
                                                    onChange={e => setOnlyConnectedNow(e.target.checked)} />
                                                <span>Только подключённые сейчас</span>
                                                {blockedCount > 0 && (
                                                    <span className="text-[11px] text-amber-700">
                                                        · сейчас блокирует {blockedCount} {blockedCount === 1 ? 'аккаунт' : blockedCount < 5 ? 'аккаунта' : 'аккаунтов'}
                                                    </span>
                                                )}
                                                <Hint text="Если включено — отключённые/ждущие QR аккаунты не попадут в сбор, даже если у них есть сохранённая история. Защита от случайного использования тестовых подключений. Снимите если хотите вручную выбрать неактивный аккаунт (например, MAX-бот, чей статус не обновлён, но сообщения приходят)." />
                                            </label>
                                        )
                                    })()}
                                </>
                            )}
                        </div>

                        {/* PR7.13: Шаг 3 — Что будет сделано.
                            Подытоживает выбор + явно описывает что
                            произойдёт после запуска. Раньше Context
                            Summary висел сверху и был отрезан от
                            submit; теперь это последний блок перед
                            кнопкой «Запустить сбор». */}
                        <div className="rounded-lg border border-[#E4ECFC] bg-[#F8FBFF] px-3 py-2.5 space-y-2">
                            <div className="text-[11px] uppercase tracking-wide text-[#3390EC] font-semibold">
                                Шаг 3 · Что будет сделано
                            </div>
                            {(() => {
                                // selected = чекбокс ☑ И (не онли-ready ИЛИ ready)
                                const willInclude = channelConnections.filter(c =>
                                    selectedConnectionIds.has(c.id) && (!onlyConnectedNow || c.isReady)
                                )
                                const willNotInclude = channelConnections.filter(c =>
                                    !willInclude.some(w => w.id === c.id)
                                )
                                const CHANNEL_LABEL_LOCAL: Record<string, string> = {
                                    whatsapp: 'WhatsApp', telegram: 'Telegram', max: 'MAX',
                                }
                                const includedByChannel = new Map<string, number>()
                                for (const c of willInclude) {
                                    includedByChannel.set(c.channel, (includedByChannel.get(c.channel) ?? 0) + 1)
                                }
                                const disabledByAdmin = new Set(sourceStats
                                    .filter(s => s.connectionId && s.sourcesTotal > 0 && s.sourcesActive === 0)
                                    .map(s => s.connectionId!) as string[])
                                const reasonFor = (c: ChannelConnection): string => {
                                    if (disabledByAdmin.has(c.id)) return 'источник отключён администратором'
                                    if (!c.isReady && onlyConnectedNow) {
                                        if (c.status === 'qr' || c.status === 'authenticating') return 'ждёт QR'
                                        return 'не активен'
                                    }
                                    if (!selectedConnectionIds.has(c.id)) {
                                        // No history hint
                                        const stat = sourceStats.find(s => s.connectionId === c.id)
                                        if (!stat || stat.itemsTouched === 0) return 'нет истории'
                                        return 'снят галкой'
                                    }
                                    return ''
                                }
                                // Safety warnings
                                const warnings: string[] = []
                                if (runtimeState.runtimeOn) {
                                    warnings.push('AI сейчас отвечает из ядра — пересборка временно изменит его. Это нормально, но имейте в виду.')
                                }
                                if (readiness.overall === 'warn' || readiness.overall === 'fail') {
                                    const conflictsCheck = readiness.checks.find(c => c.id === 'conflicts')
                                    if (conflictsCheck && conflictsCheck.status === 'fail') {
                                        warnings.push('В ядре есть неразрешённые спорные знания. Лучше сначала разобрать их.')
                                    }
                                }
                                return (
                                    <>
                                        {willInclude.length === 0 ? (
                                            <div className="text-[12px] text-gray-600">
                                                Не выбрано ни одного аккаунта — сбор пройдёт только по уже загруженной истории.
                                            </div>
                                        ) : (
                                            <div className="text-[12px] text-gray-700 space-y-0.5">
                                                <div className="text-gray-500">AI проанализирует:</div>
                                                {(['whatsapp','telegram','max'] as const).map(ch => {
                                                    const n = includedByChannel.get(ch) ?? 0
                                                    if (n === 0) return null
                                                    return (
                                                        <div key={ch} className="pl-2">
                                                            — {CHANNEL_LABEL_LOCAL[ch]}: {n} {n === 1 ? 'аккаунт' : n < 5 ? 'аккаунта' : 'аккаунтов'}
                                                        </div>
                                                    )
                                                })}
                                                {/* PR7.15: явно показать какие каналы НЕ участвуют — у них 0 selected */}
                                                {(['whatsapp','telegram','max'] as const).map(ch => {
                                                    const n = includedByChannel.get(ch) ?? 0
                                                    const hasConnections = channelConnections.some(c => c.channel === ch)
                                                    if (n > 0 || !hasConnections) return null
                                                    return (
                                                        <div key={`exc-${ch}`} className="pl-2 text-gray-400 text-[11px]">
                                                            — {CHANNEL_LABEL_LOCAL[ch]}: не участвует — нет выбранных аккаунтов
                                                        </div>
                                                    )
                                                })}
                                            </div>
                                        )}
                                        {willNotInclude.length > 0 && (
                                            <div className="text-[12px] text-gray-700 space-y-0.5 pt-1">
                                                <div className="text-gray-500">Не участвуют:</div>
                                                {willNotInclude.slice(0, 4).map(c => {
                                                    const r = reasonFor(c)
                                                    return (
                                                        <div key={c.id} className="pl-2 text-gray-500">
                                                            — {c.label}
                                                            {r && <span className="text-gray-400"> · {r}</span>}
                                                        </div>
                                                    )
                                                })}
                                                {willNotInclude.length > 4 && (
                                                    <div className="text-gray-400 pl-2">и ещё {willNotInclude.length - 4}</div>
                                                )}
                                            </div>
                                        )}
                                        <div className="text-[11px] text-gray-600 leading-relaxed pt-1.5 border-t border-[#E4ECFC] space-y-0.5">
                                            <div className="text-gray-500">После запуска AI:</div>
                                            <div className="pl-2">— соберёт знания из выбранных аккаунтов</div>
                                            <div className="pl-2">— заблокирует противоречия с проверенными правилами</div>
                                            <div className="pl-2">
                                                — {runtimeState.runtimeOn
                                                    ? 'постепенно начнёт отвечать клиентам из обновлённого ядра'
                                                    : 'не изменит ответы клиентам — runtime пока выключен'}
                                            </div>
                                        </div>
                                        {warnings.length > 0 && (
                                            <div className="rounded border border-[#FFE8B0] bg-[#FFFBED] px-2.5 py-2 text-[11px] text-[#8B6914] leading-relaxed space-y-1">
                                                {warnings.map((w, i) => (
                                                    <div key={i}>⚠ {w}</div>
                                                ))}
                                            </div>
                                        )}
                                    </>
                                )
                            })()}
                        </div>

                        <div>
                            <label className="text-[11px] text-gray-500 mb-1.5 flex items-center gap-1.5">
                                Модель анализа переписок
                                <Hint text="Экономичная — быстрее и дешевле; Сбалансированная — рекомендуется; Повышенное качество — медленнее и дороже. Эта настройка относится только к сбору ядра, не к ответам клиентам." />
                            </label>
                            <div className="flex flex-col gap-1.5">
                                {([
                                    { v: 'economy',  label: 'Экономичная',                      hint: 'быстрее и дешевле' },
                                    { v: 'balanced', label: 'Сбалансированная (рекомендуется)', hint: 'та же модель, что AI использует для классификации' },
                                    { v: 'quality',  label: 'Повышенное качество',              hint: 'медленнее и дороже, лучше для редких формулировок' },
                                ] as const).map(opt => (
                                    <label key={opt.v}
                                        className={`flex items-start gap-2 px-3 py-2 rounded-lg cursor-pointer border transition-colors ${
                                            extractionTier === opt.v
                                                ? 'border-[#3390EC] bg-[#F0F4FA]'
                                                : 'border-[#E8E8E8] hover:border-[#C8C8C8]'
                                        }`}>
                                        <input type="radio" name="extraction-tier" className="mt-0.5"
                                            checked={extractionTier === opt.v}
                                            onChange={() => setExtractionTier(opt.v)} />
                                        <div className="flex-1 min-w-0">
                                            <div className="text-[13px] font-medium text-[#111]">{opt.label}</div>
                                            <div className="text-[11px] text-gray-500">{opt.hint}</div>
                                        </div>
                                    </label>
                                ))}
                            </div>
                        </div>
                        <div className="flex justify-end gap-2 pt-1">
                            <button onClick={() => setExtractionModalOpen(false)} disabled={extractionStarting}
                                className="h-[36px] px-4 text-[13px] text-gray-600 hover:text-[#111] rounded-md transition-colors disabled:opacity-50">
                                Отмена
                            </button>
                            <button onClick={handleStartExtraction} disabled={extractionStarting}
                                className="h-[36px] px-4 inline-flex items-center gap-1.5 bg-[#3390EC] text-white text-[13px] font-semibold rounded-md hover:bg-[#2B7FD4] disabled:opacity-50 transition-colors">
                                {extractionStarting ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                                Запустить сбор
                            </button>
                        </div>
                    </div>
                </div>
            )}
            </>
        )
    }

    // ─── Вкладка: Журнал ──────────────────────────────────────────

    // Human-readable лейблы: «Ответил сам» вместо технического
    // «auto_reply», «Передал менеджеру» вместо «escalate». Это то, что
    // реально сделал AI, без терминов.
    const DECISION_LABEL: Record<string, string> = {
        auto_reply: 'Ответил сам',
        escalate:   'Передал менеджеру',
        skip:       'Не отвечал',
    }
    // Цвета — спокойные, без жирной заливки. Decision-маркер сейчас
    // ставится перед текстом ответа, без bg-фона.
    const DECISION_DOT_COLOR: Record<string, string> = {
        auto_reply: 'bg-green-500',
        escalate:   'bg-amber-500',
        skip:       'bg-gray-300',
    }

    // ─── Локальные фильтры журнала ────────────────────────────────
    // Серверный action `getDecisionLogs` уже принимает channel/decision —
    // но текущая страница грузит логи один раз на mount. Чтобы не трогать
    // backend и не плодить роутинг, фильтруем уже загруженные 30 записей
    // в памяти. Когда понадобится больше — добавим серверную пагинацию.
    const [logFilterChannel,  setLogFilterChannel]  = useState<string>('all')
    const [logFilterDecision, setLogFilterDecision] = useState<string>('all')

    const filteredLogs = logs.filter(l => {
        if (logFilterChannel  !== 'all' && l.channel  !== logFilterChannel)  return false
        if (logFilterDecision === 'errors'   ) return !!l.error
        if (logFilterDecision === 'feedback' ) return l.reviewedByOperator
        if (logFilterDecision !== 'all' && l.decision !== logFilterDecision) return false
        return true
    })

    const LogTab = () => (
        <div className="space-y-4">
            <InlineInfo>
                Что AI ответил и какие решения принял. 👍 или 👎 рядом с ответом
                помогает понять, где AI работает хорошо, а где нужно поправить.
                Кнопка <strong>«Почему AI так ответил?»</strong> на каждой записи
                раскрывает retrieval-trace и используемые знания.{' '}
                <a
                    href="/settings/integrations/ai-knowledge-help#m-why"
                    target="_blank"
                    rel="noopener"
                    className="text-[#3390EC] hover:underline"
                >
                    Подробнее →
                </a>
            </InlineInfo>

            {/* Простые фильтры — клиентские, по уже загруженной странице.
                Без bg-fill: серый текст-кнопки, выбранная подсвечена
                цветом и тонкой подложкой. Спокойнее чем сплошные pills. */}
            {logs.length > 0 && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
                    <span className="text-gray-400">Канал:</span>
                    {(['all', 'max', 'telegram', 'whatsapp'] as const).map(c => (
                        <button key={c} onClick={() => setLogFilterChannel(c)}
                            className={`transition-colors ${
                                logFilterChannel === c
                                    ? 'text-[#3390EC] font-medium'
                                    : 'text-gray-500 hover:text-[#111]'
                            }`}>
                            {c === 'all' ? 'все' : CHANNEL_LABELS[c]}
                        </button>
                    ))}
                    <span className="text-gray-400 ml-3">Решение:</span>
                    {([
                        { val: 'all',       label: 'все' },
                        { val: 'auto_reply',label: 'ответил сам' },
                        { val: 'escalate',  label: 'передал менеджеру' },
                        { val: 'errors',    label: 'с ошибками' },
                        { val: 'feedback',  label: 'с оценкой' },
                    ]).map(({ val, label }) => (
                        <button key={val} onClick={() => setLogFilterDecision(val)}
                            className={`transition-colors ${
                                logFilterDecision === val
                                    ? 'text-[#3390EC] font-medium'
                                    : 'text-gray-500 hover:text-[#111]'
                            }`}>
                            {label}
                        </button>
                    ))}
                </div>
            )}

            {logs.length === 0 && (
                <div className="text-center py-10 text-gray-500 text-[13px]">
                    <div className="font-medium text-[#111] mb-1">Пока ничего</div>
                    <div className="text-[12px]">{canEdit ? 'Когда AI начнёт отвечать в чатах, его решения появятся здесь.' : 'Когда AI начнёт отвечать в чатах, его решения появятся здесь.'}</div>
                </div>
            )}

            {logs.length > 0 && filteredLogs.length === 0 && (
                <div className="text-center py-6 text-gray-400 text-[12px]">
                    По фильтрам ничего не найдено.
                </div>
            )}

            {/* Список решений — flat divide-y вместо боксов. Раньше каждое
                решение было card'ом с rounded-xl border — выглядело как
                log-viewer. Теперь это «лента историй»: одно решение —
                одна строка-блок, тонкая граница снизу. */}
            {filteredLogs.length > 0 && (
                <div className="divide-y divide-[#F0F0F0] border-t border-[#F0F0F0]">
                    {filteredLogs.map(log => (
                        <div key={log.id} className="py-4 space-y-2">
                            {/* Заголовок строки: dot-маркер решения, текст
                                решения, канал, время. Технический %
                                спрятан в title-tooltip — он редко нужен. */}
                            <div className="flex items-baseline gap-2 text-[12px]">
                                {log.decision && (
                                    <span className="inline-flex items-baseline gap-1.5">
                                        <span className={`w-1.5 h-1.5 rounded-full ${DECISION_DOT_COLOR[log.decision] ?? 'bg-gray-300'}`} style={{ transform: 'translateY(-1px)' }} />
                                        <span className="font-medium text-[#111]">
                                            {DECISION_LABEL[log.decision] ?? log.decision}
                                        </span>
                                    </span>
                                )}
                                {log.channel && (
                                    <span className="text-gray-400">· {CHANNEL_LABELS[log.channel] ?? log.channel}</span>
                                )}
                                {log.confidence != null && (
                                    <span title={`Уверенность AI: ${(log.confidence * 100).toFixed(0)}%`}
                                          className="text-gray-300 cursor-help">· {(log.confidence * 100).toFixed(0)}%</span>
                                )}
                                <span className="ml-auto text-gray-400">{new Date(log.createdAt).toLocaleString('ru')}</span>
                            </div>
                            {log.generatedReply && (
                                <div className="text-[13px] text-[#111] leading-[1.5] line-clamp-3">
                                    {log.generatedReply}
                                </div>
                            )}
                            {log.error && (
                                <div className="text-[12px] text-red-500 flex items-center gap-1">
                                    <XCircle size={11} /> {log.error}
                                </div>
                            )}
                            {/* Feedback. Кнопки 👍/👎 видны всем — это
                                единственная легитимная функция менеджера. */}
                            {!log.reviewedByOperator && log.decision === 'auto_reply' && (
                                <div className="flex gap-3 pt-0.5">
                                    {(['good', 'bad'] as const).map(v => (
                                        <button key={v} onClick={async () => {
                                            await setOperatorVerdict(log.id, v)
                                            setLogs(prev => prev.map(l => l.id === log.id ? { ...l, reviewedByOperator: true, operatorVerdict: v } : l))
                                        }}
                                        title={v === 'good' ? 'AI ответил хорошо' : 'AI ответил плохо'}
                                        className={`text-[12px] transition-colors ${v === 'good' ? 'text-gray-500 hover:text-green-600' : 'text-gray-500 hover:text-red-500'}`}>
                                            {v === 'good' ? '👍 Хорошо' : '👎 Плохо'}
                                        </button>
                                    ))}
                                </div>
                            )}
                            {log.reviewedByOperator && (
                                <div className="text-[11px] text-gray-400">
                                    {log.operatorVerdict === 'good' ? '👍 оценено как хороший ответ' : log.operatorVerdict === 'bad' ? '👎 оценено как плохой ответ' : '✏️ исправлено'}
                                </div>
                            )}
                            {/* PR4: explainability link — открывает модал "Почему AI так ответил?" */}
                            <div className="pt-0.5">
                                <button
                                    onClick={() => openExplain(log.id)}
                                    className="text-[11px] text-gray-400 hover:text-[#3390EC] inline-flex items-center gap-1 transition-colors"
                                >
                                    <HelpCircle size={11} />
                                    Почему AI так ответил?
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    )

    // ─── Tabs навигация ───────────────────────────────────────────

    const ALL_TABS = [
        { key: 'sync',      label: 'База сообщений', icon: Database },
        { key: 'provider',  label: 'AI Провайдер',  icon: Zap },
        { key: 'rules',     label: 'Правила',        icon: Settings },
        { key: 'kb',        label: 'База знаний',    icon: BookOpen },
        // "Ядро знаний" — AI Knowledge Core (PR1 read-only).
        { key: 'knowledge', label: 'Ядро знаний',    icon: Library },
        { key: 'log',       label: 'Журнал',         icon: ClipboardList },
    ] as const
    // Менеджер видит только Журнал — все настроечные вкладки админ-only.
    const TABS = canEdit ? ALL_TABS : ALL_TABS.filter(t => t.key === 'log')

    return (
        <div className="flex flex-col h-full">
            {/* Toast */}
            {toast && (
                <div className="fixed top-4 right-4 z-50 bg-[#111] text-white text-[12px] font-medium px-4 py-2.5 rounded-xl shadow-lg animate-in fade-in slide-in-from-top-2 duration-200">
                    {toast}
                </div>
            )}

            {/* PR5: Runtime rollout checklist modal */}
            <RuntimeRolloutModal />

            {/* PR7.9: Reset Knowledge Core modal (3 modes + typed confirm) */}
            <ResetCoreModal />

            {/* PR5: Legacy KB → Knowledge Core migration modal */}
            {migrationOpen && (
                <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-16"
                     onClick={() => !migrationRunning && setMigrationOpen(false)}>
                    <div
                        className="bg-white rounded-lg shadow-xl w-full max-w-xl flex flex-col max-h-[85vh] overflow-hidden"
                        onClick={e => e.stopPropagation()}
                    >
                        <div className="px-6 py-4 border-b border-[#F0F0F0]">
                            <h2 className="text-[16px] font-semibold text-[#111]">Перенести базу знаний в Ядро</h2>
                            <p className="text-[12px] text-gray-500 mt-0.5">
                                Записи копируются как verified-факты. Сама база знаний не удаляется.
                            </p>
                        </div>
                        <div className="px-6 py-4 overflow-y-auto space-y-4">
                            {migrationLoading && (
                                <div className="flex items-center gap-2 text-[12px] text-gray-400 py-6">
                                    <Loader2 size={13} className="animate-spin" /> Считаем что переносить…
                                </div>
                            )}
                            {!migrationLoading && migrationPreview && !migrationResult && (
                                <div className="space-y-3 text-[13px] text-[#111]">
                                    <div className="rounded-md border border-[#E8E8E8] bg-[#FAFBFC] p-3">
                                        <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Сводка</div>
                                        <div className="space-y-0.5 text-[12px]">
                                            <div>Активных записей в базе: <strong>{migrationPreview.legacyTotalActive}</strong></div>
                                            <div>Уже перенесено: <strong>{migrationPreview.alreadyMigrated}</strong></div>
                                            <div>Будет перенесено сейчас: <strong className="text-[#3390EC]">{migrationPreview.toMigrate}</strong></div>
                                        </div>
                                    </div>
                                    {migrationPreview.bySection.length > 0 && (
                                        <div>
                                            <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Распределение по разделам</div>
                                            <ul className="space-y-0.5 text-[12px]">
                                                {migrationPreview.bySection.map(s => (
                                                    <li key={s.sectionSlug} className="flex items-center justify-between">
                                                        <span>{s.sectionTitle}</span>
                                                        <span className="text-gray-500">{s.count}</span>
                                                    </li>
                                                ))}
                                            </ul>
                                            <p className="text-[11px] text-gray-400 mt-2">
                                                Категории сопоставлены автоматически. После переноса вы можете переместить факты в другой раздел через карточку знания.
                                            </p>
                                        </div>
                                    )}
                                    {migrationPreview.toMigrate === 0 && (
                                        <div className="rounded-md border border-[#E8E8E8] bg-[#FAFBFC] p-3 text-[12px] text-gray-600">
                                            Все активные записи уже перенесены. Повторный запуск ничего не добавит.
                                        </div>
                                    )}
                                </div>
                            )}
                            {migrationResult && (
                                <div className="space-y-3 text-[13px]">
                                    <div className={`rounded-md border p-3 ${
                                        migrationResult.failed > 0
                                            ? 'border-[#FFE8B0] bg-[#FFFBED] text-[#8B6914]'
                                            : 'border-green-200 bg-green-50 text-green-800'
                                    }`}>
                                        <strong className="block mb-1">Готово</strong>
                                        Перенесено: {migrationResult.migrated} ·{' '}
                                        Пропущено: {migrationResult.skipped} ·{' '}
                                        С ошибкой: {migrationResult.failed}
                                    </div>
                                    {migrationResult.errors.length > 0 && (
                                        <div>
                                            <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Ошибки</div>
                                            <ul className="space-y-1 text-[12px] text-red-600">
                                                {migrationResult.errors.slice(0, 10).map((e, i) => (
                                                    <li key={i}>
                                                        <code className="text-[11px] bg-white px-1 rounded border border-[#E8E0C0]">{e.legacyId}</code> — {e.message}
                                                    </li>
                                                ))}
                                            </ul>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                        <div className="px-6 py-3 border-t border-[#F0F0F0] flex items-center justify-end gap-2">
                            <button
                                onClick={() => !migrationRunning && setMigrationOpen(false)}
                                disabled={migrationRunning}
                                className="h-9 px-4 rounded-md border border-[#E0E0E0] text-[13px] text-gray-600 hover:bg-[#F8F9FA] disabled:opacity-50"
                            >
                                {migrationResult ? 'Закрыть' : 'Отмена'}
                            </button>
                            {!migrationResult && migrationPreview && migrationPreview.toMigrate > 0 && (
                                <button
                                    onClick={runMigration}
                                    disabled={migrationRunning}
                                    className="h-9 px-4 rounded-md bg-[#3390EC] text-white text-[13px] font-medium hover:opacity-90 disabled:opacity-50 inline-flex items-center gap-1.5"
                                >
                                    {migrationRunning && <Loader2 size={13} className="animate-spin" />}
                                    Перенести {migrationPreview.toMigrate}
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* PR4: Explainability modal "Почему AI так ответил?" */}
            {explainOpen && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
                    onClick={() => !retryRunning && setExplainOpen(false)}
                >
                    <div onClick={e => e.stopPropagation()}
                         className="bg-white rounded-xl shadow-xl w-[680px] max-w-[96vw] max-h-[90vh] flex flex-col">
                        <div className="px-6 pt-5 pb-3 border-b border-[#F0F0F0]">
                            <h2 className="text-[17px] font-semibold text-[#111]">Почему AI так ответил?</h2>
                        </div>
                        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
                            {explainLoading || !explainBundle ? (
                                <div className="flex items-center gap-2 text-[12px] text-gray-400 py-8">
                                    <Loader2 size={13} className="animate-spin" /> Загружаем подробности…
                                </div>
                            ) : !explainBundle.decision ? (
                                <div className="text-[12px] text-gray-400 py-6">Решение не найдено.</div>
                            ) : (() => {
                                const bundle = explainBundle
                                const decision = bundle.decision!
                                // Group usages: used vs filtered (улучшение #2 — "что AI НЕ использовал")
                                const usedUsages = bundle.knowledgeUsages.filter(u => u.policyDecision === 'used')
                                const filteredUsages = bundle.knowledgeUsages.filter(u =>
                                    u.policyDecision && u.policyDecision.startsWith('filtered_')
                                )
                                return <>
                                    {/* Вопрос / ответ */}
                                    <div className="space-y-2">
                                        <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Что спросил клиент</div>
                                        <div className="bg-[#F8F9FA] rounded-lg px-3 py-2 text-[13px] text-[#111] whitespace-pre-wrap leading-relaxed">
                                            {bundle.userMessage?.content ?? '(сообщение не найдено)'}
                                        </div>
                                        <div className="flex items-baseline gap-2 pt-2">
                                            <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Что ответил AI</div>
                                            {decision.generatedReply && (
                                                <button
                                                    onClick={() => copyToClipboardSafe(decision.generatedReply!, 'Ответ скопирован')}
                                                    className="text-[10px] text-gray-400 hover:text-[#3390EC] inline-flex items-center gap-0.5"
                                                    title="Скопировать ответ"
                                                >
                                                    <ClipboardList size={9} /> копировать
                                                </button>
                                            )}
                                        </div>
                                        <div className="bg-[#F0F4FA] rounded-lg px-3 py-2 text-[13px] text-[#111] whitespace-pre-wrap leading-relaxed">
                                            {decision.generatedReply ?? (decision.escalated
                                                ? '(передано менеджеру, ответа клиенту не было)'
                                                : '(ответа нет)')}
                                        </div>
                                    </div>

                                    {/* Mode + policy */}
                                    <div>
                                        <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-2">Как AI принял решение</div>
                                        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12px] text-gray-600">
                                            <span><strong className="text-[#111]">Решение:</strong> {DECISION_HUMAN[decision.decision ?? ''] ?? decision.decision}</span>
                                            {decision.retrievalMode && (
                                                <span>· {RETRIEVAL_MODE_HUMAN[decision.retrievalMode] ?? decision.retrievalMode}</span>
                                            )}
                                        </div>
                                        {decision.escalationReason && (
                                            <div className="mt-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-[12px] text-amber-900 leading-relaxed">
                                                <strong>Почему не ответил сам:</strong> {ESCALATION_HUMAN[decision.escalationReason] ?? decision.escalationReason}
                                            </div>
                                        )}
                                        {decision.error && (
                                            <div className="mt-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-[12px] text-red-700">
                                                Ошибка: {decision.error}
                                            </div>
                                        )}
                                    </div>

                                    {/* Использованные знания */}
                                    <div>
                                        <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-2">
                                            Использованные знания ({usedUsages.length})
                                        </div>
                                        {usedUsages.length === 0 ? (
                                            <div className="text-[12px] text-gray-400 italic">
                                                Знания из ядра не использовались
                                                {decision.retrievalMode === 'legacy' && ' (старая база FAQ)'}.
                                            </div>
                                        ) : (
                                            <div className="space-y-2">
                                                {usedUsages.map(u => {
                                                    const it = u.item
                                                    if (!it) return <div key={u.id} className="text-[12px] text-gray-400 italic">Знание было удалено</div>
                                                    const changedAfter = new Date(it.updatedAt) > new Date(decision.createdAt)
                                                    return (
                                                        <div key={u.id} className="px-3 py-2 rounded-lg border border-[#3390EC]/40 bg-[#F0F4FA]">
                                                            <div className="flex items-baseline gap-2 flex-wrap mb-0.5">
                                                                <span className="text-[13px] font-semibold text-[#111]">{it.title}</span>
                                                                {it.isVerified && <span className="text-[10px] text-green-700">подтверждено</span>}
                                                                {it.safetyLevel === 'requires_human' && <span className="text-[10px] text-red-600">только менеджер</span>}
                                                                {it.safetyLevel === 'sensitive'      && <span className="text-[10px] text-amber-600">чувствительное</span>}
                                                                {it.conflictGroupId && <span className="text-[10px] text-amber-600">в конфликте</span>}
                                                                {it.status === 'superseded' && <span className="text-[10px] text-gray-400">заменено</span>}
                                                                {changedAfter && <span title="После этого ответа знание было изменено" className="text-[10px] text-[#3390EC]">изменено после ответа</span>}
                                                                {it.sectionTitle && <span className="text-[10px] text-gray-400 ml-auto">{it.sectionTitle}</span>}
                                                            </div>
                                                            <p className="text-[12px] text-gray-700 leading-relaxed">{it.canonicalStatement}</p>
                                                            <div className="flex items-baseline gap-2 mt-1 text-[10px] text-gray-500">
                                                                <span>{USAGE_REASON_HUMAN[u.policyDecision ?? ''] ?? 'обработано'}</span>
                                                                {it.sourceCount > 0 && <span>· {it.sourceCount} {plural(it.sourceCount,'источник','источника','источников')}</span>}
                                                                {it.uniqueManagerCount > 0 && <span>· {it.uniqueManagerCount} {plural(it.uniqueManagerCount,'менеджер','менеджера','менеджеров')}</span>}
                                                            </div>
                                                            <div className="flex gap-3 mt-2 text-[11px] flex-wrap">
                                                                <button onClick={() => copyToClipboardSafe(it.canonicalStatement, 'Формулировка скопирована')}
                                                                    className="text-gray-400 hover:text-[#3390EC] inline-flex items-center gap-0.5"
                                                                    title="Скопировать каноническую формулировку">
                                                                    <ClipboardList size={9} /> копировать формулировку
                                                                </button>
                                                                {canEdit && (
                                                                    <>
                                                                        <button onClick={() => jumpToKnowledgeItem(it.id, it.sectionId)}
                                                                            className="text-[#3390EC] hover:underline">
                                                                            Открыть в Ядре
                                                                        </button>
                                                                        <button onClick={() => {
                                                                            const ki: KnowledgeItem = {
                                                                                id: it.id, sectionId: it.sectionId,
                                                                                title: it.title, canonicalStatement: it.canonicalStatement,
                                                                                tags: it.tags, confidence: it.confidence,
                                                                                sourceCount: it.sourceCount, uniqueManagerCount: it.uniqueManagerCount,
                                                                                status: it.status as KnowledgeItem['status'],
                                                                                isActive: it.isActive,
                                                                                safetyLevel: it.safetyLevel as KnowledgeItem['safetyLevel'],
                                                                                supersededByItemId: it.supersededByItemId,
                                                                                conflictGroupId: it.conflictGroupId,
                                                                                isVerified: it.isVerified,
                                                                                verifiedBy: null, verifiedAt: null,
                                                                                createdBy: null, lastUsedAt: null,
                                                                                createdAt: it.updatedAt, updatedAt: it.updatedAt,
                                                                            }
                                                                            setExplainOpen(false)
                                                                            openEditFor(ki)
                                                                        }} className="text-gray-500 hover:text-[#111]">
                                                                            Редактировать
                                                                        </button>
                                                                    </>
                                                                )}
                                                            </div>
                                                        </div>
                                                    )
                                                })}
                                            </div>
                                        )}
                                    </div>

                                    {/* Что AI сознательно НЕ использовал (улучшение #2) */}
                                    {filteredUsages.length > 0 && (
                                        <div>
                                            <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-2">
                                                Что AI не использовал ({filteredUsages.length})
                                            </div>
                                            <div className="space-y-1.5">
                                                {filteredUsages.map(u => {
                                                    const it = u.item
                                                    if (!it) return null
                                                    return (
                                                        <div key={u.id} className="px-3 py-2 rounded-lg border border-[#E8E8E8] bg-white opacity-70">
                                                            <div className="flex items-baseline gap-2 flex-wrap mb-0.5">
                                                                <span className="text-[12px] font-medium text-gray-700">{it.title}</span>
                                                                {it.sectionTitle && <span className="text-[10px] text-gray-400 ml-auto">{it.sectionTitle}</span>}
                                                            </div>
                                                            <div className="text-[11px] text-gray-500">
                                                                {USAGE_REASON_HUMAN[u.policyDecision ?? ''] ?? u.policyDecision}
                                                            </div>
                                                        </div>
                                                    )
                                                })}
                                            </div>
                                        </div>
                                    )}

                                    {/* Sources (Admin only) */}
                                    {canEdit && bundle.sources.length > 0 && (
                                        <div>
                                            <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-2">
                                                Источники ({bundle.sources.length})
                                            </div>
                                            <div className="space-y-1.5">
                                                {bundle.sources.slice(0, 10).map(s => (
                                                    <div key={s.id} className="px-3 py-2 border-l-2 border-[#E8E8E8] bg-[#F8F9FA] text-[12px]">
                                                        <p className="text-[#111] leading-relaxed">{s.excerpt}</p>
                                                        <div className="text-[10px] text-gray-400 mt-0.5 flex flex-wrap gap-x-2">
                                                            {s.originType === 'manual_entry'
                                                                ? <span>создано вручную</span>
                                                                : <>
                                                                    {s.channel && <span>{CHANNEL_LABELS[s.channel] ?? s.channel}</span>}
                                                                    {s.occurredAt && <span>· {new Date(s.occurredAt).toLocaleDateString('ru')}</span>}
                                                                  </>}
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    {/* Knowledge changes after answer */}
                                    {bundle.auditAfter.length > 0 && (
                                        <div>
                                            <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-2">
                                                Что изменилось после этого ответа
                                            </div>
                                            <div className="space-y-1">
                                                {bundle.auditAfter.map(a => (
                                                    <div key={a.id} className="text-[12px] text-gray-600 flex items-baseline gap-2">
                                                        <span className="w-1.5 h-1.5 rounded-full bg-[#3390EC] shrink-0 mt-1.5" />
                                                        <span>{AUDIT_AFTER_HUMAN[a.action] ?? a.action}</span>
                                                        <span className="text-[10px] text-gray-400">{new Date(a.createdAt).toLocaleString('ru')}</span>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    {/* Retry preview (Admin only) */}
                                    {canEdit && (
                                        <div>
                                            <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-2">
                                                Прогнать заново
                                            </div>
                                            {!retryPreview && !retryRunning && (
                                                <button onClick={runRetryPreview}
                                                    className="h-[32px] px-3 inline-flex items-center gap-1.5 rounded-md border border-[#E0E0E0] bg-white hover:border-[#3390EC] hover:text-[#3390EC] text-[12px] text-gray-600 transition-colors">
                                                    <RefreshCw size={12} /> Что AI ответил бы сейчас (без отправки)
                                                </button>
                                            )}
                                            {retryRunning && (
                                                <div className="flex items-center gap-2 text-[12px] text-gray-500">
                                                    <Loader2 size={12} className="animate-spin" /> Прогоняем...
                                                </div>
                                            )}
                                            {retryPreview && (
                                                <div className="space-y-2">
                                                    {retryPreview.errorMessage && (
                                                        <div className="px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-[12px] text-red-700">
                                                            {retryPreview.errorMessage}
                                                        </div>
                                                    )}
                                                    {retryPreview.generatedReply && (
                                                        <div className="px-3 py-2 bg-[#F0FAF4] border border-green-200 rounded-lg text-[12px] text-[#111] whitespace-pre-wrap leading-relaxed">
                                                            <div className="text-[10px] text-green-700 mb-1 uppercase tracking-wide">Новый ответ (превью, не отправлено)</div>
                                                            {retryPreview.generatedReply}
                                                        </div>
                                                    )}
                                                    {retryPreview.policyType !== 'answer' && (
                                                        <div className="px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-[12px] text-amber-900">
                                                            Сейчас AI {retryPreview.policyType === 'escalate' ? 'передал бы менеджеру' : 'не нашёл бы знаний'}
                                                            {retryPreview.escalationReason && `: ${ESCALATION_HUMAN[retryPreview.escalationReason] ?? retryPreview.escalationReason}`}
                                                        </div>
                                                    )}
                                                    <button onClick={runRetryPreview}
                                                        className="text-[11px] text-gray-400 hover:text-[#3390EC] inline-flex items-center gap-1">
                                                        <RefreshCw size={10} /> Прогнать ещё раз
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    )}

                                    {/* Shadow vs runtime compare */}
                                    {decision.shadowRetrievalSummary && decision.retrievalMode === 'shadow' && (
                                        <div>
                                            <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-2">
                                                Что бы сделало новое ядро
                                            </div>
                                            <div className="text-[12px] text-gray-600 leading-relaxed">
                                                Решение в фоне: <strong className="text-[#111]">
                                                    {(() => {
                                                        const s = decision.shadowRetrievalSummary as { decision?: string; escalationReason?: string | null }
                                                        return DECISION_HUMAN[s?.decision ?? ''] ?? s?.decision ?? '—'
                                                    })()}
                                                </strong>
                                                {(() => {
                                                    const s = decision.shadowRetrievalSummary as { decision?: string; escalationReason?: string | null }
                                                    if (s?.escalationReason) {
                                                        return <> · {ESCALATION_HUMAN[s.escalationReason] ?? s.escalationReason}</>
                                                    }
                                                    return null
                                                })()}
                                            </div>
                                        </div>
                                    )}

                                    {/* Advanced/debug accordion (Admin only) — улучшение #3: durations */}
                                    {canEdit && (
                                        <details className="group border-t border-[#F0F0F0] pt-3"
                                                 open={advancedOpen}
                                                 onToggle={e => setAdvancedOpen((e.target as HTMLDetailsElement).open)}>
                                            <summary className="cursor-pointer select-none text-[11px] font-semibold text-gray-500 uppercase tracking-wide flex items-center gap-1">
                                                <ChevronDown size={11} className="transition-transform group-open:rotate-180" />
                                                Технические детали
                                            </summary>
                                            <div className="mt-3 space-y-1 text-[11px] text-gray-500 font-mono">
                                                <div>id: {decision.id}</div>
                                                {decision.knowledgeRuntimeVersion && (
                                                    <div>версия: {decision.knowledgeRuntimeVersion}</div>
                                                )}
                                                {decision.selectedModel && (
                                                    <div>модель: {decision.selectedModel}</div>
                                                )}
                                                {decision.detectedIntent && (
                                                    <div>intent: {decision.detectedIntent}</div>
                                                )}
                                                {decision.confidence != null && (
                                                    <div>confidence: {(decision.confidence * 100).toFixed(0)}%</div>
                                                )}
                                                {retryPreview && (
                                                    <div className="pt-2 text-gray-400">retry preview durations:</div>
                                                )}
                                                {retryPreview && (
                                                    <div className="ml-3">
                                                        prefilter={retryPreview.trace.prefilterDurationMs}ms ·
                                                        rerank={retryPreview.trace.rerankDurationMs ?? '—'}ms ·
                                                        generator={retryPreview.trace.generatorDurationMs ?? '—'}ms ·
                                                        total={retryPreview.trace.totalDurationMs}ms
                                                    </div>
                                                )}
                                                <div className="pt-2 text-gray-400">scores per item:</div>
                                                {bundle.knowledgeUsages.map(u => (
                                                    <div key={u.id} className="ml-3">
                                                        {u.itemId.slice(0, 12)} · retrieval={u.retrievalScore?.toFixed(3) ?? 'null'} · rerank={u.rerankScore?.toFixed(3) ?? 'null'} · {u.policyDecision ?? '—'}
                                                    </div>
                                                ))}
                                            </div>
                                        </details>
                                    )}
                                </>
                            })()}
                        </div>
                        <div className="flex justify-end px-6 py-3 border-t border-[#F0F0F0]">
                            <button onClick={() => setExplainOpen(false)} disabled={retryRunning}
                                className="h-[36px] px-4 text-[13px] text-gray-600 hover:text-[#111] rounded-md disabled:opacity-50">
                                Закрыть
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <RuntimeStatus />

            {/* Tabs — спокойный underline (1px вместо 2px), active-tab
                подсвечен цветом и тонкой линией под собой. Без жирной
                рамы под всем рядом, чтобы tabs не выглядели как Material
                AppBar. */}
            <div className="flex gap-1 mb-6 border-b border-[#F0F0F0]">
                {TABS.map(({ key, label, icon: Icon }) => (
                    <button
                        key={key}
                        onClick={() => setTab(key)}
                        className={`flex items-center gap-1.5 px-3 h-[34px] text-[13px] -mb-px border-b transition-colors ${
                            tab === key
                                ? 'border-[#3390EC] text-[#3390EC] font-medium'
                                : 'border-transparent text-gray-500 hover:text-[#111]'
                        }`}
                    >
                        <Icon size={13} />
                        {label}
                    </button>
                ))}
            </div>

            {/* Content. Менеджер видит только Журнал — даже если в state
                окажется другая вкладка (например, из старого URL),
                рендерим LogTab — это безопасный fallback. */}
            <div className="flex-1 overflow-y-auto pr-1">
                {!canEdit ? <LogTab /> : (
                    <>
                        {tab === 'sync'     && <SyncTab />}
                        {tab === 'provider' && <ProviderTab />}
                        {tab === 'rules'    && <RulesTab />}
                        {tab === 'kb'        && <KbTab />}
                        {tab === 'knowledge' && <KnowledgeTab />}
                        {tab === 'log'       && <LogTab />}
                    </>
                )}
            </div>
        </div>
    )
}

// ─── SupersedePickerModal — выбор замены для temporal supersession ─
//
// Top-level компонент (а не closure внутри AiControlCenterClient),
// потому что у него собственный useEffect загрузки items. Принимает
// oldItem и callbacks. Загружает items той же секции, фильтрует
// superseded/archived/себя; на выбранном вызывает onPick.

function SupersedePickerModal({
    oldItem, onClose, onPick,
}: {
    oldItem: KnowledgeItem
    onClose: () => void
    onPick: (newItemId: string) => void
}) {
    const [items, setItems] = useState<KnowledgeItem[]>([])
    const [loading, setLoading] = useState(true)
    const [search, setSearch] = useState('')

    useEffect(() => {
        let cancelled = false
        setLoading(true)
        listItemsBySection(oldItem.sectionId).then(arr => {
            if (cancelled) return
            const filtered = (arr as KnowledgeItem[]).filter(i =>
                i.id !== oldItem.id &&
                i.status !== 'superseded' &&
                i.isActive
            )
            setItems(filtered)
        }).finally(() => { if (!cancelled) setLoading(false) })
        return () => { cancelled = true }
    }, [oldItem])

    const filteredItems = search.trim()
        ? items.filter(i =>
            i.title.toLowerCase().includes(search.toLowerCase()) ||
            i.canonicalStatement.toLowerCase().includes(search.toLowerCase())
        )
        : items

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
            <div onClick={e => e.stopPropagation()}
                 className="bg-white rounded-xl shadow-xl p-6 w-[540px] max-w-[94vw] max-h-[80vh] flex flex-col">
                <div>
                    <h2 className="text-[17px] font-semibold text-[#111]">Заменить новым знанием</h2>
                    <p className="text-[12px] text-gray-500 mt-1">
                        Старое знание уйдёт в архив со ссылкой «заменено». Это
                        не конфликт — это обновление правила во времени.
                    </p>
                </div>
                <div className="my-3 px-3 py-2 border-l-2 border-[#E8E8E8]">
                    <div className="text-[12px] font-semibold text-[#111]">{oldItem.title}</div>
                    <p className="text-[11px] text-gray-500 line-clamp-2">{oldItem.canonicalStatement}</p>
                </div>
                <input
                    placeholder="Найти знание-замену..."
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    className="w-full h-[34px] border border-[#E0E0E0] rounded-lg px-3 text-[13px] outline-none focus:border-[#3390EC]"
                />
                <div className="flex-1 overflow-y-auto mt-3 -mx-2">
                    {loading ? (
                        <div className="text-center text-[12px] text-gray-400 py-6">Загружаем…</div>
                    ) : filteredItems.length === 0 ? (
                        <div className="text-center text-[12px] text-gray-400 py-6">
                            В этом разделе нет других active-знаний.
                        </div>
                    ) : (
                        <div className="divide-y divide-[#F0F0F0]">
                            {filteredItems.map(i => (
                                <button key={i.id}
                                    onClick={() => onPick(i.id)}
                                    className="w-full text-left px-3 py-2 hover:bg-[#F8F9FA] transition-colors">
                                    <div className="text-[13px] font-semibold text-[#111]">{i.title}</div>
                                    <p className="text-[11px] text-gray-500 line-clamp-2">{i.canonicalStatement}</p>
                                </button>
                            ))}
                        </div>
                    )}
                </div>
                <div className="flex justify-end pt-3">
                    <button onClick={onClose}
                        className="h-[36px] px-4 text-[13px] text-gray-600 hover:text-[#111] rounded-md">
                        Отмена
                    </button>
                </div>
            </div>
        </div>
    )
}

// ─── ProfilesEditor — стили общения AI-агента ────────────────────
//
// Chip-табы профилей сверху (как в /settings/integrations/ai-call-scenarios),
// под ними — редактор открытого профиля (4 textarea). Активный
// помечается зелёным; смена активного — кнопкой «Сделать активным»
// в шапке открытого профиля. Удалить можно только не-default профиль.
//
// Каждое изменение сохраняется на сервер по «Сохранить стиль» — это
// один профиль за раз, без массового save (как у Rules).

interface ProfilesEditorProps {
    profiles: AiProfileData[]
    setProfiles: React.Dispatch<React.SetStateAction<AiProfileData[]>>
    activeProfileId: string | null
    setActiveProfileId: (id: string | null) => void
    canEdit: boolean
    showToast: (msg: string) => void
}

function ProfilesEditor({
    profiles, setProfiles, activeProfileId, setActiveProfileId, canEdit, showToast,
}: ProfilesEditorProps) {
    // Выбранный для редактирования — по умолчанию активный, иначе первый.
    const [viewingId, setViewingId] = useState<string>(
        activeProfileId ?? profiles[0]?.id ?? ''
    )
    const [activating, setActivating] = useState<string | null>(null)
    const [creating, setCreating] = useState(false)

    const viewing = profiles.find(p => p.id === viewingId) ?? profiles[0] ?? null

    async function handleSetActive(id: string) {
        setActivating(id)
        try {
            await setActiveAiProfile(id)
            setActiveProfileId(id)
            showToast('Стиль активирован')
        } catch (e: any) {
            showToast('Ошибка: ' + e.message)
        } finally {
            setActivating(null)
        }
    }

    async function handleCreate() {
        setCreating(true)
        try {
            const created = await createAiProfile({
                name: 'Новый стиль',
                description: '',
                promptRole: '',
                promptTone: '',
                promptAllowed: '',
                promptForbidden: '',
            })
            setProfiles(prev => [...prev, created as AiProfileData])
            setViewingId(created.id)
            showToast('Стиль создан')
        } catch (e: any) {
            showToast('Ошибка: ' + e.message)
        } finally {
            setCreating(false)
        }
    }

    return (
        <div className="space-y-3 pt-1">
            <div className="flex items-center justify-between">
                <h4 className="text-[14px] font-semibold text-[#111]">Стиль общения</h4>
                <span className="text-[11px] text-gray-400">Можно держать несколько, переключать активный</span>
            </div>

            {/* Chip-табы — по аналогии с проектами в /ai-call-scenarios.
                Активный помечен зелёным, выбранный (открытый) — синим. */}
            <div className="flex flex-wrap gap-2">
                {profiles.map(p => {
                    const isViewing = p.id === viewingId
                    const isActive = p.id === activeProfileId
                    const base = 'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium border transition-colors'
                    const style = (() => {
                        if (isViewing && isActive) return 'bg-green-600 text-white border-green-600'
                        if (isViewing)             return 'bg-[#3390EC] text-white border-[#3390EC]'
                        if (isActive)              return 'border-green-500/50 bg-green-50 text-green-900 hover:bg-green-100'
                        return 'border-[#E0E0E0] bg-white text-gray-600 hover:border-[#3390EC]'
                    })()
                    return (
                        <button
                            key={p.id}
                            type="button"
                            onClick={() => setViewingId(p.id)}
                            className={`${base} ${style}`}
                            title={isActive ? 'Активный стиль' : undefined}
                        >
                            {isActive && (
                                <CheckCircle2 className={`h-3 w-3 ${isViewing ? 'text-white' : 'text-green-600'}`} />
                            )}
                            {p.name}
                        </button>
                    )
                })}
                {canEdit && (
                    <button
                        type="button"
                        onClick={handleCreate}
                        disabled={creating}
                        className="inline-flex items-center gap-1 rounded-full border border-dashed border-[#E0E0E0] px-3 py-1.5 text-[12px] text-gray-500 hover:border-[#3390EC] hover:text-[#3390EC] disabled:opacity-50"
                    >
                        {creating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
                        Новый стиль
                    </button>
                )}
            </div>

            {!viewing ? (
                <div className="rounded-md border border-dashed border-[#E0E0E0] bg-[#FAFAFA] p-6 text-center text-[13px] text-gray-500">
                    Стилей нет. Создай первый кнопкой выше.
                </div>
            ) : (
                <ProfileForm
                    key={viewing.id}
                    profile={viewing}
                    isActive={viewing.id === activeProfileId}
                    activating={activating === viewing.id}
                    canEdit={canEdit}
                    onSetActive={() => handleSetActive(viewing.id)}
                    onSaved={(updated) => {
                        setProfiles(prev => prev.map(p => p.id === updated.id ? updated : p))
                        showToast('Стиль сохранён')
                    }}
                    onDeleted={(id) => {
                        setProfiles(prev => prev.filter(p => p.id !== id))
                        if (activeProfileId === id) setActiveProfileId(null)
                        if (viewingId === id) {
                            const next = profiles.find(p => p.id !== id)
                            setViewingId(next?.id ?? '')
                        }
                        showToast('Стиль удалён')
                    }}
                    showToast={showToast}
                />
            )}
        </div>
    )
}

interface ProfileFormProps {
    profile: AiProfileData
    isActive: boolean
    activating: boolean
    canEdit: boolean
    onSetActive: () => void
    onSaved: (updated: AiProfileData) => void
    onDeleted: (id: string) => void
    showToast: (msg: string) => void
}

function ProfileForm({
    profile, isActive, activating, canEdit, onSetActive, onSaved, onDeleted, showToast,
}: ProfileFormProps) {
    const [name, setName] = useState(profile.name)
    const [description, setDescription] = useState(profile.description ?? '')
    const [promptRole, setPromptRole] = useState(profile.promptRole ?? '')
    const [promptTone, setPromptTone] = useState(profile.promptTone ?? '')
    const [promptAllowed, setPromptAllowed] = useState(profile.promptAllowed ?? '')
    const [promptForbidden, setPromptForbidden] = useState(profile.promptForbidden ?? '')
    const [saving, setSaving] = useState(false)
    const [deleting, setDeleting] = useState(false)

    const dirty =
        name !== profile.name ||
        (description || '') !== (profile.description || '') ||
        (promptRole || '') !== (profile.promptRole || '') ||
        (promptTone || '') !== (profile.promptTone || '') ||
        (promptAllowed || '') !== (profile.promptAllowed || '') ||
        (promptForbidden || '') !== (profile.promptForbidden || '')

    async function handleSave() {
        if (!name.trim()) { showToast('Имя стиля обязательно'); return }
        setSaving(true)
        try {
            const updated = await updateAiProfile(profile.id, {
                name, description, promptRole, promptTone, promptAllowed, promptForbidden,
            })
            onSaved(updated as AiProfileData)
        } catch (e: any) {
            showToast('Ошибка: ' + e.message)
        } finally {
            setSaving(false)
        }
    }

    async function handleDelete() {
        if (!confirm(`Удалить стиль «${profile.name}»?`)) return
        setDeleting(true)
        try {
            await deleteAiProfile(profile.id)
            onDeleted(profile.id)
        } catch (e: any) {
            showToast('Ошибка: ' + e.message)
            setDeleting(false)
        }
    }

    return (
        <div className="rounded-md border border-[#E8E8E8] bg-white p-4">
            {/* Шапка: имя на всю ширину, справа bagde активности.
                Раньше использовалось `flex items-start` + `space-y-2`
                для двух input'ов — на проде верстка ехала (вероятно
                глобальный CSS навязывает min-height для input'ов и
                space-y перестаёт перекрывать его). Сейчас — явный
                grid из трёх блоков с собственным `mb-3`. */}
            <div className="flex items-center gap-3 mb-2">
                <input
                    value={name}
                    onChange={e => setName(e.target.value)}
                    disabled={!canEdit}
                    placeholder="Название стиля"
                    className="flex-1 min-w-0 border border-[#E0E0E0] rounded-md px-3 py-2 text-[14px] font-medium text-[#111] outline-none focus:border-[#3390EC] disabled:bg-[#FAFAFA]"
                />
                <div className="shrink-0">
                    {isActive ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2.5 py-1 text-[11px] font-medium text-green-700 whitespace-nowrap">
                            <CheckCircle2 className="h-3 w-3" />
                            активный
                        </span>
                    ) : canEdit ? (
                        <button
                            type="button"
                            onClick={onSetActive}
                            disabled={activating}
                            title="Сделать этот стиль активным — AI начнёт говорить им"
                            className="inline-flex items-center gap-1 rounded-full border border-green-500/50 px-2.5 py-1 text-[11px] font-medium text-green-700 hover:bg-green-50 disabled:opacity-50 whitespace-nowrap"
                        >
                            {activating
                                ? <Loader2 className="h-3 w-3 animate-spin" />
                                : <CheckCircle2 className="h-3 w-3" />}
                            Сделать активным
                        </button>
                    ) : null}
                </div>
            </div>
            <input
                value={description}
                onChange={e => setDescription(e.target.value)}
                disabled={!canEdit}
                placeholder="Короткое описание — где этот стиль уместен"
                className="block w-full border border-[#E0E0E0] rounded-md px-3 py-1.5 text-[12px] text-gray-600 outline-none focus:border-[#3390EC] disabled:bg-[#FAFAFA] mb-4"
            />

            {/* 4 текстовых блока — Роль/Тон/Разрешено/Запрещено.
                Явный `mb-3` на каждом — раньше использовался `space-y-3`
                на parent, который мог конфликтовать с шапкой. */}
            {[
                { key: 'promptRole',     value: promptRole,     set: setPromptRole,     label: 'Роль',       hint: 'Кто отвечает: должность, компания. Один абзац.',         placeholder: 'Ассистент таксопарка NashAvtoPark' },
                { key: 'promptTone',     value: promptTone,     set: setPromptTone,     label: 'Тон',        hint: 'Как разговаривать: на ты/на вы, длина, эмодзи, шутки.', placeholder: 'Дружелюбно, на ты, коротко, можно лёгкая шутка' },
                { key: 'promptAllowed',  value: promptAllowed,  set: setPromptAllowed,  label: 'Разрешено',  hint: 'Что AI может делать без согласования с менеджером.',     placeholder: 'Отвечать на FAQ, объяснять тарифы, брать контакт водителя' },
                { key: 'promptForbidden',value: promptForbidden,set: setPromptForbidden,label: 'Запрещено',  hint: 'Что нельзя ни при каких условиях.',                       placeholder: 'Гарантировать доход, спорить, обещать "0% комиссии"' },
            ].map(({ key, value, set, label, hint, placeholder }) => (
                <div key={key} className="mb-3">
                    <label className="text-[12px] text-gray-500 mb-1 flex items-center gap-1.5">
                        {label}
                        <Hint text={hint} />
                    </label>
                    <textarea
                        rows={2}
                        value={value}
                        onChange={e => set(e.target.value)}
                        disabled={!canEdit}
                        placeholder={placeholder}
                        className="block w-full border border-[#E0E0E0] rounded-md px-3 py-2 text-[12px] outline-none focus:border-[#3390EC] resize-none placeholder:text-gray-300 disabled:bg-[#FAFAFA]"
                    />
                </div>
            ))}

            {/* Футер — Сохранить + Удалить (для не-default) + подсказка
                для системного. flex-wrap чтобы текст «Системный стиль…»
                переходил на новую строку, а не накладывался на кнопку. */}
            {canEdit && (
                <div className="flex flex-wrap items-center gap-3 pt-2 mt-2 border-t border-[#F0F0F0]">
                    <button
                        type="button"
                        onClick={handleSave}
                        disabled={saving || !dirty}
                        className="inline-flex items-center gap-1.5 rounded-md bg-[#3390EC] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[#2B7FD4] disabled:opacity-50"
                    >
                        {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                        Сохранить стиль
                    </button>
                    {!profile.isDefault && (
                        <button
                            type="button"
                            onClick={handleDelete}
                            disabled={deleting}
                            className="inline-flex items-center gap-1.5 rounded-md border border-[#E0E0E0] px-3 py-1.5 text-[12px] font-medium text-red-500 hover:bg-red-50 disabled:opacity-50"
                        >
                            {deleting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                            Удалить
                        </button>
                    )}
                    {profile.isDefault && (
                        <span className="text-[11px] text-gray-400 basis-full sm:basis-auto">
                            Системный стиль — удалить нельзя, только править.
                        </span>
                    )}
                </div>
            )}
        </div>
    )
}
