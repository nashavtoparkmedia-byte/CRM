'use client'

import { useState, useEffect, useRef, useTransition } from 'react'
import {
    Bot, Database, Settings, BookOpen, ClipboardList,
    Play, Pause, CheckCircle2, XCircle, AlertCircle,
    Plus, Trash2, Save, RefreshCw, ChevronDown, ChevronUp,
    Zap, MessageSquare, Phone, Send, Square, X, HelpCircle
} from 'lucide-react'
import {
    saveAiConfig, testAiConnection,
    getKnowledgeBase, createKnowledgeEntry, updateKnowledgeEntry, deleteKnowledgeEntry,
    getDecisionLogs, setOperatorVerdict,
    createImportJob, getAllImportJobs, cancelImportJob, deleteImportJob,
    getAiRuntimeStats, checkScraperHealth,
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
}

// ─── Утилиты ──────────────────────────────────────────────────────

const CHANNEL_LABELS: Record<string, string> = { max: 'MAX', telegram: 'TG', whatsapp: 'WA' }
function StatHint({ label }: { label: string }) {
    if (label === 'Сообщений') return (
        <div className="text-left space-y-1">
            <p className="text-white leading-[1.5]">Это количество всех сообщений, которые были импортированы из мессенджера.</p>
            <p className="text-gray-300 leading-[1.5]">Сюда входят:</p>
            <p className="text-gray-300 leading-[1.5]">— входящие сообщения от пользователей</p>
            <p className="text-gray-300 leading-[1.5]">— исходящие сообщения из CRM</p>
            <p className="text-gray-300 leading-[1.5]">— текст, фото, файлы и голосовые сообщения</p>
            <p className="text-gray-400 leading-[1.5] mt-1">Количество зависит от выбранного периода импорта.</p>
        </div>
    )
    if (label === 'Чатов') return (
        <div className="text-left space-y-1">
            <p className="text-white leading-[1.5]">Это количество всех чатов, которые были импортированы из мессенджера.</p>
            <p className="text-gray-300 leading-[1.5]">Сюда входят:</p>
            <p className="text-gray-300 leading-[1.5]">— входящие сообщения от пользователей</p>
            <p className="text-gray-300 leading-[1.5]">— исходящие сообщения из CRM</p>
            <p className="text-gray-300 leading-[1.5]">— текст, фото, файлы и голосовые сообщения</p>
            <p className="text-gray-400 leading-[1.5] mt-1">Количество зависит от выбранного периода импорта.</p>
        </div>
    )
    if (label === 'Контактов') return (
        <div className="text-left space-y-1">
            <p className="text-white leading-[1.5]">Это количество уникальных пользователей (контактов), с которыми есть переписка.</p>
            <p className="text-gray-300 leading-[1.5]">Контакт — это человек или аккаунт в мессенджере.</p>
            <p className="text-gray-300 leading-[1.5]">У одного контакта может быть несколько чатов: например, личный чат и групповой чат.</p>
        </div>
    )
    return null
}
const MODE_LABELS: Record<string, string> = {
    off:             'Выключен',
    suggest_only:    'Советует',
    auto_reply:      'Автоответ',
    operator_locked: 'Оператор',
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
    initialConfig, initialKb, initialImportJobs, initialLogs, initialStats
}: Props) {
    const [tab, setTab] = useState<'sync' | 'provider' | 'rules' | 'kb' | 'log'>('sync')
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
    const [isPending, startTransition] = useTransition()
    const [toast, setToast]           = useState<string | null>(null)

    const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 3000) }

    const lastJob = importJobs[0] ?? null
    const importStatus = lastJob?.status ?? 'none'

    // ─── Runtime Status block ─────────────────────────────────────

    const RuntimeStatus = () => (
        <div className="bg-white border border-[#E8E8E8] rounded-xl p-4 mb-5 flex flex-wrap gap-4 items-center">
            <div className="flex items-center gap-2">
                <div className={`w-2.5 h-2.5 rounded-full ${config.enabled ? 'bg-green-500' : 'bg-gray-300'}`} />
                <span className="text-[13px] font-semibold text-[#111]">
                    AI {config.enabled ? 'включён' : 'выключен'}
                </span>
                <span className="text-[11px] text-gray-500 ml-1">— {MODE_LABELS[config.mode] ?? config.mode}</span>
            </div>

            <div className="flex items-center gap-3 ml-auto text-[11px] text-gray-500">
                <span>Каналы: <b className="text-[#111]">{config.activeChannels.map(c => CHANNEL_LABELS[c] ?? c).join(', ') || '—'}</b></span>
                <span>24ч: <b className="text-green-600">{stats.autoReplied}</b> авто / <b className="text-yellow-600">{stats.escalated}</b> эскал. / <b className="text-red-500">{stats.errors}</b> ошибок</span>
            </div>

            {/* Переключатель On/Off */}
            <button
                onClick={() => {
                    const newEnabled = !config.enabled
                    setConfig(c => ({ ...c, enabled: newEnabled }))
                    startTransition(async () => {
                        await saveAiConfig({ enabled: newEnabled })
                        showToast(newEnabled ? 'AI включён' : 'AI выключен')
                    })
                }}
                className={`h-[28px] px-3 rounded-lg text-[11px] font-semibold transition-colors ${
                    config.enabled
                        ? 'bg-red-50 text-red-600 hover:bg-red-100'
                        : 'bg-green-50 text-green-600 hover:bg-green-100'
                }`}
            >
                {config.enabled ? 'Выключить' : 'Включить'}
            </button>
        </div>
    )

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
                        fetch('http://localhost:3005/import-progress').then(r => r.json()).catch(() => null),
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
                         preflightState === 'unavailable' ? 'Транспорт недоступен' :
                         preflightState === 'needs_auth' ? 'Требуется авторизация' :
                         (importStatus === 'queued' || importStatus === 'running') && transportStatus === 'offline' ? 'Транспорт недоступен' :
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
                                        ? 'Скрапер запущен, но ещё не авторизован'
                                        : 'Транспорт не отвечает — импорт не начат'}
                                </p>
                                {preflightError && (
                                    <p className="text-red-500 text-[11px] mt-0.5">{preflightError}</p>
                                )}
                                <p className="text-gray-500 text-[11px] mt-1">
                                    {preflightState === 'needs_auth'
                                        ? 'Дождитесь завершения инициализации или войдите в аккаунт, затем повторите.'
                                        : 'Запустите сервис и повторите проверку.'}
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
                                        <p className="font-semibold">MAX transport не отвечает — импорт приостановлен</p>
                                        <p className="text-gray-500 text-[11px] mt-1">
                                            Скрапер не запущен или потерял соединение. Запустите сервис — импорт продолжится автоматически.
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
                                        <div key={s.label} className="bg-white/70 rounded-lg p-2.5 text-center relative group">
                                            <div className="text-[18px] font-bold text-yellow-700 tabular-nums">{s.value.toLocaleString()}</div>
                                            <div className="text-[10px] text-gray-500 flex items-center justify-center gap-1">
                                                {s.label}
                                                <HelpCircle size={10} className="text-gray-300 group-hover:text-gray-500 transition-colors cursor-help" />
                                            </div>
                                            <div style={{width: '220px'}} className="absolute top-full left-0 mt-2 px-3 py-2 bg-[#222] text-[11px] rounded-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50 shadow-lg">
                                                <StatHint label={s.label} />
                                            </div>
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
                                <div key={s.label} className="bg-white rounded-lg p-2.5 text-center relative group">
                                    <div className="text-[18px] font-bold text-[#111]">{s.value.toLocaleString()}</div>
                                    <div className="text-[10px] text-gray-500 flex items-center justify-center gap-1">
                                        {s.label}
                                        <HelpCircle size={10} className="text-gray-300 group-hover:text-gray-500 transition-colors cursor-help" />
                                    </div>
                                    <div style={{width: '220px'}} className="absolute top-full left-0 mt-2 px-3 py-2 bg-[#222] text-[11px] rounded-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50 shadow-lg">
                                        <StatHint label={s.label} />
                                    </div>
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

            {/* Настройки импорта */}
            <div className="bg-white border border-[#E8E8E8] rounded-xl p-4 space-y-3">
                <h4 className="text-[12px] font-bold text-gray-400 uppercase tracking-wider">Новый импорт</h4>

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
                            { val: 'from_connection_time', label: 'С момента подключения' },
                            { val: 'available_history',    label: 'Импортировать доступную историю' },
                            { val: 'last_n_days',          label: 'За последние N дней' },
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

            {/* История заданий */}
            {importJobs.length > 0 && (
                <div className="bg-white border border-[#E8E8E8] rounded-xl overflow-hidden">
                    <div className="px-4 py-2.5 border-b border-[#F0F0F0]">
                        <h4 className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">История импортов</h4>
                    </div>
                    <div className="divide-y divide-[#F5F5F5]">
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
                                                await deleteImportJob(job.id)
                                                const fresh = await getAllImportJobs(10)
                                                setImportJobs(fresh)
                                            }}
                                            title="Удалить"
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

    const ProviderTab = () => (
        <div className="space-y-5">
            <div className="bg-white border border-[#E8E8E8] rounded-xl p-4 space-y-3">
                <h4 className="text-[12px] font-bold text-gray-400 uppercase tracking-wider">Провайдер</h4>

                <div className="flex gap-2">
                    {['anthropic', 'openai'].map(p => (
                        <button
                            key={p}
                            onClick={() => setConfig(c => ({ ...c, provider: p }))}
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
                    <label className="text-[12px] text-gray-500 block mb-1">API ключ</label>
                    <div className="flex gap-2">
                        <input
                            type="password"
                            value={apiKey}
                            onChange={e => { setApiKey(e.target.value); setTestStatus('idle') }}
                            placeholder={config.apiKeyEncrypted ? '••••••••••••••••' : 'sk-ant-...'}
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

                <div className="grid grid-cols-2 gap-3">
                    <div>
                        <label className="text-[12px] text-gray-500 block mb-1">Модель классификации</label>
                        <input
                            value={config.classificationModel}
                            onChange={e => setConfig(c => ({ ...c, classificationModel: e.target.value }))}
                            className="w-full h-[32px] border border-[#E0E0E0] rounded-lg px-3 text-[12px] outline-none focus:border-[#3390EC] font-mono"
                        />
                        <div className="text-[10px] text-gray-400 mt-0.5">Дешёвая — для intent</div>
                    </div>
                    <div>
                        <label className="text-[12px] text-gray-500 block mb-1">Модель ответов</label>
                        <input
                            value={config.responseModel}
                            onChange={e => setConfig(c => ({ ...c, responseModel: e.target.value }))}
                            className="w-full h-[32px] border border-[#E0E0E0] rounded-lg px-3 text-[12px] outline-none focus:border-[#3390EC] font-mono"
                        />
                        <div className="text-[10px] text-gray-400 mt-0.5">Для генерации ответов</div>
                    </div>
                </div>

                {/* Routing rules */}
                <div className="pt-2 border-t border-[#F0F0F0]">
                    <h5 className="text-[11px] font-bold text-gray-400 uppercase tracking-wider mb-2">Routing моделей</h5>
                    <div className="space-y-1.5 text-[11px] text-gray-600">
                        <div className="flex items-center gap-2 bg-[#F8F9FA] rounded-lg px-3 py-2">
                            <span className="w-[160px] text-gray-500">Intent classification</span>
                            <span>→</span>
                            <span className="font-mono font-semibold">{config.classificationModel}</span>
                        </div>
                        <div className="flex items-center gap-2 bg-[#F8F9FA] rounded-lg px-3 py-2">
                            <span className="w-[160px] text-gray-500">FAQ / простой ответ</span>
                            <span>→</span>
                            <span className="font-mono font-semibold">{config.classificationModel}</span>
                        </div>
                        <div className="flex items-center gap-2 bg-[#F8F9FA] rounded-lg px-3 py-2">
                            <span className="w-[160px] text-gray-500">Сложный / длинный</span>
                            <span>→</span>
                            <span className="font-mono font-semibold">{config.responseModel}</span>
                        </div>
                        <div className="flex items-center gap-2 bg-red-50 rounded-lg px-3 py-2 text-red-600">
                            <span className="w-[160px]">Жалоба / конфликт</span>
                            <span>→</span>
                            <span className="font-semibold">Всегда оператор</span>
                        </div>
                    </div>
                </div>

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

    // ─── Вкладка: Правила ─────────────────────────────────────────

    const [rulesSaving, setRulesSaving] = useState(false)

    const handleSaveRules = async () => {
        setRulesSaving(true)
        try {
            await saveAiConfig({
                mode:                 config.mode,
                language:             config.language,
                confidenceThreshold:  config.confidenceThreshold,
                maxAutoRepliesPerChat: config.maxAutoRepliesPerChat,
                activeChannels:       config.activeChannels,
                promptRole:           config.promptRole,
                promptTone:           config.promptTone,
                promptAllowed:        config.promptAllowed,
                promptForbidden:      config.promptForbidden,
            })
            showToast('Правила сохранены')
        } catch (e: any) {
            showToast('Ошибка: ' + e.message)
        } finally {
            setRulesSaving(false)
        }
    }

    const RulesTab = () => (
        <div className="space-y-5">
            {/* Режим */}
            <div className="bg-white border border-[#E8E8E8] rounded-xl p-4 space-y-3">
                <h4 className="text-[12px] font-bold text-gray-400 uppercase tracking-wider">Режим работы</h4>
                <div className="grid grid-cols-2 gap-2">
                    {Object.entries(MODE_LABELS).map(([val, label]) => (
                        <button
                            key={val}
                            onClick={() => setConfig(c => ({ ...c, mode: val }))}
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
                        <label className="text-[12px] text-gray-500 block mb-1">Confidence порог</label>
                        <input
                            type="number" min={0} max={1} step={0.05}
                            value={config.confidenceThreshold}
                            onChange={e => setConfig(c => ({ ...c, confidenceThreshold: parseFloat(e.target.value) }))}
                            className="w-full h-[32px] border border-[#E0E0E0] rounded-lg px-3 text-[12px] outline-none focus:border-[#3390EC]"
                        />
                        <div className="text-[10px] text-gray-400 mt-0.5">Ниже — всегда оператор</div>
                    </div>
                    <div>
                        <label className="text-[12px] text-gray-500 block mb-1">Макс. автоответов подряд</label>
                        <input
                            type="number" min={1} max={50}
                            value={config.maxAutoRepliesPerChat}
                            onChange={e => setConfig(c => ({ ...c, maxAutoRepliesPerChat: parseInt(e.target.value) }))}
                            className="w-full h-[32px] border border-[#E0E0E0] rounded-lg px-3 text-[12px] outline-none focus:border-[#3390EC]"
                        />
                    </div>
                </div>
            </div>

            {/* Промпт */}
            <div className="bg-white border border-[#E8E8E8] rounded-xl p-4 space-y-3">
                <h4 className="text-[12px] font-bold text-gray-400 uppercase tracking-wider">Системный промпт</h4>
                {[
                    { key: 'promptRole',     label: 'Роль',       placeholder: 'Ассистент диспетчера таксопарка NashAvtoPark' },
                    { key: 'promptTone',     label: 'Тон',        placeholder: 'Коротко, спокойно, без канцелярита' },
                    { key: 'promptAllowed',  label: 'Разрешено',  placeholder: 'Отвечать на FAQ, подтверждать получение' },
                    { key: 'promptForbidden',label: 'Запрещено',  placeholder: 'Обещать выплаты, спорить, придумывать факты' },
                ].map(({ key, label, placeholder }) => (
                    <div key={key}>
                        <label className="text-[12px] text-gray-500 block mb-1">{label}</label>
                        <textarea
                            rows={2}
                            value={(config as any)[key] ?? ''}
                            onChange={e => setConfig(c => ({ ...c, [key]: e.target.value }))}
                            placeholder={placeholder}
                            className="w-full border border-[#E0E0E0] rounded-lg px-3 py-2 text-[12px] outline-none focus:border-[#3390EC] resize-none placeholder:text-gray-300"
                        />
                    </div>
                ))}
            </div>

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
        await deleteKnowledgeEntry(id)
        setKb(prev => prev.filter(e => e.id !== id))
        showToast('Удалено')
    }

    const KbTab = () => (
        <div className="space-y-4">
            <div className="flex items-center justify-between">
                <span className="text-[12px] text-gray-500">{kb.length} записей</span>
                <button
                    onClick={() => setShowKbForm(v => !v)}
                    className="h-[28px] px-3 bg-[#3390EC] text-white text-[11px] font-semibold rounded-lg hover:bg-[#2B7FD4] transition-colors flex items-center gap-1"
                >
                    <Plus size={11} /> Добавить
                </button>
            </div>

            {showKbForm && (
                <div className="bg-[#F8F9FA] border border-[#E8E8E8] rounded-xl p-4 space-y-2.5 animate-in fade-in duration-150">
                    <div className="grid grid-cols-2 gap-2">
                        <div>
                            <label className="text-[11px] text-gray-500 block mb-1">Заголовок *</label>
                            <input value={kbForm.title} onChange={e => setKbForm(f => ({ ...f, title: e.target.value }))}
                                placeholder="Как получить справку?" className="w-full h-[30px] border border-[#E0E0E0] bg-white rounded-lg px-2 text-[12px] outline-none focus:border-[#3390EC]" />
                        </div>
                        <div>
                            <label className="text-[11px] text-gray-500 block mb-1">Категория</label>
                            <input value={kbForm.category} onChange={e => setKbForm(f => ({ ...f, category: e.target.value }))}
                                placeholder="general" className="w-full h-[30px] border border-[#E0E0E0] bg-white rounded-lg px-2 text-[12px] outline-none focus:border-[#3390EC]" />
                        </div>
                    </div>
                    <div>
                        <label className="text-[11px] text-gray-500 block mb-1">Примеры вопросов (по одному на строку)</label>
                        <textarea rows={2} value={kbForm.sampleQuestions} onChange={e => setKbForm(f => ({ ...f, sampleQuestions: e.target.value }))}
                            placeholder={"Как мне получить справку?\nГде взять документы?"} className="w-full border border-[#E0E0E0] bg-white rounded-lg px-2 py-1.5 text-[12px] outline-none focus:border-[#3390EC] resize-none" />
                    </div>
                    <div>
                        <label className="text-[11px] text-gray-500 block mb-1">Ответ *</label>
                        <textarea rows={3} value={kbForm.answer} onChange={e => setKbForm(f => ({ ...f, answer: e.target.value }))}
                            placeholder="Справки выдаются в офисе по адресу..." className="w-full border border-[#E0E0E0] bg-white rounded-lg px-2 py-1.5 text-[12px] outline-none focus:border-[#3390EC] resize-none" />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                        <div>
                            <label className="text-[11px] text-gray-500 block mb-1">Теги (через запятую)</label>
                            <input value={kbForm.tags} onChange={e => setKbForm(f => ({ ...f, tags: e.target.value }))}
                                placeholder="справка, документы" className="w-full h-[30px] border border-[#E0E0E0] bg-white rounded-lg px-2 text-[12px] outline-none focus:border-[#3390EC]" />
                        </div>
                        <div>
                            <label className="text-[11px] text-gray-500 block mb-1">Приоритет</label>
                            <input type="number" min={0} max={100} value={kbForm.priority} onChange={e => setKbForm(f => ({ ...f, priority: +e.target.value }))}
                                className="w-full h-[30px] border border-[#E0E0E0] bg-white rounded-lg px-2 text-[12px] outline-none focus:border-[#3390EC]" />
                        </div>
                    </div>
                    <div className="flex gap-2 pt-1">
                        <button onClick={handleCreateKb} disabled={kbSaving}
                            className="h-[28px] px-3 bg-[#3390EC] text-white text-[11px] font-semibold rounded-lg hover:bg-[#2B7FD4] disabled:opacity-50 transition-colors">
                            {kbSaving ? 'Сохраняем...' : 'Сохранить'}
                        </button>
                        <button onClick={() => setShowKbForm(false)} className="h-[28px] px-3 bg-gray-100 text-gray-600 text-[11px] rounded-lg hover:bg-gray-200 transition-colors">Отмена</button>
                    </div>
                </div>
            )}

            <div className="space-y-2">
                {kb.length === 0 && (
                    <div className="text-center py-8 text-gray-400 text-[13px]">
                        База знаний пуста. Добавьте первую запись.
                    </div>
                )}
                {kb.map(entry => (
                    <div key={entry.id} className={`bg-white border rounded-xl p-3.5 transition-colors ${entry.active ? 'border-[#E8E8E8]' : 'border-dashed border-gray-200 opacity-60'}`}>
                        <div className="flex items-start gap-2">
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-0.5">
                                    <span className="text-[13px] font-semibold text-[#111] truncate">{entry.title}</span>
                                    <span className="text-[10px] text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded">{entry.category}</span>
                                    {entry.priority > 0 && <span className="text-[10px] text-[#3390EC]">p{entry.priority}</span>}
                                </div>
                                <p className="text-[11px] text-gray-500 line-clamp-2">{entry.answer}</p>
                                {entry.tags.length > 0 && (
                                    <div className="flex flex-wrap gap-1 mt-1">
                                        {entry.tags.map(t => (
                                            <span key={t} className="text-[10px] bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded-full">{t}</span>
                                        ))}
                                    </div>
                                )}
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                                <button onClick={() => handleToggleKb(entry)}
                                    className={`text-[10px] font-semibold px-2 py-1 rounded-lg transition-colors ${entry.active ? 'bg-green-50 text-green-600 hover:bg-green-100' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}>
                                    {entry.active ? 'Вкл' : 'Выкл'}
                                </button>
                                <button onClick={() => handleDeleteKb(entry.id)}
                                    className="text-gray-300 hover:text-red-500 transition-colors p-1">
                                    <Trash2 size={12} />
                                </button>
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    )

    // ─── Вкладка: Журнал ──────────────────────────────────────────

    const DECISION_COLORS: Record<string, string> = {
        auto_reply: 'bg-green-50 text-green-700',
        escalate:   'bg-yellow-50 text-yellow-700',
        skip:       'bg-gray-100 text-gray-500',
    }

    const LogTab = () => (
        <div className="space-y-3">
            {logs.length === 0 && (
                <div className="text-center py-8 text-gray-400 text-[13px]">
                    Журнал пуст. Решения появятся после первых сообщений.
                </div>
            )}
            {logs.map(log => (
                <div key={log.id} className="bg-white border border-[#E8E8E8] rounded-xl p-3.5 space-y-2">
                    <div className="flex items-center gap-2 text-[11px]">
                        <span className="text-gray-400">{new Date(log.createdAt).toLocaleString('ru')}</span>
                        {log.channel && <span className="bg-purple-50 text-purple-700 font-bold px-1.5 py-0.5 rounded-full text-[10px]">{CHANNEL_LABELS[log.channel] ?? log.channel}</span>}
                        {log.detectedIntent && <span className="text-gray-600 font-mono">{log.detectedIntent}</span>}
                        {log.confidence != null && <span className="text-gray-400">{(log.confidence * 100).toFixed(0)}%</span>}
                        {log.decision && (
                            <span className={`ml-auto text-[10px] font-bold px-2 py-0.5 rounded-full ${DECISION_COLORS[log.decision] ?? 'bg-gray-100 text-gray-600'}`}>
                                {log.decision === 'auto_reply' ? 'Автоответ' : log.decision === 'escalate' ? 'Оператор' : log.decision}
                            </span>
                        )}
                    </div>
                    {log.generatedReply && (
                        <div className="text-[11px] text-gray-600 bg-[#F8F9FA] rounded-lg px-3 py-2 line-clamp-2">
                            {log.generatedReply}
                        </div>
                    )}
                    {log.error && (
                        <div className="text-[11px] text-red-500 flex items-center gap-1">
                            <XCircle size={10} /> {log.error}
                        </div>
                    )}
                    {/* Feedback оператора */}
                    {!log.reviewedByOperator && log.decision === 'auto_reply' && (
                        <div className="flex gap-1.5 pt-1">
                            <span className="text-[10px] text-gray-400 mr-1">Оценить:</span>
                            {(['good', 'bad'] as const).map(v => (
                                <button key={v} onClick={async () => {
                                    await setOperatorVerdict(log.id, v)
                                    setLogs(prev => prev.map(l => l.id === log.id ? { ...l, reviewedByOperator: true, operatorVerdict: v } : l))
                                }}
                                className={`text-[10px] font-semibold px-2 py-0.5 rounded-lg transition-colors ${v === 'good' ? 'bg-green-50 text-green-600 hover:bg-green-100' : 'bg-red-50 text-red-500 hover:bg-red-100'}`}>
                                    {v === 'good' ? '👍 Хорошо' : '👎 Плохо'}
                                </button>
                            ))}
                        </div>
                    )}
                    {log.reviewedByOperator && (
                        <div className="text-[10px] text-gray-400">
                            Оценка: {log.operatorVerdict === 'good' ? '👍' : log.operatorVerdict === 'bad' ? '👎' : '✏️'}
                        </div>
                    )}
                </div>
            ))}
        </div>
    )

    // ─── Tabs навигация ───────────────────────────────────────────

    const TABS = [
        { key: 'sync',     label: 'Синхронизация', icon: RefreshCw },
        { key: 'provider', label: 'AI Провайдер',  icon: Zap },
        { key: 'rules',    label: 'Правила',        icon: Settings },
        { key: 'kb',       label: 'База знаний',    icon: BookOpen },
        { key: 'log',      label: 'Журнал',         icon: ClipboardList },
    ] as const

    return (
        <div className="flex flex-col h-full">
            {/* Toast */}
            {toast && (
                <div className="fixed top-4 right-4 z-50 bg-[#111] text-white text-[12px] font-medium px-4 py-2.5 rounded-xl shadow-lg animate-in fade-in slide-in-from-top-2 duration-200">
                    {toast}
                </div>
            )}

            <RuntimeStatus />

            {/* Tabs */}
            <div className="flex gap-1 mb-5 border-b border-[#E8E8E8] pb-0">
                {TABS.map(({ key, label, icon: Icon }) => (
                    <button
                        key={key}
                        onClick={() => setTab(key)}
                        className={`flex items-center gap-1.5 px-3 h-[36px] text-[12px] font-semibold border-b-2 transition-colors ${
                            tab === key
                                ? 'border-[#3390EC] text-[#3390EC]'
                                : 'border-transparent text-gray-500 hover:text-[#111]'
                        }`}
                    >
                        <Icon size={12} />
                        {label}
                    </button>
                ))}
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto pr-1">
                {tab === 'sync'     && <SyncTab />}
                {tab === 'provider' && <ProviderTab />}
                {tab === 'rules'    && <RulesTab />}
                {tab === 'kb'       && <KbTab />}
                {tab === 'log'      && <LogTab />}
            </div>
        </div>
    )
}
