"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import {
    PhoneIncoming, PhoneOutgoing, PhoneMissed, PhoneOff,
    Loader2, ArrowLeft, Sparkles, Headphones, FileText, AlertTriangle,
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
    aiAnalysis: CallAnalysisShape | null
    controlledDispatchState: 'claimed' | 'accepted' | 'rejected' | 'outcome_unknown' | null
    controlledDispatchFailureCode: string | null
    managerId: string | null
    managerName: string | null
    driver: { id: string; fullName: string; phone: string | null } | null
    contact: { id: string; displayName: string } | null
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

            {call.controlledDispatchState === 'outcome_unknown' && (
                <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-4 text-[13px] text-amber-900 dark:text-amber-200">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                        FreeSWITCH получил команду, но подтверждение потеряно. Повторный звонок запрещён:
                        сначала проверьте этот Call, канал FreeSWITCH и кабинет провайдера.
                    </span>
                </div>
            )}
            {call.controlledDispatchState === 'claimed' && (
                <div className="flex items-start gap-2 rounded-md border border-border bg-surface p-4 text-[13px] text-muted-foreground">
                    <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
                    <span>Ожидается подтверждение единственной provider-попытки. Не запускайте повторный запрос.</span>
                </div>
            )}

            <div className="rounded-md border border-border bg-card">
                <Tabs active={activeTab} onChange={setActiveTab} call={call} />
                <div className="p-6">
                    {activeTab === 'audio' && <AudioPane call={call} />}
                    {activeTab === 'transcript' && <TranscriptPane transcript={call.transcript} />}
                    {activeTab === 'ai' && <AiPane analysis={call.aiAnalysis} summary={call.aiSummary} score={call.aiScore} />}
                </div>
            </div>
        </div>
    )
}

function initialTabFor(c: CallDetail): TabKey {
    if (c.aiAnalysis) return 'ai'
    if (c.transcript) return 'transcript'
    return 'audio'
}

