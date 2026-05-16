"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import {
    Phone, PhoneIncoming, PhoneOutgoing, PhoneMissed,
    Play, Pause, Loader2, ArrowLeft, Sparkles, Headphones, FileText, AlertTriangle,
} from "lucide-react"

export interface CallAnalysisShape {
    scores: {
        greeting: number
        needs: number
        presentation: number
        objections: number
        next_step: number
    }
    summary: string
    red_flags: string[]
}

export interface QualificationResult {
    qualification_status: 'qualified' | 'not_qualified' | 'unclear'
    reason: string
    lead_summary?: string
    answers: {
        has_license?: boolean | null
        license_categories?: string[]
        experience_years?: number | null
        city?: string | null
        desired_schedule?: 'day' | 'night' | 'shifts' | 'any' | 'unknown'
        ready_to_start_within_days?: number | null
        objections?: string[]
    }
    manager_task?: {
        should_create: boolean
        priority: 'high' | 'normal' | 'low'
        summary: string
    }
    created_task_id?: string
}

export interface CallDetail {
    id: string
    direction: 'inbound' | 'outbound'
    status: string
    fromNumber: string
    toNumber: string
    startedAt: string
    answeredAt: string | null
    endedAt: string | null
    durationSec: number | null
    hangupCause: string | null
    recordingPath: string | null
    transcript: string | null
    aiScore: number | null
    aiSummary: string | null
    aiAnalysis: CallAnalysisShape | QualificationResult | null
    managerId: string | null
    managerName: string | null
    driver: { id: string; fullName: string; phone: string | null } | null
    contact: { id: string; displayName: string } | null
    // AI-call (voice-agent outbound) fields
    isAi: boolean
    aiSessionStatus: 'starting' | 'greeting' | 'active' | 'transferring' | 'ended' | 'failed' | null
    aiTransferReason: string | null
    aiScenarioName: string | null
    linkedTask: { id: string; title: string } | null
    estimatedCostRub: number | null
}

type TabKey = 'audio' | 'transcript' | 'ai'

/**
 * Live call detail card. Three tabs, Telegram-style flat surface. SSE-driven —
 * when the transcribe or analyze worker finishes, this page receives an
 * `updated` event and re-fetches the call so the new fields appear without
 * a manual reload. Re-fetching (vs patching from the event) keeps the
 * client simple and resilient to dropped events on the SSE channel.
 */
export default function CallDetailClient({ initial }: { initial: CallDetail }) {
    const [call, setCall] = useState<CallDetail>(initial)
    const [activeTab, setActiveTab] = useState<TabKey>(initialTabFor(initial))

    // SSE: refresh on relevant `updated` events
    useEffect(() => {
        const es = new EventSource('/api/calls/stream')
        es.onmessage = async (msg) => {
            try {
                const evt = JSON.parse(msg.data)
                if (evt?.type === 'updated' && evt.data?.callId === call.id) {
                    const res = await fetch(`/api/calls/${call.id}`)
                    if (res.ok) {
                        const { call: fresh } = await res.json()
                        setCall(prev => ({ ...prev, ...fresh, managerName: fresh.managerName ?? prev.managerName }))
                    }
                }
                if (evt?.type === 'ended' && evt.data?.callId === call.id) {
                    const res = await fetch(`/api/calls/${call.id}`)
                    if (res.ok) {
                        const { call: fresh } = await res.json()
                        setCall(prev => ({ ...prev, ...fresh, managerName: fresh.managerName ?? prev.managerName }))
                    }
                }
            } catch {
                // ignore malformed events
            }
        }
        return () => es.close()
    }, [call.id])

    const peerName = call.driver?.fullName ?? call.contact?.displayName ?? null
    const peerNumber = call.direction === 'inbound' ? call.fromNumber : call.toNumber

    return (
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 p-6 animate-in fade-in duration-300">
            <Link
                href="/calls"
                className="inline-flex items-center gap-1.5 self-start text-[13px] text-muted-foreground hover:text-foreground"
            >
                <ArrowLeft className="h-3.5 w-3.5" />
                К списку звонков
            </Link>

            <CallHeader call={call} peerName={peerName} peerNumber={peerNumber} />

            <div className="rounded-md border border-border bg-card">
                <Tabs active={activeTab} onChange={setActiveTab} call={call} />
                <div className="p-6">
                    {activeTab === 'audio' && <AudioPane call={call} />}
                    {activeTab === 'transcript' && <TranscriptPane transcript={call.transcript} />}
                    {activeTab === 'ai' && (
                        call.isAi
                            ? <AiQualificationPane call={call} />
                            : <AiPane analysis={call.aiAnalysis as CallAnalysisShape | null} summary={call.aiSummary} score={call.aiScore} />
                    )}
                </div>
            </div>
        </div>
    )
}

