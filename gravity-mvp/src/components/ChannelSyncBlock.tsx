"use client"

import { useState, useEffect, useRef } from "react"
import { RefreshCw, Download, CheckCircle2, AlertCircle, Clock, ExternalLink, Square } from "lucide-react"
import { createImportJob, getAllImportJobs, cancelImportJob } from "@/app/settings/ai/actions"

type SyncMode = 'from_connection_time' | 'available_history' | 'last_n_days'

interface ImportJob {
    id: string
    status: string
    resultType?: string | null
    messagesImported: number
    chatsScanned: number
    contactsFound: number
    coveredPeriodFrom?: string | null
    coveredPeriodTo?: string | null
    startedAt?: string | null
    finishedAt?: string | null
    createdAt: string
    channels: string[]
    mode: string
    connectionId?: string | null
    detailsJson?: { newMessages?: number; existingMessages?: number } | null
}

interface Props {
    channel: 'max' | 'telegram' | 'whatsapp'
    connectionId?: string
    scraperUrl?: string
}

const CHANNEL_NAMES: Record<string, string> = { max: 'MAX', telegram: 'Telegram', whatsapp: 'WhatsApp' }

const MODE_LABELS: Record<SyncMode, string> = {
    from_connection_time: 'Только новые сообщения',
    available_history:    'Загрузить доступную историю',
    last_n_days:          'За последние N дней',
}

const MODE_HINTS: Record<SyncMode, string> = {
    from_connection_time: 'CRM будет получать новые сообщения с этого момента',
    available_history:    'CRM подтянет столько истории, сколько доступно в мессенджере',
    last_n_days:          'Загрузить переписку за последние несколько дней',
}