function CallHeader({ call, peerName, peerNumber }: { call: CallDetail; peerName: string | null; peerNumber: string }) {
    return (
        <div className="flex items-center gap-[4px] rounded-md border border-border bg-card p-5">
            <div className={`flex h-12 w-12 items-center justify-center rounded-full ${bgFor(call)}`}>
                <CallIcon call={call} />
            </div>
            <div className="min-w-0 flex-1">
                <div className="truncate text-[17px] font-semibold text-foreground">
                    {peerName ?? formatPhone(peerNumber)}
                </div>
                <div className="text-[13px] text-muted-foreground">
                    {call.direction === 'inbound' ? 'Входящий' : 'Исходящий'} ·
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
            <StatusBadge status={call.status} direction={call.direction} />
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
        <div className="flex items-center gap-1 border-b border-border px-3 pt-[2px]">
            {items.map(it => {
                const Icon = it.icon
                const isActive = active === it.key
                return (
                    <button
                        key={it.key}
                        onClick={() => onChange(it.key)}
                        className={[
                            'inline-flex items-center gap-1.5 rounded-t-md px-3 py-[2px] text-[13px] font-medium transition-colors',
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
    if (!call.recordingPath) {
        return <EmptyState icon={Headphones} title="Записи нет" hint="Запись появляется через несколько секунд после завершения разговора." />
    }

    return (
        <div className="flex flex-col gap-3">
            <audio src={`/api/calls/${call.id}/recording`} controls preload="metadata" className="w-full" />
            <p className="text-[12px] text-muted-foreground">
                Перейдите по табу <span className="text-foreground">Транскрипт</span> или <span className="text-foreground">AI-анализ</span>, чтобы увидеть обработку.
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
            <div className="flex items-center gap-[4px]">
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

            {/* PR9.43: analysis.scores может быть undefined для звонков с
                aiAnalysis старого формата (Whisper-only без rubric-LLM)
                или с частичным анализом. Раньше падало TypeError
                «Cannot read properties of undefined (reading 'greeting')».
                Теперь — graceful skip с empty-state. */}
            {analysis.scores && (
                <div>
                    <div className="text-[13px] font-medium text-muted-foreground mb-[2px]">Критерии</div>
                    <div className="flex flex-col gap-3">
                        {criteria.map(c => (
                            <ScoreBar
                                key={c.key}
                                label={c.label}
                                hint={c.hint}
                                score={analysis.scores?.[c.key] ?? 0}
                            />
                        ))}
                    </div>
                </div>
            )}

            {analysis.red_flags && analysis.red_flags.length > 0 && (
                <div>
                    <div className="flex items-center gap-1.5 text-[13px] font-medium text-destructive">
                        <AlertTriangle className="h-3.5 w-3.5" />
                        Проблемные моменты
                    </div>
                    <ul className="mt-[2px] list-disc space-y-1 pl-5 text-[14px] text-foreground">
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

function StatusBadge({ status, direction }: { status: string; direction: 'inbound' | 'outbound' }) {
    // Direction-aware short labels for the journal badge. The longer per-pill
    // label lives in callStatusLabel (lib/calls/status.ts).
    const badgeFor = (s: string, d: 'inbound' | 'outbound') => {
        if (s === 'completed') return { label: 'Завершён',         cls: 'bg-accent/10 text-accent' }
        if (s === 'active')    return { label: 'В разговоре',      cls: 'bg-primary/10 text-primary' }
        if (s === 'ringing')   return { label: 'Звонит',           cls: 'bg-primary/10 text-primary' }
        if (s === 'missed')    return { label: 'Пропущен',         cls: 'bg-destructive/10 text-destructive' }
        if (s === 'busy')      return { label: 'Занято',           cls: 'bg-muted/10 text-muted-foreground' }
        if (s === 'rejected')  return { label: 'Отклонён',         cls: 'bg-destructive/10 text-destructive' }
        if (s === 'cancelled') return { label: 'Отменён',          cls: 'bg-muted/10 text-muted-foreground' }
        if (s === 'failed')    return { label: 'Сбой',             cls: 'bg-destructive/10 text-destructive' }
        if (s === 'no_answer') return d === 'inbound'
            ? { label: 'Пропущен',      cls: 'bg-destructive/10 text-destructive' }
            : { label: 'Без ответа',    cls: 'bg-destructive/10 text-destructive' }
        return { label: s, cls: 'bg-muted/10 text-muted-foreground' }
    }
    const meta = badgeFor(status, direction)
    return (
        <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[12px] font-medium ${meta.cls}`}>
            {meta.label}
        </span>
    )
}

function EmptyState({ icon: Icon, title, hint }: { icon: typeof Sparkles; title: string; hint: string }) {
    return (
        <div className="flex flex-col items-center gap-[2px] py-10 text-center">
            <Icon className="h-[8px] w-[8px] text-muted-foreground/60" />
            <div className="text-[15px] font-semibold text-foreground">{title}</div>
            <div className="max-w-md text-[13px] text-muted-foreground">{hint}</div>
        </div>
    )
}

function CallIcon({ call }: { call: CallDetail }) {
    // Inbound that wasn't answered (missed / no_answer / rejected / busy /
    // cancelled) = missed-style icon. Outbound failures keep the "outgoing"
    // arrow — direction + color tells the user "you called and it didn't go
    // through". Failed (technical) gets PhoneOff.
    const iconClassName = `h-5 w-5 ${colorFor(call)}`
    const status = call.status
    if (status === 'failed') return <PhoneOff className={iconClassName} />
    if (call.direction === 'inbound' && status !== 'completed' && status !== 'active' && status !== 'ringing') {
        return <PhoneMissed className={iconClassName} />
    }
    if (call.direction === 'inbound') return <PhoneIncoming className={iconClassName} />
    return <PhoneOutgoing className={iconClassName} />
}

function colorFor(c: CallDetail): string {
    if (c.status === 'completed' || c.status === 'active' || c.status === 'ringing') return 'text-accent'
    if (c.direction === 'inbound' && (c.status === 'missed' || c.status === 'no_answer')) return 'text-destructive'
    if (c.direction === 'outbound' && c.status === 'no_answer') return 'text-destructive'
    if (c.status === 'busy') return 'text-destructive'
    return 'text-muted-foreground'
}

function bgFor(c: CallDetail): string {
    if (c.status === 'completed' || c.status === 'active' || c.status === 'ringing') return 'bg-accent/10'
    if (c.direction === 'inbound' && (c.status === 'missed' || c.status === 'no_answer')) return 'bg-destructive/10'
    if (c.direction === 'outbound' && c.status === 'no_answer') return 'bg-destructive/10'
    if (c.status === 'busy') return 'bg-destructive/10'
    return 'bg-muted/10'
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
