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
    saveAiConfig, testAiConnection,
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
    bulkVerifyItems, bulkArchiveDraftsInSection,
    type ExplainabilityBundle,
    type KnowledgeReadinessBundle,
    type LegacyMigrationPreview, type LegacyMigrationResult,
    type BulkActionResult,
    type RetryPreviewResult,
    type AiProfileData,
    type KnowledgeSection, type KnowledgeItem, type KnowledgeStats,
    type ExtractionScope,
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
    legacy:  'Legacy — старая база FAQ',
    shadow:  'Shadow — новое ядро работало в фоне',
    runtime: 'Runtime — ответ из ядра знаний',
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
    // Подгружаем items при смене секции / подвкладки (Ядро ↔ Архив).
    // В "Источники" items не нужны — там показывается список jobs.
    useEffect(() => {
        if (!selectedSectionId) { setKnowledgeItems([]); return }
        if (knowledgeSubtab === 'sources') return
        let cancelled = false
        setKnowledgeItemsLoading(true)
        listItemsBySection(selectedSectionId, {
            includeArchived: knowledgeSubtab === 'archive',
        })
            .then(arr => { if (!cancelled) setKnowledgeItems(arr as KnowledgeItem[]) })
            .catch(() => { if (!cancelled) setKnowledgeItems([]) })
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
            Promise.all([
                listKnowledgeSections(),
                getKnowledgeStatsAction(),
                listExtractionJobs(10),
            ]).then(([s, st, jobs]) => {
                setSections(s as KnowledgeSection[])
                setKnowledgeStats(st as KnowledgeStats)
                setExtractionJobs(jobs)
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

    async function refreshReadiness() {
        try {
            const r = await getKnowledgeReadinessForUi()
            setReadiness(r as KnowledgeReadinessBundle)
        } catch { /* silent */ }
    }

    // На mount fetch runtime state + recent traces.
    useEffect(() => {
        let cancelled = false
        Promise.all([
            getKnowledgeRuntimeStateForUi(),
            listRecentRetrievalTraces(30),
        ]).then(([state, traces]) => {
            if (cancelled) return
            setRuntimeState(state)
            setRetrievalTraces(traces as RetrievalTrace[])
        }).catch(() => { /* silent */ })
        return () => { cancelled = true }
    }, [])

    async function refreshCurrentSection() {
        if (!selectedSectionId) return
        const arr = await listItemsBySection(selectedSectionId, {
            includeArchived: knowledgeSubtab === 'archive',
        })
        setKnowledgeItems(arr as KnowledgeItem[])
        const stats = await getKnowledgeStatsAction()
        setKnowledgeStats(stats as KnowledgeStats)
        const secs = await listKnowledgeSections()
        setSections(secs as KnowledgeSection[])
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

    async function handleStartExtraction() {
        setExtractionStarting(true)
        try {
            if (extractionTier !== initialExtractionTier) {
                await saveExtractionQualityTier(extractionTier)
            }
            const scope: ExtractionScope = { mode: extractionScopeMode }
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

    const handleStartImport = async () => {
        setPreflightState('checking')
        setPreflightError(null)

        try {
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
                        setPreflightError(`${CHANNEL_LABELS[ch] ?? ch}: ${h.error ?? 'скрапер не отвечает'}`)
                    }
                    return
                }
            }

            // 2. Всё ок — запускаем джобу
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
                Синхронизация загружает историю чатов из MAX / Telegram / WhatsApp,
                чтобы AI понимал контекст диалогов. Запускается один раз на старте;
                переписка остаётся в CRM, наружу ничего не отправляется.
            </InlineInfo>
            {/* Индикатор состояния */}
            <div className={`border rounded-xl p-4 transition-colors ${
                preflightState === 'unavailable' || preflightState === 'needs_auth'
                    ? 'bg-red-50/40 border-red-200'
                    : (importStatus === 'queued' || importStatus === 'running') && transportStatus === 'offline'
                    ? 'bg-red-50/40 border-red-200'
                    : preflightState === 'checking' || transportStatus === 'unknown' || transportStatus === 'initializing'
                    ? 'bg-blue-50/30 border-blue-200'
                    : importStatus === 'queued' || importStatus === 'running'
                    ? 'bg-yellow-50/50 border-yellow-200'
                    : 'bg-[#F8F9FA] border-[#E8E8E8]'
            }`}>
                <div className="flex items-center gap-3">
                    <StatusDot status={
                        preflightState === 'unavailable' ? 'error' :
                        preflightState === 'needs_auth' ? 'error' :
                        preflightState === 'checking' ? 'queued' :
                        (importStatus === 'queued' || importStatus === 'running') && transportStatus === 'offline' ? 'error' :
                        (importStatus === 'queued' || importStatus === 'running') && transportStatus === 'initializing' ? 'queued' :
                        importStatus
                    } />
                    <span className="text-[13px] font-semibold text-[#111]">Синхронизация истории</span>
                    {(preflightState === 'checking' || ((importStatus === 'queued' || importStatus === 'running') && transportStatus !== 'offline')) && (
                        <RefreshCw size={13} className={`animate-spin ${transportStatus === 'offline' ? 'text-red-500' : 'text-yellow-600'}`} />
                    )}
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ml-auto ${
                        preflightState === 'unavailable' || preflightState === 'needs_auth' ? 'bg-red-50 text-red-700' :
                        preflightState === 'checking' ? 'bg-blue-50 text-blue-700' :
                        (importStatus === 'queued' || importStatus === 'running') && transportStatus === 'offline' ? 'bg-red-50 text-red-700' :
                        (importStatus === 'queued' || importStatus === 'running') && transportStatus === 'initializing' ? 'bg-blue-50 text-blue-700' :
                        importStatus === 'completed' ? 'bg-green-50 text-green-700' :
                        importStatus === 'running' || importStatus === 'queued' ? 'bg-yellow-50 text-yellow-700' :
                        importStatus === 'partial' ? 'bg-orange-50 text-orange-700' :
                        importStatus === 'failed' ? 'bg-red-50 text-red-700' : 'bg-gray-100 text-gray-600'
                    }`}>
                        {preflightState === 'checking' ? 'Проверка…' :
                         preflightState === 'unavailable' ? 'Сервис не запущен' :
                         preflightState === 'needs_auth' ? 'Сервис ещё запускается' :
                         (importStatus === 'queued' || importStatus === 'running') && transportStatus === 'offline' ? 'Сервис не запущен' :
                         (importStatus === 'queued' || importStatus === 'running') && transportStatus === 'initializing' ? 'Запускается…' :
                         (importStatus === 'queued' || importStatus === 'running') && transportStatus === 'unknown' ? 'Проверка…' :
                         importStatus === 'completed' ? 'Актуально' :
                         importStatus === 'running' ? 'Идёт импорт' :
                         importStatus === 'queued' ? 'В очереди' :
                         importStatus === 'partial' ? 'Частично' :
                         importStatus === 'failed' ? 'Ошибка' : 'Не запускался'}
                    </span>
                </div>

                {/* ── Preflight: проверка транспорта ── */}
                {preflightState === 'checking' && (
                    <div className="mt-3 flex items-center gap-2 text-[12px] text-blue-700">
                        <RefreshCw size={12} className="animate-spin shrink-0" />
                        <span>Проверяем подключение к {importChannels.map(c => CHANNEL_LABELS[c] ?? c).join(', ')}…</span>
                    </div>
                )}

                {/* ── Preflight: транспорт недоступен ── */}
                {(preflightState === 'unavailable' || preflightState === 'needs_auth') && (
                    <div className="mt-3 space-y-2">
                        <div className="flex items-start gap-2 text-[12px] text-red-700">
                            <XCircle size={14} className="shrink-0 mt-0.5" />
                            <div>
                                <p className="font-semibold">
                                    {preflightState === 'needs_auth'
                                        ? 'Сервис ещё запускается'
                                        : 'Сервис мессенджера не отвечает — импорт не начат'}
                                </p>
                                {preflightError && (
                                    <p className="text-red-500 text-[11px] mt-0.5">{preflightError}</p>
                                )}
                                <p className="text-gray-500 text-[11px] mt-1">
                                    {preflightState === 'needs_auth'
                                        ? 'Подождите 10-30 секунд или войдите в аккаунт мессенджера, затем повторите.'
                                        : 'Включите MAX Web Scraper (иконка в трее или start-all.bat) и повторите.'}
                                </p>
                            </div>
                        </div>
                        <button
                            onClick={handleRetryPreflight}
                            className="flex items-center gap-1.5 h-[26px] px-3 text-[11px] font-semibold text-gray-700 bg-white border border-[#E0E0E0] rounded-lg hover:border-[#3390EC] hover:text-[#3390EC] transition-colors"
                        >
                            <RefreshCw size={11} />
                            Повторить проверку
                        </button>
                    </div>
                )}

                {/* Live-прогресс / статус транспорта — только при активном задании */}
                {preflightState === 'idle' && lastJob && (lastJob.status === 'queued' || lastJob.status === 'running') && (
                    <div className="mt-3">
                        {/* Состояние: транспорт офлайн */}
                        {transportStatus === 'offline' && (
                            <div className="space-y-2">
                                <div className="flex items-start gap-2 text-[12px] text-red-700">
                                    <XCircle size={14} className="shrink-0 mt-0.5" />
                                    <div>
                                        <p className="font-semibold">MAX не отвечает — импорт приостановлен</p>
                                        <p className="text-gray-500 text-[11px] mt-1">
                                            Сервис не запущен или потерял соединение. Включите MAX Web Scraper — импорт продолжится автоматически.
                                        </p>
                                    </div>
                                </div>
                                <div className="flex gap-2">
                                    <button
                                        onClick={async () => {
                                            setTransportStatus('unknown')
                                            transportFailCount.current = 0
                                            const health = await checkScraperHealth(['max'])
                                            if (health.max?.ok) {
                                                setTransportStatus('online')
                                            } else if (health.max?.status === 'initializing') {
                                                setTransportStatus('initializing')
                                            } else {
                                                setTransportStatus('offline')
                                            }
                                        }}
                                        className="flex items-center gap-1.5 h-[26px] px-3 text-[11px] font-semibold text-gray-700 bg-white border border-[#E0E0E0] rounded-lg hover:border-[#3390EC] hover:text-[#3390EC] transition-colors"
                                    >
                                        <RefreshCw size={11} />
                                        Проверить снова
                                    </button>
                                    <button
                                        onClick={async () => {
                                            await cancelImportJob(lastJob.id)
                                            const fresh = await getAllImportJobs(10)
                                            setImportJobs(fresh)
                                            setTransportStatus('unknown')
                                        }}
                                        className="flex items-center gap-1.5 h-[26px] px-3 text-[11px] font-semibold text-red-600 bg-white border border-red-200 rounded-lg hover:bg-red-50 transition-colors"
                                    >
                                        <Square size={11} />
                                        Отменить импорт
                                    </button>
                                </div>
                            </div>
                        )}

                        {/* Состояние: транспорт инициализируется */}
                        {transportStatus === 'initializing' && (
                            <div className="flex items-center gap-2 text-[12px] text-yellow-700">
                                <RefreshCw size={12} className="animate-spin shrink-0" />
                                <div>
                                    <p className="font-semibold">Скрапер запускается, ожидаем готовности…</p>
                                    <p className="text-gray-500 text-[11px] mt-0.5">Обычно это занимает 10–30 секунд</p>
                                </div>
                            </div>
                        )}

                        {/* Состояние: проверяем транспорт (первая загрузка) */}
                        {transportStatus === 'unknown' && (
                            <div className="flex items-center gap-2 text-[12px] text-blue-700">
                                <RefreshCw size={12} className="animate-spin shrink-0" />
                                <span>Проверяем подключение к {lastJob.channels.map(c => CHANNEL_LABELS[c] ?? c).join(', ')}…</span>
                            </div>
                        )}

                        {/* Состояние: транспорт онлайн — показываем реальный прогресс */}
                        {transportStatus === 'online' && (
                            <>
                                {/* Анимированная полоса */}
                                <div className="w-full h-1.5 bg-yellow-100 rounded-full overflow-hidden mb-3">
                                    <div className="h-full bg-yellow-400 rounded-full animate-pulse" style={{
                                        width: '100%',
                                        animation: 'progress-indeterminate 2s ease-in-out infinite',
                                    }} />
                                </div>
                                <style>{`
                                    @keyframes progress-indeterminate {
                                        0% { transform: translateX(-100%); width: 40%; }
                                        50% { transform: translateX(50%); width: 60%; }
                                        100% { transform: translateX(200%); width: 40%; }
                                    }
                                `}</style>
                                <div className="flex items-center gap-4 text-[12px]">
                                    <span className="text-yellow-700 font-semibold flex items-center gap-1.5">
                                        <RefreshCw size={12} className="animate-spin" />
                                        Импорт выполняется…
                                    </span>
                                    <span className="text-gray-500">
                                        {lastJob.channels.map(c => CHANNEL_LABELS[c] ?? c).join(', ')}
                                    </span>
                                    {elapsedSec !== null && (
                                        <span className="text-gray-400 text-[11px] ml-auto font-mono">
                                            {Math.floor(elapsedSec / 60)}:{String(elapsedSec % 60).padStart(2, '0')}
                                        </span>
                                    )}
                                </div>
                                {/* Живые счётчики от скрапера */}
                                <div className="grid grid-cols-3 gap-3 mt-3">
                                    {[
                                        { label: 'Сообщений', value: liveProgress?.messagesImported ?? lastJob.messagesImported },
                                        { label: 'Чатов',     value: liveProgress?.chatsScanned ?? lastJob.chatsScanned },
                                        { label: 'Контактов', value: liveProgress?.contactsFound ?? lastJob.contactsFound },
                                    ].map(s => (
                                        <div key={s.label} title={STAT_HINT[s.label]} className="bg-white/70 rounded-lg p-2.5 text-center cursor-help">
                                            <div className="text-[18px] font-bold text-yellow-700 tabular-nums">{s.value.toLocaleString()}</div>
                                            <div className="text-[10px] text-gray-500">{s.label}</div>
                                        </div>
                                    ))}
                                </div>
                            </>
                        )}
                    </div>
                )}

                {/* Факт последнего импорта (завершённого) */}
                {lastJob && (lastJob.status === 'completed' || lastJob.status === 'failed') && (
                    <>
                        <div className="grid grid-cols-3 gap-3 mt-3">
                            {[
                                { label: 'Сообщений', value: lastJob.messagesImported },
                                { label: 'Чатов',     value: lastJob.chatsScanned },
                                { label: 'Контактов', value: lastJob.contactsFound },
                            ].map(s => (
                                <div key={s.label} title={STAT_HINT[s.label]} className="bg-white rounded-lg p-2.5 text-center cursor-help">
                                    <div className="text-[18px] font-bold text-[#111]">{s.value.toLocaleString()}</div>
                                    <div className="text-[10px] text-gray-500">{s.label}</div>
                                </div>
                            ))}
                        </div>
                        <div className="flex flex-wrap items-center gap-3 mt-2 text-[11px] text-gray-500">
                            <span>Каналы: <b className="text-gray-700">{lastJob.channels.map(c => CHANNEL_LABELS[c] ?? c).join(', ')}</b></span>
                            {lastJob.resultType && (
                                <span className={`font-bold px-2 py-0.5 rounded-full text-[10px] ${
                                    lastJob.resultType === 'full' ? 'bg-blue-50 text-blue-700' :
                                    lastJob.resultType === 'partial' ? 'bg-yellow-50 text-yellow-700' :
                                    lastJob.resultType === 'failed'  ? 'bg-red-50 text-red-700' : 'bg-gray-100 text-gray-600'
                                }`}>{lastJob.resultType === 'full' ? 'Вся доступная история' : lastJob.resultType === 'partial' ? 'Частичный' : lastJob.resultType}</span>
                            )}
                            {lastJob.coveredPeriodFrom && lastJob.coveredPeriodTo && (
                                <span>Период: <b className="text-gray-700">{new Date(lastJob.coveredPeriodFrom).toLocaleDateString('ru')} — {new Date(lastJob.coveredPeriodTo).toLocaleDateString('ru')}</b></span>
                            )}
                            {lastJob.startedAt && lastJob.finishedAt && (
                                <span>Время: {Math.round((new Date(lastJob.finishedAt).getTime() - new Date(lastJob.startedAt).getTime()) / 1000)}с</span>
                            )}
                        </div>
                    </>
                )}
            </div>

            {/* Настройки импорта — без border/bg, чтобы не создавать
                «коробку в коробке» после status-блока выше. Заголовок
                плюс отступ работают как разделитель. */}
            <div className="space-y-3 pt-1">
                <h4 className="text-[14px] font-semibold text-[#111]">Загрузить ещё историю</h4>

                {/* Каналы */}
                <div>
                    <label className="text-[12px] text-gray-500 mb-1.5 block">Мессенджеры</label>
                    <div className="flex gap-2">
                        {(['max', 'telegram', 'whatsapp'] as const).map(ch => (
                            <button
                                key={ch}
                                onClick={() => setImportChannels(prev =>
                                    prev.includes(ch) ? prev.filter(c => c !== ch) : [...prev, ch]
                                )}
                                className={`px-3 h-[28px] rounded-lg text-[11px] font-semibold border transition-colors ${
                                    importChannels.includes(ch)
                                        ? 'bg-[#3390EC] text-white border-[#3390EC]'
                                        : 'bg-white text-gray-600 border-[#E0E0E0] hover:border-[#3390EC]'
                                }`}
                            >
                                {CHANNEL_LABELS[ch]}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Режим */}
                <div>
                    <label className="text-[12px] text-gray-500 mb-1.5 block">Режим импорта</label>
                    <div className="space-y-1.5">
                        {[
                            { val: 'from_connection_time', label: 'С момента подключения', hint: 'Только сообщения, появившиеся после того, как мессенджер был подключён к CRM.' },
                            { val: 'available_history',    label: 'Доступная история',     hint: 'Всё, что мессенджер отдаёт, — обычно последние ~3 месяца. Самый полный вариант.' },
                            { val: 'last_n_days',          label: 'За последние N дней',   hint: 'Точный диапазон. Удобно для пере-синхронизации без полного импорта.' },
                        ].map(opt => (
                            <label key={opt.val} className="flex items-center gap-2 cursor-pointer">
                                <input
                                    type="radio"
                                    name="importMode"
                                    value={opt.val}
                                    checked={importMode === opt.val}
                                    onChange={() => setImportMode(opt.val)}
                                    className="accent-[#3390EC]"
                                />
                                <span className="text-[12px] text-[#111]">{opt.label}</span>
                                <Hint text={opt.hint} />
                                {opt.val === 'last_n_days' && importMode === 'last_n_days' && (
                                    <input
                                        type="number"
                                        value={importDays}
                                        onChange={e => setImportDays(Number(e.target.value))}
                                        min={1} max={365}
                                        className="w-[60px] h-[24px] border border-[#E0E0E0] rounded px-2 text-[12px] outline-none focus:border-[#3390EC]"
                                    />
                                )}
                            </label>
                        ))}
                    </div>
                </div>

                <button
                    onClick={handleStartImport}
                    disabled={importLoading || importChannels.length === 0}
                    className="h-[32px] px-4 bg-[#3390EC] text-white text-[12px] font-semibold rounded-lg hover:bg-[#2B7FD4] disabled:opacity-50 transition-colors flex items-center gap-1.5"
                >
                    <Play size={11} />
                    {importLoading ? 'Запускаем...' : 'Запустить импорт'}
                </button>
            </div>

            {/* История заданий — flat-список с divide-y, без внешней
                рамки. Раньше была вложенная card с заголовком + border;
                теперь это просто секция страницы. */}
            {importJobs.length > 0 && (
                <div className="pt-1">
                    <h4 className="text-[13px] font-semibold text-[#111] mb-2">Прошлые загрузки</h4>
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
                                {/* Верхняя строка: каналы, режим, статус, дата */}
                                <div className="flex items-center gap-3 text-[12px]">
                                    {(job.status === 'queued' || job.status === 'running')
                                        ? <RefreshCw size={12} className="animate-spin text-yellow-500 shrink-0" />
                                        : <StatusDot status={job.status} />
                                    }
                                    <span className="font-medium text-gray-700">{job.channels.map(c => CHANNEL_LABELS[c] ?? c).join(', ')}</span>
                                    <span className="text-gray-400">{job.mode === 'available_history' ? 'Вся доступная история' : job.mode === 'from_connection_time' ? 'С подключения' : job.mode === 'last_n_days' ? `${(job as any).daysBack ?? 'N'} дней` : job.mode}</span>
                                    {isRepeat && <span className="text-[10px] text-gray-400 italic">Повторная синхронизация</span>}
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

    const handleTestConnection = async () => {
        if (!apiKey.trim()) { showToast('Введите API ключ'); return }
        setTestStatus('testing')
        const result = await testAiConnection(config.provider, apiKey, config.classificationModel)
        if (result.ok) {
            setTestStatus('ok')
            setConfig(c => ({ ...c, connectionStatus: 'ok', lastConnectionCheckAt: new Date().toISOString() }))
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
            // Только если текущие модели всё ещё дефолтные ДРУГОГО провайдера —
            // подменяем на дефолты нового. Если админ уже руками задал имена,
            // не трогаем (не хотим терять его выбор).
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
        setTestStatus('idle')
    }

    const providerDef = PROVIDER_DEFAULTS[config.provider] ?? PROVIDER_DEFAULTS.anthropic

    return (
        <div className="space-y-5">
            <InlineInfo>
                AI работает через внешнюю модель: Anthropic (Claude) или OpenAI (GPT).
                Claude лучше понимает русский, GPT дешевле и быстрее на коротких ответах.
            </InlineInfo>
            <div className="space-y-4 pt-1">
                <div className="flex gap-2">
                    {['anthropic', 'openai'].map(p => (
                        <button
                            key={p}
                            onClick={() => switchProvider(p)}
                            className={`px-4 h-[30px] rounded-lg text-[12px] font-semibold border transition-colors ${
                                config.provider === p
                                    ? 'bg-[#3390EC] text-white border-[#3390EC]'
                                    : 'bg-white text-gray-600 border-[#E0E0E0] hover:border-[#3390EC]'
                            }`}
                        >
                            {p === 'anthropic' ? 'Anthropic' : 'OpenAI'}
                        </button>
                    ))}
                </div>

                <div>
                    {/* Статус-точка рядом с label: «живой» ключ виден
                        сразу, без клика «Проверить» и без отдельной
                        строки текста ниже.

                        Effective status — приоритет:
                          1) testStatus (только что нажали «Проверить»)
                          2) config.connectionStatus (последняя проверка
                             из БД, set'ится в saveAiConfig() при успехе)
                          3) есть apiKeyEncrypted без статуса → unchecked

                        После любого изменения input testStatus → 'idle'
                        и connectionStatus сбрасывается, потому что новый
                        ключ заведомо не проверен. */}
                    {(() => {
                        const effective = (() => {
                            if (testStatus === 'testing') return 'testing'
                            if (testStatus === 'ok')      return 'ok'
                            if (testStatus === 'error')   return 'error'
                            if (config.connectionStatus === 'ok')    return 'ok'
                            if (config.connectionStatus === 'error') return 'error'
                            // Есть ключ, но не проверен ни разу:
                            if (apiKey.trim() || config.apiKeyEncrypted) return 'unchecked'
                            return 'empty'
                        })()
                        const dot: Record<string, { color: string; label: string; titleSuffix?: string }> = {
                            ok:        { color: 'bg-green-500',              label: 'ключ активен' },
                            error:     { color: 'bg-red-500',                label: 'ключ не работает', titleSuffix: testError },
                            testing:   { color: 'bg-yellow-400 animate-pulse', label: 'проверяем…' },
                            unchecked: { color: 'bg-gray-300',               label: 'ключ не проверен' },
                            empty:     { color: '',                          label: '' },
                        }
                        const d = dot[effective]
                        return (
                            <label className="text-[12px] text-gray-500 mb-1 flex items-center gap-2">
                                <span>API ключ{' '}
                                    {config.provider === 'anthropic' ? (
                                        <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer" className="text-[#3390EC] hover:underline">— где взять</a>
                                    ) : (
                                        <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer" className="text-[#3390EC] hover:underline">— где взять</a>
                                    )}
                                </span>
                                {d.label && (
                                    <span
                                        title={d.titleSuffix ? `${d.label}: ${d.titleSuffix}` : d.label}
                                        className={`ml-auto inline-flex items-center gap-1.5 text-[11px] ${
                                            effective === 'ok'    ? 'text-green-600'
                                          : effective === 'error' ? 'text-red-500'
                                          : effective === 'testing' ? 'text-yellow-700'
                                          : 'text-gray-400'
                                        }`}
                                    >
                                        <span className={`w-2 h-2 rounded-full ${d.color}`} />
                                        {d.label}
                                    </span>
                                )}
                            </label>
                        )
                    })()}
                    <div className="flex gap-2">
                        <input
                            type="password"
                            value={apiKey}
                            onChange={e => {
                                setApiKey(e.target.value)
                                setTestStatus('idle')
                                // Сбрасываем statusDot — новый ключ
                                // заведомо ещё не проверен.
                                if (config.connectionStatus) {
                                    setConfig(c => ({ ...c, connectionStatus: null }))
                                }
                            }}
                            placeholder={config.apiKeyEncrypted ? '••••••••••••••••' : providerDef.keyPlaceholder}
                            className="flex-1 h-[32px] border border-[#E0E0E0] rounded-lg px-3 text-[12px] outline-none focus:border-[#3390EC] font-mono"
                        />
                        <button
                            onClick={handleTestConnection}
                            disabled={testStatus === 'testing'}
                            className="h-[32px] px-3 bg-gray-100 text-gray-700 text-[11px] font-semibold rounded-lg hover:bg-gray-200 disabled:opacity-50 transition-colors"
                        >
                            {testStatus === 'testing' ? 'Проверка...' : 'Проверить'}
                        </button>
                    </div>
                    {/* Расшифровка ошибки — точка наверху уже сообщает
                        «не работает», но текст ошибки от провайдера
                        полезен (401 / 403 / wrong model / etc). */}
                    {testStatus === 'error' && testError && (
                        <div className="flex items-center gap-1 mt-1.5 text-[11px] text-red-500">
                            <XCircle size={11} /> {testError}
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

                {config.lastConnectionCheckAt && (
                    <div className="text-[10px] text-gray-400">
                        Последняя проверка: {new Date(config.lastConnectionCheckAt).toLocaleString('ru')}
                        {' · '}
                        Статус: <span className={config.connectionStatus === 'ok' ? 'text-green-600' : 'text-red-500'}>{config.connectionStatus ?? '—'}</span>
                    </div>
                )}

                <button
                    onClick={handleSaveProvider}
                    disabled={providerSaving}
                    className="h-[32px] px-4 bg-[#3390EC] text-white text-[12px] font-semibold rounded-lg hover:bg-[#2B7FD4] disabled:opacity-50 transition-colors flex items-center gap-1.5"
                >
                    <Save size={11} />
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
                            <span className="font-medium text-[#111]">Legacy записи</span>
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
    // готовности и объяснением что runtime контролируется env-флагом.
    const RuntimeModePill = ({ state }: { state: typeof runtimeState }) => {
        const cfg =
            state.mode === 'runtime' ? { bg: 'bg-green-100',  txt: 'text-green-700', label: 'Runtime' } :
            state.mode === 'shadow'  ? { bg: 'bg-amber-100',  txt: 'text-amber-700', label: 'Shadow' } :
                                       { bg: 'bg-gray-100',   txt: 'text-gray-500',  label: 'Legacy' }
        const title =
            state.mode === 'runtime' ? 'AI отвечает по новому ядру знаний. Нажмите для checklist готовности.' :
            state.mode === 'shadow'  ? 'Ядро работает в параллель — клиенту отвечает старый pipeline. Нажмите для checklist.' :
                                       'Knowledge Core не подключён к ответам AI. Нажмите для checklist готовности.'
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
                        title="Сводный статус готовности — наихудший из checklist'а"
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
                    Отдельная строка, ещё более компактная. Показывается
                    только если есть данные за 7 дней. */}
                {hasHealth && (
                    <div className="flex items-center gap-3 flex-wrap px-3 py-1 text-[11px] text-gray-500">
                        <span className="uppercase tracking-wide text-[10px] text-gray-400">Здоровье · 7д:</span>
                        {h.escalationPct != null && (
                            <span title={`Доля решений где AI передал диалог менеджеру (${h.decisionsBase} за 7 дней)`}>
                                эскалация <strong className={h.escalationPct > 0.65 ? 'text-red-600' : h.escalationPct > 0.4 ? 'text-amber-600' : 'text-[#111]'}>{pct(h.escalationPct)}</strong>
                            </span>
                        )}
                        {h.noMatchPct != null && (
                            <>
                                <span className="text-gray-300">·</span>
                                <span title={`Решений где retriever не нашёл подходящих знаний (${h.decisionsBase} за 7 дней)`}>
                                    нет ответа <strong className="text-[#111]">{pct(h.noMatchPct)}</strong>
                                </span>
                            </>
                        )}
                        {h.verifiedUsagePct != null && (
                            <>
                                <span className="text-gray-300">·</span>
                                <span title={`Доля used-знаний которые подтверждены (${h.usageBase} usage logs за 7 дней)`}>
                                    из подтверждённых <strong className={h.verifiedUsagePct >= 0.6 ? 'text-green-700' : 'text-[#111]'}>{pct(h.verifiedUsagePct)}</strong>
                                </span>
                            </>
                        )}
                        {h.shadowRuntimeMismatchPct != null && (
                            <>
                                <span className="text-gray-300">·</span>
                                <span title="Доля shadow trace где Knowledge Core решил иначе чем actual decision. Меньше = ближе к runtime-ready.">
                                    shadow≠actual <strong className={h.shadowRuntimeMismatchPct > 0.3 ? 'text-amber-600' : 'text-[#111]'}>{pct(h.shadowRuntimeMismatchPct)}</strong>
                                </span>
                            </>
                        )}
                    </div>
                )}
            </div>
        )
    }

    // PR5: rollout-checklist модал. Объясняет что runtime управляется
    // env-флагом (не UI-switch), показывает 5 checks + текущие env-флаги.
    // НЕ позволяет включить runtime — это conscious deployment-action.
    const RuntimeRolloutModal = () => {
        if (!rolloutOpen) return null
        const r = readiness
        const checkIcon = (status: 'ok' | 'warn' | 'fail') =>
            status === 'ok' ? <span className="text-green-600">●</span> :
            status === 'warn' ? <span className="text-amber-600">●</span> :
                                <span className="text-red-600">●</span>
        return (
            <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-16" onClick={() => setRolloutOpen(false)}>
                <div
                    className="bg-white rounded-lg shadow-xl w-full max-w-2xl flex flex-col max-h-[85vh] overflow-hidden"
                    onClick={e => e.stopPropagation()}
                >
                    <div className="px-6 py-4 border-b border-[#F0F0F0] flex items-center justify-between">
                        <div>
                            <h2 className="text-[16px] font-semibold text-[#111]">Готовность к запуску в runtime</h2>
                            <p className="text-[12px] text-gray-500 mt-0.5">
                                Сводный статус и checklist перед переводом AI на ответы из ядра.
                            </p>
                        </div>
                        <button
                            onClick={() => setRolloutOpen(false)}
                            className="text-gray-400 hover:text-[#111] text-[20px] leading-none"
                            aria-label="Закрыть"
                        >×</button>
                    </div>

                    <div className="px-6 py-4 overflow-y-auto space-y-5">
                        {/* Текущий режим */}
                        <div className="rounded-md border border-[#E8E8E8] bg-[#FAFBFC] p-3">
                            <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Текущий режим</div>
                            <div className="flex items-center gap-2">
                                <RuntimeModePill state={runtimeState} />
                                <span className="text-[13px] text-[#111]">
                                    {runtimeState.mode === 'runtime' && 'AI отвечает из ядра знаний'}
                                    {runtimeState.mode === 'shadow'  && 'Ядро работает в фоне (legacy KB отвечает клиенту)'}
                                    {runtimeState.mode === 'legacy'  && 'Ядро не подключено к ответам'}
                                </span>
                            </div>
                            <div className="text-[11px] text-gray-500 mt-2">
                                Shadow: <code className="bg-white px-1 rounded border border-[#E8E8E8]">AI_KNOWLEDGE_SHADOW_MODE</code> = {runtimeState.shadowOn ? '1' : '0'}<br/>
                                Runtime: <code className="bg-white px-1 rounded border border-[#E8E8E8]">AI_KNOWLEDGE_RUNTIME_ENABLED</code> = {runtimeState.runtimeOn ? '1' : '0'}
                            </div>
                        </div>

                        {/* Checklist */}
                        <div>
                            <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-2">Готовность ядра</div>
                            <ul className="space-y-2">
                                {r.checks.map(ch => (
                                    <li key={ch.id} className="flex items-start gap-2 text-[13px]">
                                        <span className="mt-[2px] text-[14px] leading-none">{checkIcon(ch.status)}</span>
                                        <div>
                                            <div className="font-medium text-[#111]">{ch.label}</div>
                                            <div className="text-[12px] text-gray-500">{ch.detail}</div>
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        </div>

                        {/* Activity 7d */}
                        <div>
                            <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-2">Активность за 7 дней</div>
                            <div className="grid grid-cols-2 gap-2 text-[12px]">
                                <Stat label="Всего решений" value={r.activity7d.decisionsTotal} />
                                <Stat label="Shadow-trace" value={r.activity7d.shadowDecisions} />
                                <Stat label="Передано менеджеру" value={r.activity7d.escalated} />
                                <Stat label="Без подходящих знаний" value={r.activity7d.noMatch} />
                            </div>
                        </div>

                        {/* Explanation */}
                        <div className="rounded-md border border-[#FFE8B0] bg-[#FFFBED] p-3 text-[12px] text-[#8B6914] leading-relaxed">
                            <strong className="block mb-1 text-[#8B6914]">Runtime включается осознанно</strong>
                            Это не UI-переключатель. После того как checklist «зелёный»,
                            установите переменную окружения <code className="bg-white px-1 rounded border border-[#E8E0C0]">AI_KNOWLEDGE_RUNTIME_ENABLED=1</code>
                            в конфиге сервера и перезапустите CRM. До перезапуска ничего не поменяется
                            — клиентам по-прежнему отвечает legacy KB. Это страховка
                            от случайного флипа кнопкой.
                        </div>
                    </div>

                    <div className="px-6 py-3 border-t border-[#F0F0F0] flex items-center justify-between gap-2">
                        <a
                            href="/settings/integrations/ai-knowledge-help#a-runtime"
                            target="_blank"
                            rel="noopener"
                            className="text-[12px] text-[#3390EC] hover:underline"
                        >
                            Открыть инструкцию по runtime →
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
            safety_block:    'safety-фильтр',
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
                        <span className="text-[10px] text-amber-600">· shadow</span>
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
        return (
            <div className="border-t border-[#F0F0F0] pt-4 space-y-6">
                {/* Sub-section 1: Извлечения (PR2) */}
                <div>
                    <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-2">
                        Сбор ядра из истории
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
                                        {j.scope?.mode && (
                                            <span className="text-[11px] text-gray-400">· scope: {j.scope.mode}</span>
                                        )}
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
                                    {Object.keys(p).length > 0 && (
                                        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-gray-500">
                                            {p.pairsBuilt != null && <span>{p.pairsBuilt} пар</span>}
                                            {p.itemsCreated != null && <span>· {p.itemsCreated} новых знаний</span>}
                                            {p.itemsMerged != null && p.itemsMerged > 0 && <span>· {p.itemsMerged} объединено</span>}
                                            {p.itemsAsDraft != null && p.itemsAsDraft > 0 && <span>· {p.itemsAsDraft} черновиков</span>}
                                            {p.conflictsDetected != null && p.conflictsDetected > 0 && (
                                                <span className="text-amber-600">· {p.conflictsDetected} конфликтов</span>
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

                {/* Sub-section 2: Активность ответов (PR3 shadow/runtime) */}
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
                        <strong>Shadow mode</strong> — retriever работает параллельно,
                        ответ клиенту даёт legacy KB (наблюдение перед runtime).
                        {' '}<strong>Runtime</strong> — generator получает только
                        подтверждённые факты из ядра. Управляется env:
                        <code className="mx-1 text-[10px]">AI_KNOWLEDGE_SHADOW_MODE</code>
                        и <code className="text-[10px]">AI_KNOWLEDGE_RUNTIME_ENABLED</code>.
                        Кликните по pill в шапке — увидите checklist готовности и
                        текущие значения.{' '}
                        <a
                            href="/settings/integrations/ai-knowledge-help#a-shadow"
                            target="_blank"
                            rel="noopener"
                            className="text-[#3390EC] hover:underline"
                        >
                            Что это значит?
                        </a>
                    </div>
                </div>
            </div>
        )
    }

    const KnowledgeTab = () => {
        const selectedSection = sections.find(s => s.id === selectedSectionId) ?? null
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

                {/* PR5: operational readiness row */}
                <KnowledgeReadinessRow />

                {/* Под-табы + disabled "Собрать ядро" */}
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
                    {activeExtractionJob && (activeExtractionJob.status === 'queued' || activeExtractionJob.status === 'running') ? (
                        <div className="h-[28px] px-3 inline-flex items-center gap-1.5 rounded-lg bg-[#3390EC]/10 text-[#3390EC] text-[11px] font-semibold">
                            <Loader2 size={11} className="animate-spin" />
                            {activeExtractionJob.status === 'queued' ? 'В очереди' : 'Идёт сбор'}
                            {activeExtractionJob.progress?.pairsProcessed != null && activeExtractionJob.progress?.pairsBuilt != null && activeExtractionJob.progress.pairsBuilt > 0 && (
                                <span className="text-gray-500 font-normal">
                                    · {activeExtractionJob.progress.pairsProcessed}/{activeExtractionJob.progress.pairsBuilt}
                                </span>
                            )}
                        </div>
                    ) : (() => {
                        // UX-фикс: блокируем кнопку если AI provider не настроен.
                        const noKey = !config.apiKeyEncrypted || (config.apiKeyEncrypted as string).trim() === ''
                        const disabledReason = !canEdit
                            ? 'Доступно только Администратору'
                            : noKey
                                ? 'Сначала настройте AI Провайдер (вкладка слева) — добавьте API ключ'
                                : 'Запустить сбор ядра знаний из истории переписок'
                        return (
                            <button
                                onClick={() => canEdit && !noKey && setExtractionModalOpen(true)}
                                disabled={!canEdit || noKey}
                                title={disabledReason}
                                className="h-[28px] px-3 inline-flex items-center gap-1.5 rounded-lg bg-[#3390EC] text-white text-[11px] font-semibold hover:bg-[#2B7FD4] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            >
                                <Sparkles size={11} />
                                Собрать ядро
                            </button>
                        )
                    })()}
                </div>

                {/* Сводка по ядру */}
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[11px] text-gray-400">
                    <span>{knowledgeStats.activeSections} {plural(knowledgeStats.activeSections,'раздел','раздела','разделов')}</span>
                    <span>·</span>
                    <span>{knowledgeStats.activeItems} {plural(knowledgeStats.activeItems,'знание','знания','знаний')}</span>
                    <span>·</span>
                    <span>{knowledgeStats.totalSources} {plural(knowledgeStats.totalSources,'источник','источника','источников')}</span>
                    {knowledgeStats.draftItems > 0 && (
                        <>
                            <span>·</span>
                            <span className="text-gray-500">{knowledgeStats.draftItems} на проверке</span>
                        </>
                    )}
                    {knowledgeStats.conflictingItems > 0 && (
                        <>
                            <span>·</span>
                            <span className="text-amber-600">{knowledgeStats.conflictingItems} в конфликте</span>
                        </>
                    )}
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
                         className="bg-white rounded-xl shadow-xl p-6 w-[440px] max-w-[94vw] space-y-4">
                        <div>
                            <h2 className="text-[17px] font-semibold text-[#111]">Сбор ядра знаний</h2>
                            <p className="text-[12px] text-gray-500 mt-1 leading-relaxed">
                                AI проанализирует импортированную историю переписок
                                и обновит ядро. Не влияет на ответы клиентам.
                            </p>
                        </div>
                        <div>
                            <label className="text-[11px] text-gray-500 mb-1.5 block">Что анализировать</label>
                            <div className="flex flex-col gap-1.5">
                                {([
                                    { v: 'last_30d', label: 'Последние 30 дней',  hint: 'быстро, частичный обзор' },
                                    { v: 'last_90d', label: 'Последние 90 дней',  hint: 'рекомендуется для первой сборки' },
                                    { v: 'all',      label: 'Всю доступную историю', hint: 'дольше, максимум знаний' },
                                ] as const).map(opt => (
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
                                            <div className="text-[13px] font-medium text-[#111]">{opt.label}</div>
                                            <div className="text-[11px] text-gray-500">{opt.hint}</div>
                                        </div>
                                    </label>
                                ))}
                            </div>
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
                                Запустить
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
        { key: 'sync',      label: 'Синхронизация', icon: RefreshCw },
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