function initialTabFor(c: CallDetail): TabKey {
    // For AI calls, the qualification result is the most informative view.
    if (c.isAi && c.aiAnalysis) return 'ai'
    if (c.aiAnalysis) return 'ai'
    if (c.transcript) return 'transcript'
    return 'audio'
}

function AiQualificationPane({ call }: { call: CallDetail }) {
    const q = call.aiAnalysis as QualificationResult | null
    if (!q || !('qualification_status' in (q as any))) {
        return <EmptyState icon={Sparkles} title="Квалификация не записана" hint="AI-звонок не дошёл до финального шага квалификации." />
    }

    const qStatus = q.qualification_status
    const statusLabel = qStatus === 'qualified' ? 'Квалифицирован'
        : qStatus === 'not_qualified' ? 'Не квалифицирован'
        : 'Неясно'
    const statusColor = qStatus === 'qualified' ? 'bg-accent/10 text-accent'
        : qStatus === 'not_qualified' ? 'bg-destructive/10 text-destructive'
        : 'bg-muted text-muted-foreground'

    const a = q.answers ?? {}

    return (
        <div className="flex flex-col gap-5">
            <div className="flex flex-wrap items-center gap-3">
                <span className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-[13px] font-medium ${statusColor}`}>
                    <Sparkles className="h-3.5 w-3.5" />
                    {statusLabel}
                </span>
                {call.aiScenarioName && (
                    <span className="text-[12px] text-muted-foreground">
                        Сценарий: {call.aiScenarioName}
                    </span>
                )}
                {call.estimatedCostRub !== null && (
                    <span className="text-[12px] text-muted-foreground">
                        Стоимость ≈ {call.estimatedCostRub.toFixed(2)} ₽
                    </span>
                )}
            </div>

            {call.aiSummary && (
                <div className="rounded-md border border-border bg-card p-4">
                    <div className="text-[12px] font-medium uppercase tracking-wider text-muted-foreground mb-2">Резюме</div>
                    <div className="text-[14px] leading-[1.5] text-foreground">{call.aiSummary}</div>
                </div>
            )}

            <div className="rounded-md border border-border bg-card p-4">
                <div className="text-[12px] font-medium uppercase tracking-wider text-muted-foreground mb-2">Причина решения</div>
                <div className="text-[14px] leading-[1.5] text-foreground">{q.reason}</div>
            </div>

            <div className="rounded-md border border-border bg-card p-4">
                <div className="text-[12px] font-medium uppercase tracking-wider text-muted-foreground mb-3">Ответы лида</div>
                <dl className="grid grid-cols-[160px_1fr] gap-y-2 text-[13px]">
                    <Dt>Права</Dt>
                    <Dd>{a.has_license === true ? `да — кат. ${(a.license_categories ?? []).join(', ') || 'B'}` : a.has_license === false ? 'нет' : 'не указано'}</Dd>
                    <Dt>Стаж</Dt>
                    <Dd>{a.experience_years !== null && a.experience_years !== undefined ? `${a.experience_years} лет` : 'не указано'}</Dd>
                    <Dt>Город</Dt>
                    <Dd>{a.city ?? 'не указано'}</Dd>
                    <Dt>График</Dt>
                    <Dd>{scheduleLabel(a.desired_schedule)}</Dd>
                    <Dt>Готов начать</Dt>
                    <Dd>{a.ready_to_start_within_days !== null && a.ready_to_start_within_days !== undefined ? `в течение ${a.ready_to_start_within_days} дн.` : 'не указано'}</Dd>
                    {(a.objections ?? []).length > 0 && (
                        <>
                            <Dt>Возражения</Dt>
                            <Dd>{(a.objections ?? []).join(', ')}</Dd>
                        </>
                    )}
                </dl>
            </div>

            {q.manager_task?.should_create && (
                <div className="rounded-md border border-primary/30 bg-primary/5 p-4">
                    <div className="flex items-center gap-2 mb-2">
                        <div className="text-[12px] font-medium uppercase tracking-wider text-primary">Задача менеджеру</div>
                        <span className={`text-[11px] font-medium rounded-full px-2 py-0.5 ${
                            q.manager_task.priority === 'high' ? 'bg-destructive/10 text-destructive'
                            : q.manager_task.priority === 'normal' ? 'bg-primary/10 text-primary'
                            : 'bg-muted text-muted-foreground'
                        }`}>
                            {q.manager_task.priority === 'high' ? 'Высокий' : q.manager_task.priority === 'normal' ? 'Средний' : 'Низкий'}
                        </span>
                    </div>
                    <div className="text-[14px] leading-[1.5] text-foreground mb-2">{q.manager_task.summary}</div>
                    {call.linkedTask && (
                        <Link
                            href={`/inbox?task=${call.linkedTask.id}`}
                            className="inline-flex items-center gap-1 text-[12px] text-primary hover:underline"
                        >
                            Открыть задачу →
                        </Link>
                    )}
                </div>
            )}

            {call.aiTransferReason && (
                <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-[13px] text-amber-900">
                    AI передал звонок менеджеру: {call.aiTransferReason}
                </div>
            )}
        </div>
    )
}

function Dt({ children }: { children: React.ReactNode }) {
    return <dt className="text-muted-foreground">{children}</dt>
}
function Dd({ children }: { children: React.ReactNode }) {
    return <dd className="text-foreground">{children}</dd>
}

function scheduleLabel(s: string | null | undefined): string {
    switch (s) {
        case 'day': return 'дневной'
        case 'night': return 'ночной'
        case 'shifts': return 'сменный'
        case 'any': return 'любой'
        default: return 'не указано'
    }
}

function CallHeader({ call, peerName, peerNumber }: { call: CallDetail; peerName: string | null; peerNumber: string }) {
    const Icon = iconFor(call)
    return (
        <div className="flex items-center gap-4 rounded-md border border-border bg-card p-5">
            <div className={`flex h-12 w-12 items-center justify-center rounded-full ${bgFor(call)}`}>
                <Icon className={`h-5 w-5 ${colorFor(call)}`} />
            </div>
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                    <div className="truncate text-[17px] font-semibold text-foreground">
                        {peerName ?? formatPhone(peerNumber)}
                    </div>
                    {call.isAi && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                            <Sparkles className="h-3 w-3" />
                            AI-обзвон
                        </span>
                    )}
                </div>
                <div className="text-[13px] text-muted-foreground">
                    {call.direction === 'inbound' ? 'Входящий' : (call.isAi ? 'AI-исходящий' : 'Исходящий')} ·
                    {' '}
                    {formatPhone(peerNumber)}
                    {call.driver && (
                        <>
                            {' · '}
                            <Link
                                href={`/drivers/${call.driver.id}`}
                                className="text-primary hover:underline"
                            >
                                Карточка водителя
                            </Link>
                        </>
                    )}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
                    <span>{new Date(call.startedAt).toLocaleString('ru-RU')}</span>
                    {call.durationSec !== null && (
                        <span>· Длительность {formatDuration(call.durationSec)}</span>
                    )}
                    {call.managerName && (
                        <span>· Менеджер: {call.managerName}</span>
                    )}
                </div>
            </div>
            <StatusBadge status={call.status} />
        </div>
    )
}

function Tabs({ active, onChange, call }: { active: TabKey; onChange: (t: TabKey) => void; call: CallDetail }) {
    const items: { key: TabKey; label: string; icon: typeof Headphones; ready: boolean }[] = [
        { key: 'audio',      label: 'Аудио',       icon: Headphones, ready: !!call.recordingPath },
        { key: 'transcript', label: 'Транскрипт',  icon: FileText,   ready: !!call.transcript },
        { key: 'ai',         label: 'AI-анализ',   icon: Sparkles,   ready: !!call.aiAnalysis },
    ]
    return (
        <div className="flex items-center gap-1 border-b border-border px-3 pt-2">
            {items.map(it => {
                const Icon = it.icon
                const isActive = active === it.key
                return (
                    <button
                        key={it.key}
                        onClick={() => onChange(it.key)}
                        className={[
                            'inline-flex items-center gap-1.5 rounded-t-md px-3 py-2 text-[13px] font-medium transition-colors',
                            isActive
                                ? 'bg-surface text-foreground border-b-2 border-primary'
                                : 'text-muted-foreground hover:text-foreground hover:bg-surface',
                        ].join(' ')}
                    >
                        <Icon className="h-3.5 w-3.5" />
                        {it.label}
                        {!it.ready && (
                            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground/60" />
                        )}
                    </button>
                )
            })}
        </div>
    )
}

function AudioPane({ call }: { call: CallDetail }) {
    const [url, setUrl] = useState<string | null>(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const audioRef = useRef<HTMLAudioElement | null>(null)

    useEffect(() => {
        if (!call.recordingPath || url) return
        setLoading(true)
        fetch(`/api/calls/${call.id}/recording`)
            .then(r => r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`)))
            .then(d => setUrl(d.url))
            .catch(err => setError(err.message ?? 'не удалось загрузить запись'))
            .finally(() => setLoading(false))
    }, [call.id, call.recordingPath, url])

    if (!call.recordingPath) {
        return <EmptyState icon={Headphones} title="Записи нет" hint="Запись появляется через несколько секунд после завершения разговора." />
    }
    if (loading) {
        return <div className="flex items-center gap-2 text-[13px] text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Загрузка ссылки на запись…</div>
    }
    if (error || !url) {
        return <div className="text-[13px] text-destructive">Не удалось получить запись: {error}</div>
    }

    return (
        <div className="flex flex-col gap-3">
            <audio ref={audioRef} src={url} controls preload="metadata" className="w-full" />
            <p className="text-[12px] text-muted-foreground">
                Ссылка действует 1 час. Перейдите по табу <span className="text-foreground">Транскрипт</span> или <span className="text-foreground">AI-анализ</span>, чтобы увидеть обработку.
            </p>
        </div>
    )
}

