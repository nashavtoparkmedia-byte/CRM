'use client'

import { useState, useEffect, useRef, useTransition } from 'react'
import {
    Bot, Database, Settings, BookOpen, ClipboardList,
    Play, Pause, CheckCircle2, XCircle, AlertCircle,
    Plus, Trash2, Save, RefreshCw, ChevronDown, ChevronUp,
    Zap, MessageSquare, Phone, Send, Square, X, HelpCircle,
    Loader2,
} from 'lucide-react'
import {
    saveAiConfig, testAiConnection,
    getKnowledgeBase, createKnowledgeEntry, updateKnowledgeEntry, deleteKnowledgeEntry,
    getDecisionLogs, setOperatorVerdict,
    createImportJob, getAllImportJobs, cancelImportJob, deleteImportJob,
    getAiRuntimeStats, checkScraperHealth,
    createAiProfile, updateAiProfile, deleteAiProfile, setActiveAiProfile,
    type AiProfileData,
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
    canEdit,
}: Props) {
    // Менеджеру открываем сразу Журнал — это единственная вкладка, где он
    // что-то делает. Админ/Руководитель — начинают с Синхронизации, как и
    // раньше.
    const [tab, setTab] = useState<'sync' | 'provider' | 'rules' | 'kb' | 'log'>(canEdit ? 'sync' : 'log')
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
                    <label className="text-[12px] text-gray-500 block mb-1">
                        API ключ{' '}
                        {config.provider === 'anthropic' ? (
                            <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer" className="text-[#3390EC] hover:underline">— где взять</a>
                        ) : (
                            <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer" className="text-[#3390EC] hover:underline">— где взять</a>
                        )}
                    </label>
                    <div className="flex gap-2">
                        <input
                            type="password"
                            value={apiKey}
                            onChange={e => { setApiKey(e.target.value); setTestStatus('idle') }}
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
                    {testStatus === 'ok' && (
                        <div className="flex items-center gap-1 mt-1.5 text-[11px] text-green-600">
                            <CheckCircle2 size={11} /> Подключено успешно
                        </div>
                    )}
                    {testStatus === 'error' && (
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

    const KbTab = () => (
        <div className="space-y-4">
            <InlineInfo>
                Точные ответы, которые AI должен знать без выдумок: условия работы,
                цены, график, частые вопросы. Чем больше записей, тем меньше AI
                «галлюцинирует».
            </InlineInfo>
            <div className="flex items-center justify-between">
                <span className="text-[12px] text-gray-500">{kb.length} {kb.length === 1 ? 'запись' : kb.length >= 2 && kb.length <= 4 ? 'записи' : 'записей'}</span>
                <button
                    onClick={() => setShowKbForm(v => !v)}
                    className="h-[28px] px-3 bg-[#3390EC] text-white text-[11px] font-semibold rounded-lg hover:bg-[#2B7FD4] transition-colors flex items-center gap-1"
                >
                    <Plus size={11} /> Добавить
                </button>
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

            {/* Список — flat divide-y вместо боксов. Раньше каждая запись
                выглядела как карточка товара с border + rounded — слишком
                визуально-тяжело для текстовых FAQ. */}
            {kb.length > 0 && (
                <div className="divide-y divide-[#F0F0F0] border-t border-[#F0F0F0]">
                    {kb.map(entry => (
                        <div key={entry.id} className={`py-3.5 flex items-start gap-2 transition-opacity ${entry.active ? '' : 'opacity-50'}`}>
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
    )

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
                        </div>
                    ))}
                </div>
            )}
        </div>
    )

    // ─── Tabs навигация ───────────────────────────────────────────

    const ALL_TABS = [
        { key: 'sync',     label: 'Синхронизация', icon: RefreshCw },
        { key: 'provider', label: 'AI Провайдер',  icon: Zap },
        { key: 'rules',    label: 'Правила',        icon: Settings },
        { key: 'kb',       label: 'База знаний',    icon: BookOpen },
        { key: 'log',      label: 'Журнал',         icon: ClipboardList },
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
                        {tab === 'kb'       && <KbTab />}
                        {tab === 'log'      && <LogTab />}
                    </>
                )}
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
        <div className="rounded-md border border-[#E8E8E8] bg-white p-4 space-y-3">
            {/* Шапка — имя, описание, бейдж активности, кнопка «сделать активным» */}
            <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0 space-y-2">
                    <input
                        value={name}
                        onChange={e => setName(e.target.value)}
                        disabled={!canEdit}
                        placeholder="Название стиля"
                        className="w-full h-9 border border-[#E0E0E0] rounded-md px-3 text-[14px] font-medium text-[#111] outline-none focus:border-[#3390EC] disabled:bg-[#FAFAFA]"
                    />
                    <input
                        value={description}
                        onChange={e => setDescription(e.target.value)}
                        disabled={!canEdit}
                        placeholder="Короткое описание — где этот стиль уместен"
                        className="w-full h-8 border border-[#E0E0E0] rounded-md px-3 text-[12px] text-gray-600 outline-none focus:border-[#3390EC] disabled:bg-[#FAFAFA]"
                    />
                </div>
                <div className="shrink-0">
                    {isActive ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2.5 py-1 text-[11px] font-medium text-green-700">
                            <CheckCircle2 className="h-3 w-3" />
                            активный
                        </span>
                    ) : canEdit ? (
                        <button
                            type="button"
                            onClick={onSetActive}
                            disabled={activating}
                            title="Сделать этот стиль активным — AI начнёт говорить им"
                            className="inline-flex items-center gap-1 rounded-full border border-green-500/50 px-2.5 py-1 text-[11px] font-medium text-green-700 hover:bg-green-50 disabled:opacity-50"
                        >
                            {activating
                                ? <Loader2 className="h-3 w-3 animate-spin" />
                                : <CheckCircle2 className="h-3 w-3" />}
                            Сделать активным
                        </button>
                    ) : null}
                </div>
            </div>

            {/* 4 текстовых блока — Роль/Тон/Разрешено/Запрещено */}
            {[
                { key: 'promptRole',     value: promptRole,     set: setPromptRole,     label: 'Роль',       hint: 'Кто отвечает: должность, компания. Один абзац.',         placeholder: 'Ассистент таксопарка NashAvtoPark' },
                { key: 'promptTone',     value: promptTone,     set: setPromptTone,     label: 'Тон',        hint: 'Как разговаривать: на ты/на вы, длина, эмодзи, шутки.', placeholder: 'Дружелюбно, на ты, коротко, можно лёгкая шутка' },
                { key: 'promptAllowed',  value: promptAllowed,  set: setPromptAllowed,  label: 'Разрешено',  hint: 'Что AI может делать без согласования с менеджером.',     placeholder: 'Отвечать на FAQ, объяснять тарифы, брать контакт водителя' },
                { key: 'promptForbidden',value: promptForbidden,set: setPromptForbidden,label: 'Запрещено',  hint: 'Что нельзя ни при каких условиях.',                       placeholder: 'Гарантировать доход, спорить, обещать "0% комиссии"' },
            ].map(({ key, value, set, label, hint, placeholder }) => (
                <div key={key}>
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
                        className="w-full border border-[#E0E0E0] rounded-md px-3 py-2 text-[12px] outline-none focus:border-[#3390EC] resize-none placeholder:text-gray-300 disabled:bg-[#FAFAFA]"
                    />
                </div>
            ))}

            {/* Футер — Сохранить + Удалить (для не-default) */}
            {canEdit && (
                <div className="flex items-center gap-2 pt-1">
                    <button
                        type="button"
                        onClick={handleSave}
                        disabled={saving || !dirty}
                        className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[#3390EC] px-3 text-[12px] font-medium text-white hover:bg-[#2B7FD4] disabled:opacity-50"
                    >
                        {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                        Сохранить стиль
                    </button>
                    {!profile.isDefault && (
                        <button
                            type="button"
                            onClick={handleDelete}
                            disabled={deleting}
                            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#E0E0E0] px-3 text-[12px] font-medium text-red-500 hover:bg-red-50 disabled:opacity-50"
                        >
                            {deleting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                            Удалить
                        </button>
                    )}
                    {profile.isDefault && (
                        <span className="text-[11px] text-gray-400">
                            Системный стиль — удалить нельзя, только править.
                        </span>
                    )}
                </div>
            )}
        </div>
    )
}