export default function ChannelSyncBlock({ channel, connectionId, scraperUrl = 'http://localhost:3005' }: Props) {
    const [lastJob, setLastJob] = useState<ImportJob | null>(null)
    const [prevJob, setPrevJob] = useState<ImportJob | null>(null)
    const [isImporting, setIsImporting] = useState(false)
    const [showModeSelector, setShowModeSelector] = useState(false)
    const [mode, setMode] = useState<SyncMode>('available_history')
    const [daysBack, setDaysBack] = useState(30)
    const [liveProgress, setLiveProgress] = useState<{ messagesImported: number; chatsScanned: number } | null>(null)
    const [elapsed, setElapsed] = useState(0)
    const [newMsgs, setNewMsgs] = useState<number | null>(null)
    const pollRef = useRef<NodeJS.Timeout | null>(null)
    const timerRef = useRef<NodeJS.Timeout | null>(null)
    const btnRef = useRef<HTMLDivElement | null>(null)

    const loadLastJob = async () => {
        const jobs = await getAllImportJobs(20)
        const channelJobs = (jobs as ImportJob[]).filter(j => j.channels?.includes(channel) && (!connectionId || j.connectionId === connectionId))
        const last = channelJobs[0] ?? null
        const prev = channelJobs[1] ?? null
        setLastJob(last)
        setPrevJob(prev)
        if (last && (last.status === 'queued' || last.status === 'running')) {
            setIsImporting(true)
            startPolling()
        }
    }

    useEffect(() => {
        loadLastJob()
        return () => stopPolling()
    }, [])

    const startPolling = () => {
        if (pollRef.current) return
        pollRef.current = setInterval(async () => {
            // For MAX: read live progress from scraper
            if (channel === 'max') {
                try {
                    const r = await fetch(`${scraperUrl}/import-progress`)
                    if (r.ok) {
                        const d = await r.json()
                        if (d.active) setLiveProgress({ messagesImported: d.messagesImported, chatsScanned: d.chatsScanned })
                    }
                } catch {}
            }

            const jobs = await getAllImportJobs(5)
            const channelJobs = (jobs as ImportJob[]).filter(j => j.channels?.includes(channel) && (!connectionId || j.connectionId === connectionId))
            const latest = channelJobs[0]

            if (latest) {
                // For telegram/whatsapp: read progress from job record itself
                if (channel !== 'max' && (latest.status === 'running' || latest.status === 'queued')) {
                    setLiveProgress({ messagesImported: latest.messagesImported, chatsScanned: latest.chatsScanned })
                }

                if (latest.status !== 'queued' && latest.status !== 'running') {
                    const prev2 = channelJobs[1] ?? null
                    const nm = prev2 ? Math.max(0, latest.messagesImported - prev2.messagesImported) : null
                    setNewMsgs(nm)
                    setLastJob(latest)
                    setPrevJob(prev2)
                    setIsImporting(false)
                    setLiveProgress(null)
                    stopPolling()
                }
            }
        }, 2000)
        setElapsed(0)
        timerRef.current = setInterval(() => setElapsed(e => e + 1), 1000)
    }

    const stopPolling = () => {
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
        if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
    }

    const openModeSelector = () => {
        setShowModeSelector(true)
        setTimeout(() => btnRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50)
    }

    const handleStartSync = async () => {
        setNewMsgs(null)
        setIsImporting(true)
        setShowModeSelector(false)
        setLiveProgress(null)
        const days = daysBack
        try {
            const job = await createImportJob({ channels: [channel], mode, daysBack: mode === 'last_n_days' ? days : undefined, connectionId })
            setLastJob(job as any)
            startPolling()
        } catch {
            setIsImporting(false)
        }
    }

    const fmt = (d: string | null | undefined, withTime = false) => {
        if (!d) return '—'
        return new Date(d).toLocaleString('ru', withTime
            ? { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }
            : { day: '2-digit', month: '2-digit', year: 'numeric' })
    }

    const syncDuration = lastJob?.startedAt && lastJob?.finishedAt
        ? Math.round((new Date(lastJob.finishedAt).getTime() - new Date(lastJob.startedAt).getTime()) / 1000)
        : null

    const historyStatus: 'none' | 'running' | 'done' | 'partial' | 'error' =
        isImporting ? 'running' :
        !lastJob ? 'none' :
        lastJob.status === 'failed' ? 'error' :
        lastJob.status === 'partial' ? 'partial' :
        lastJob.status === 'completed' && lastJob.resultType === 'partial' ? 'partial' :
        lastJob.status === 'completed' ? 'done' : 'none'

    const channelName = CHANNEL_NAMES[channel] ?? channel

    return (
        <div className="mt-4 rounded-xl border border-[#E8E8E8] bg-[#FAFAFA] p-4 space-y-3">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <Download size={13} className="text-gray-400" />
                    <span className="text-[12px] font-semibold text-gray-700">История сообщений</span>
                </div>
                <StatusChip status={historyStatus} />
            </div>

            {/* Running */}
            {historyStatus === 'running' && (
                <div className="space-y-2">
                    <div className="w-full h-1 bg-blue-100 rounded-full overflow-hidden">
                        <div className="h-full bg-blue-400 rounded-full" style={{ animation: 'sync-indeterminate 2s ease-in-out infinite', width: '40%' }} />
                    </div>
                    <style>{`@keyframes sync-indeterminate{0%{transform:translateX(-100%);width:40%}50%{transform:translateX(60%);width:60%}100%{transform:translateX(200%);width:40%}}`}</style>
                    <div className="grid grid-cols-3 gap-2 text-center">
                        <StatMini label="Сообщений" value={liveProgress?.messagesImported ?? lastJob?.messagesImported ?? 0} color="blue" />
                        <StatMini label="Чатов"     value={liveProgress?.chatsScanned   ?? lastJob?.chatsScanned   ?? 0} color="blue" />
                        <StatMini label="Контактов" value={lastJob?.contactsFound ?? 0}                                    color="blue" />
                    </div>
                    <div className="flex items-center justify-between text-[11px] text-gray-400">
                        <span className="flex items-center gap-1"><RefreshCw size={10} className="animate-spin" /> Синхронизация выполняется…</span>
                        <div className="flex items-center gap-2">
                            <span className="font-mono">{Math.floor(elapsed/60)}:{String(elapsed%60).padStart(2,'0')}</span>
                            {lastJob?.id && (
                                <button
                                    onClick={async () => {
                                        await cancelImportJob(lastJob.id)
                                        stopPolling()
                                        setIsImporting(false)
                                        setLiveProgress(null)
                                        await loadLastJob()
                                    }}
                                    className="flex items-center gap-1 px-2 py-0.5 rounded bg-red-50 text-red-600 hover:bg-red-100 transition-colors text-[11px]"
                                >
                                    <Square size={9} fill="currentColor" /> Остановить
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* Done / Partial */}
            {(historyStatus === 'done' || historyStatus === 'partial') && lastJob && (
                <div className="space-y-2">
                    <div className="grid grid-cols-3 gap-2 text-center">
                        <StatMini label="Сообщений" value={lastJob.messagesImported} color="green" />
                        <StatMini label="Чатов"     value={lastJob.chatsScanned}     color="green" />
                        <StatMini label="Контактов" value={lastJob.contactsFound}    color="green" />
                    </div>
                    {(() => {
                        const details = lastJob.detailsJson as any
                        const newCount = details?.newMessages ?? 0
                        const existingCount = details?.existingMessages ?? 0
                        const hasDetails = details && (newCount > 0 || existingCount > 0)
                        return (
                            <div className="text-[11px] px-3 py-1.5 rounded-lg bg-gray-50 text-gray-600 space-y-0.5">
                                <div className="font-medium text-gray-700">Синхронизация завершена</div>
                                {hasDetails ? (
                                    <div className="flex flex-wrap gap-x-3">
                                        {existingCount > 0 && <span>Уже в CRM: <b>{existingCount.toLocaleString()}</b></span>}
                                        <span className={newCount > 0 ? 'text-green-700' : ''}>
                                            Новых загружено: <b>{newCount.toLocaleString()}</b>
                                        </span>
                                        <span>Итого обработано: <b>{lastJob.messagesImported.toLocaleString()}</b></span>
                                    </div>
                                ) : (
                                    <span>Обработано сообщений: <b>{lastJob.messagesImported.toLocaleString()}</b></span>
                                )}
                            </div>
                        )
                    })()}
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-gray-400">
                        {lastJob.coveredPeriodFrom && lastJob.coveredPeriodTo && (
                            <span>Период: <b className="text-gray-600">{fmt(lastJob.coveredPeriodFrom)} — {fmt(lastJob.coveredPeriodTo)}</b></span>
                        )}
                        {lastJob.coveredPeriodTo && (
                            <span>Последнее сообщение: <b className="text-gray-600">{fmt(lastJob.coveredPeriodTo, true)}</b></span>
                        )}
                        {syncDuration !== null && <span>Время синхронизации: {syncDuration} сек</span>}
                        {lastJob.finishedAt && (
                            <span>Последняя синхронизация: <b className="text-gray-600">{fmt(lastJob.finishedAt, true)}</b></span>
                        )}
                    </div>
                </div>
            )}

            {/* Error */}
            {historyStatus === 'error' && (
                <div className="flex items-center gap-2 text-[12px] text-red-600">
                    <AlertCircle size={14} />
                    <span>Ошибка синхронизации. Попробуйте ещё раз.</span>
                </div>
            )}

            {/* None */}
            {historyStatus === 'none' && (
                <p className="text-[11px] text-gray-400">История ещё не загружена. После синхронизации в CRM появятся ваши чаты.</p>
            )}

            {/* Mode selector — компактный */}
            {showModeSelector && !isImporting && (
                <div className="border-t border-[#ECECEC] pt-3 space-y-2">
                    <div className="flex items-center justify-between">
                        <p className="text-[11px] font-medium text-gray-500">Режим синхронизации:</p>
                        <div className="flex gap-2">
                            <button onClick={handleStartSync}
                                className="h-7 px-4 rounded-lg bg-[#3390EC] text-white text-[12px] font-semibold hover:bg-[#2980d4] transition-colors">
                                Запустить
                            </button>
                            <button onClick={() => setShowModeSelector(false)}
                                className="h-7 px-3 rounded-lg border border-[#E0E0E0] text-[12px] text-gray-500 hover:bg-gray-50 transition-colors">
                                Отмена
                            </button>
                        </div>
                    </div>
                    <div className="space-y-1">
                        {(Object.keys(MODE_LABELS) as SyncMode[]).map(m => (
                            <div key={m} className="py-1">
                                <label className="flex items-start gap-2 cursor-pointer">
                                    <input type="radio" name="channelSyncMode" checked={mode === m} onChange={() => setMode(m)} className="mt-0.5 shrink-0" />
                                    <div>
                                        <span className="text-[12px] text-gray-700">{MODE_LABELS[m]}</span>
                                        <p className="text-[10px] text-gray-400 leading-tight">{MODE_HINTS[m]}</p>
                                    </div>
                                </label>
                                {m === 'last_n_days' && mode === 'last_n_days' && (
                                    <div className="flex items-center gap-2 mt-1.5 ml-5" onClick={e => e.stopPropagation()}>
                                        <select
                                            value={daysBack}
                                            onChange={e => setDaysBack(Number(e.target.value))}
                                            className="h-9 rounded-lg border border-[#D0D0D0] text-[14px] font-medium px-3 bg-white focus:outline-none focus:border-[#3390EC] cursor-pointer"
                                        >
                                            <option value={7}>7</option>
                                            <option value={14}>14</option>
                                            <option value={30}>30</option>
                                            <option value={60}>60</option>
                                            <option value={90}>90</option>
                                            <option value={180}>180</option>
                                            <option value={365}>365</option>
                                        </select>
                                        <span className="text-[13px] text-gray-500">дней</span>
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Buttons */}
            {!isImporting && !showModeSelector && (
                <div className="flex items-center gap-2 pt-2 border-t border-[#ECECEC]">
                    {historyStatus === 'none' ? (
                        <button onClick={openModeSelector}
                            className="flex items-center gap-2 h-9 px-4 rounded-lg bg-[#3390EC] text-white text-[13px] font-semibold hover:bg-[#2980d4] transition-colors">
                            <Download size={14} /> Загрузить историю
                        </button>
                    ) : (
                        <button onClick={openModeSelector}
                            className="flex items-center gap-1.5 h-8 px-3 rounded-lg border border-[#E0E0E0] text-[12px] text-gray-600 hover:bg-gray-50 transition-colors">
                            <RefreshCw size={12} /> Синхронизировать снова
                        </button>
                    )}
                    <a href="/messages"
                        className="flex items-center gap-1.5 h-7 px-3 rounded-lg border border-[#E0E0E0] text-[12px] text-gray-600 hover:bg-gray-50 transition-colors ml-auto">
                        <ExternalLink size={11} /> Открыть чаты {channelName}
                    </a>
                </div>
            )}
        </div>
    )
}

function StatusChip({ status }: { status: 'none' | 'running' | 'done' | 'partial' | 'error' }) {
    if (status === 'none')    return <span className="text-[10px] text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">Не загружена</span>
    if (status === 'running') return <span className="text-[10px] text-blue-700 bg-blue-50 px-2 py-0.5 rounded-full flex items-center gap-1"><RefreshCw size={9} className="animate-spin" /> Загружается</span>
    if (status === 'done')    return <span className="text-[10px] text-green-700 bg-green-50 px-2 py-0.5 rounded-full flex items-center gap-1"><CheckCircle2 size={9} /> Актуально</span>
    if (status === 'partial') return <span className="text-[10px] text-yellow-700 bg-yellow-50 px-2 py-0.5 rounded-full flex items-center gap-1"><Clock size={9} /> Частично</span>
    if (status === 'error')   return <span className="text-[10px] text-red-700 bg-red-50 px-2 py-0.5 rounded-full flex items-center gap-1"><AlertCircle size={9} /> Ошибка</span>
    return null
}

function StatMini({ label, value, color }: { label: string; value: number; color: 'blue' | 'green' }) {
    const cls = color === 'blue' ? 'bg-blue-50 text-blue-700' : 'bg-green-50 text-green-700'
    return (
        <div className={`rounded-lg py-2 px-1 ${cls.split(' ')[0]}`}>
            <div className={`text-[15px] font-bold tabular-nums ${cls.split(' ')[1]}`}>{value.toLocaleString()}</div>
            <div className="text-[10px] text-gray-500 mt-0.5">{label}</div>
        </div>
    )
}