function TranscriptPane({ transcript }: { transcript: string | null }) {
    if (!transcript) {
        return (
            <EmptyState
                icon={FileText}
                title="Транскрипт обрабатывается"
                hint="Whisper расшифровывает запись звонка. Обычно занимает 5–15 секунд."
            />
        )
    }
    return (
        <div className="prose max-w-none whitespace-pre-wrap text-[14px] leading-[1.55] text-foreground">
            {transcript}
        </div>
    )
}

function AiPane({ analysis, summary, score }: { analysis: CallAnalysisShape | null; summary: string | null; score: number | null }) {
    if (!analysis) {
        return (
            <EmptyState
                icon={Sparkles}
                title="AI-анализ готовится"
                hint="Claude оценивает разговор по 5 критериям после получения транскрипта."
            />
        )
    }

    const criteria: Array<{ key: keyof CallAnalysisShape['scores']; label: string; hint: string }> = [
        { key: 'greeting',     label: 'Приветствие',          hint: 'Представление, цель звонка, тон' },
        { key: 'needs',        label: 'Выявление потребностей', hint: 'Опыт, авто, мотивы, готовность' },
        { key: 'presentation', label: 'Презентация условий',   hint: 'Комиссия, поддержка, выплаты' },
        { key: 'objections',   label: 'Работа с возражениями', hint: 'Признание, аргументы, отсутствие давления' },
        { key: 'next_step',    label: 'Следующий шаг',         hint: 'Конкретная договорённость' },
    ]

    return (
        <div className="flex flex-col gap-6">
            <div className="flex items-center gap-4">
                <ScoreCircle score={score ?? null} />
                <div className="text-[14px] text-foreground">
                    <div className="text-[13px] uppercase tracking-wide text-muted-foreground">Общая оценка</div>
                    <div className="text-[20px] font-semibold leading-tight text-foreground">
                        {score !== null ? `${score} / 10` : '—'}
                    </div>
                </div>
            </div>

            {summary && (
                <div>
                    <div className="text-[13px] font-medium text-muted-foreground">Резюме</div>
                    <p className="mt-1 text-[15px] leading-[1.55] text-foreground">{summary}</p>
                </div>
            )}

            <div>
                <div className="text-[13px] font-medium text-muted-foreground mb-2">Критерии</div>
                <div className="flex flex-col gap-3">
                    {criteria.map(c => (
                        <ScoreBar key={c.key} label={c.label} hint={c.hint} score={analysis.scores[c.key]} />
                    ))}
                </div>
            </div>

            {analysis.red_flags && analysis.red_flags.length > 0 && (
                <div>
                    <div className="flex items-center gap-1.5 text-[13px] font-medium text-destructive">
                        <AlertTriangle className="h-3.5 w-3.5" />
                        Проблемные моменты
                    </div>
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-[14px] text-foreground">
                        {analysis.red_flags.map((f, i) => (
                            <li key={i}>{f}</li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    )
}

function ScoreBar({ label, hint, score }: { label: string; hint: string; score: number }) {
    const pct = Math.max(0, Math.min(100, score * 10))
    return (
        <div className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between">
                <div className="text-[14px] font-medium text-foreground">{label}</div>
                <div className="text-[13px] tabular-nums text-muted-foreground">{score}/10</div>
            </div>
            <div className="text-[12px] text-muted-foreground">{hint}</div>
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surface">
                <div
                    className={`h-full rounded-full ${barColor(score)}`}
                    style={{ width: `${pct}%` }}
                />
            </div>
        </div>
    )
}

function barColor(score: number): string {
    if (score >= 8) return 'bg-accent'
    if (score >= 5) return 'bg-primary'
    return 'bg-destructive'
}

function ScoreCircle({ score }: { score: number | null }) {
    const color = score === null ? 'bg-surface text-muted-foreground' : score >= 8 ? 'bg-accent text-white' : score >= 5 ? 'bg-primary text-white' : 'bg-destructive text-white'
    return (
        <div className={`flex h-14 w-14 items-center justify-center rounded-full text-[20px] font-semibold ${color}`}>
            {score ?? '—'}
        </div>
    )
}

function StatusBadge({ status }: { status: string }) {
    const map: Record<string, { label: string; cls: string }> = {
        completed: { label: 'Завершён',      cls: 'bg-accent/10 text-accent' },
        active:    { label: 'В разговоре',   cls: 'bg-primary/10 text-primary' },
        ringing:   { label: 'Звонит',        cls: 'bg-primary/10 text-primary' },
        missed:    { label: 'Пропущен',      cls: 'bg-destructive/10 text-destructive' },
        no_answer: { label: 'Не ответил',    cls: 'bg-muted/10 text-muted-foreground' },
        busy:      { label: 'Занято',        cls: 'bg-muted/10 text-muted-foreground' },
        rejected:  { label: 'Отклонён',      cls: 'bg-destructive/10 text-destructive' },
        failed:    { label: 'Сбой',          cls: 'bg-destructive/10 text-destructive' },
    }
    const meta = map[status] ?? { label: status, cls: 'bg-muted/10 text-muted-foreground' }
    return (
        <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[12px] font-medium ${meta.cls}`}>
            {meta.label}
        </span>
    )
}

function EmptyState({ icon: Icon, title, hint }: { icon: typeof Sparkles; title: string; hint: string }) {
    return (
        <div className="flex flex-col items-center gap-2 py-10 text-center">
            <Icon className="h-8 w-8 text-muted-foreground/60" />
            <div className="text-[15px] font-semibold text-foreground">{title}</div>
            <div className="max-w-md text-[13px] text-muted-foreground">{hint}</div>
        </div>
    )
}

function iconFor(c: CallDetail) {
    if (c.status === 'missed') return PhoneMissed
    if (c.direction === 'inbound') return PhoneIncoming
    return PhoneOutgoing
}

function colorFor(c: CallDetail): string {
    if (c.status === 'missed') return 'text-destructive'
    if (c.status === 'completed') return 'text-accent'
    return 'text-primary'
}

function bgFor(c: CallDetail): string {
    if (c.status === 'missed') return 'bg-destructive/10'
    if (c.status === 'completed') return 'bg-accent/10'
    return 'bg-primary/10'
}

function formatDuration(sec: number): string {
    const m = Math.floor(sec / 60).toString().padStart(2, '0')
    const s = (sec % 60).toString().padStart(2, '0')
    return `${m}:${s}`
}

function formatPhone(phone: string): string {
    const digits = phone.replace(/\D/g, '')
    if (digits.length === 11 && digits.startsWith('7')) {
        return `+7 ${digits.slice(1, 4)} ${digits.slice(4, 7)}-${digits.slice(7, 9)}-${digits.slice(9)}`
    }
    return phone
}
