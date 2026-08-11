"use client"

import { useEffect, useRef, useState } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import {
    X, Loader2, Headphones, FileText, Sparkles, AlertTriangle,
    PhoneIncoming, PhoneOutgoing, PhoneMissed, PhoneOff,
} from "lucide-react"
import { callStatusIcon, type CallStatusValue, type CallDirection } from "@/modules/calling/public/v1/call-status-policy"

/**
 * In-chat side-drawer with call details. Reads `?call=<id>` from the URL —
 * empty / absent → drawer is hidden. Click on an inline call-pill in
 * MessageFeed updates that param via router.replace, which makes the drawer
 * slide in WITHOUT navigating away from the chat. Click on the backdrop or
 * the close button strips the param off and the drawer slides out.
 *
 * Responsive:
 *   - ≥1024 px (lg) — slides in from the right, fixed width 460 px, the chat
 *     timeline stays visible to the left and dims slightly under the
 *     backdrop.
 *   - <1024 px       — slides up from the bottom as a full-height sheet
 *     (mobile-friendly, no horizontal squeeze).
 *
 * Replaces the navigation to /calls/[id] for an in-context view. The full
 * /calls/[id] page still exists for deep-linking, but operators rarely
 * need to go there — everything they want is right here.
 */

interface CallDetail {
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
    aiAnalysis: any | null
    managerId: string | null
    managerName: string | null
    driver: { id: string; fullName: string; phone: string | null } | null
    contact: { id: string; displayName: string } | null
}

type TabKey = 'audio' | 'transcript' | 'ai'

export default function CallDetailDrawer() {
    const router = useRouter()
    const pathname = usePathname()
    const searchParams = useSearchParams()
    const callId = searchParams.get('call')
    const autoPlay = searchParams.get('play') === '1'

    function close() {
        const params = new URLSearchParams(searchParams)
        params.delete('call')
        params.delete('play')
        const qs = params.toString()
        router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
    }

    // Escape closes the drawer — feels natural for an overlay.
    useEffect(() => {
        if (!callId) return
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [callId])

    if (!callId) return null

    return (
        <>
            {/* Backdrop — dims rest of UI, click closes the drawer. Mobile
                gets a slightly darker backdrop because the drawer covers
                the full width on phones anyway. */}
            <div
                onClick={close}
                className="fixed inset-0 z-[60] bg-black/40 lg:bg-black/20 animate-in fade-in duration-150"
            />

            {/* Panel — bottom-sheet on mobile, right-side panel on desktop. */}
            <div
                className={[
                    'fixed z-[70] bg-white shadow-2xl flex flex-col',
                    // Mobile: full-width bottom sheet, near-fullscreen height
                    'inset-x-0 bottom-0 top-[10vh] rounded-t-2xl',
                    'animate-in slide-in-from-bottom duration-200',
                    // Desktop: right side panel
                    'lg:inset-y-0 lg:right-0 lg:left-auto lg:top-0 lg:bottom-0 lg:w-[460px] lg:rounded-none',
                    'lg:animate-in lg:slide-in-from-right lg:duration-200',
                ].join(' ')}
            >
                <CallDetailContent callId={callId} autoPlay={autoPlay} onClose={close} />
            </div>
        </>
    )
}

function CallDetailContent({ callId, autoPlay, onClose }: { callId: string; autoPlay: boolean; onClose: () => void }) {
    const [call, setCall] = useState<CallDetail | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    // If we came in via the inline play button, force the Audio tab regardless
    // of what's "ready" — the operator clearly wants to hear the recording.
    const [activeTab, setActiveTab] = useState<TabKey>(autoPlay ? 'audio' : 'audio')

    useEffect(() => {
        let aborted = false
        async function load() {
            setLoading(true)
            setError(null)
            try {
                const r = await fetch(`/api/calls/${callId}`)
                if (!r.ok) throw new Error(`status ${r.status}`)
                const body = await r.json()
                if (aborted) return
                const c = body.call ?? body
                setCall(c)
                // Pick the initial tab only when the user did NOT explicitly
                // ask to play — otherwise stay on "Аудио".
                if (!autoPlay) {
                    setActiveTab(c.aiAnalysis ? 'ai' : c.transcript ? 'transcript' : 'audio')
                }
            } catch (e: any) {
                if (!aborted) setError(e.message ?? 'не удалось загрузить звонок')
            } finally {
                if (!aborted) setLoading(false)
            }
        }
        load()
        return () => { aborted = true }
    }, [callId, autoPlay])

    // SSE: refresh when transcribe/analyze workers finish for this call.
    useEffect(() => {
        const es = new EventSource('/api/calls/stream')
        es.onmessage = async (msg) => {
            try {
                const evt = JSON.parse(msg.data)
                if (evt?.data?.callId !== callId) return
                if (evt?.type === 'updated' || evt?.type === 'ended') {
                    const r = await fetch(`/api/calls/${callId}`)
                    if (r.ok) {
                        const body = await r.json()
                        setCall(body.call ?? body)
                    }
                }
            } catch {}
        }
        return () => es.close()
    }, [callId])

    const peerName = call?.driver?.fullName ?? call?.contact?.displayName ?? null
    const peerNumber = call ? (call.direction === 'inbound' ? call.fromNumber : call.toNumber) : ''
    const iconKind = call ? callStatusIcon(call.direction as CallDirection, call.status as CallStatusValue) : 'outgoing'
    const Icon =
        iconKind === 'missed'   ? PhoneMissed :
        iconKind === 'failed'   ? PhoneOff :
        iconKind === 'incoming' ? PhoneIncoming :
                                  PhoneOutgoing

    return (
        <>
            {/* Header */}
            <div className="flex items-center gap-3 border-b border-gray-200 px-[4px] py-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
                    <Icon className="h-5 w-5 text-primary" />
                </div>
                <div className="min-w-0 flex-1">
                    <div className="truncate text-[15px] font-semibold text-foreground">
                        {peerName ?? formatPhone(peerNumber) ?? 'Звонок'}
                    </div>
                    <div className="text-[12px] text-muted-foreground truncate">
                        {call ? (
                            <>
                                {call.direction === 'inbound' ? 'Входящий' : 'Исходящий'} ·{' '}
                                {formatPhone(peerNumber)}
                                {call.durationSec ? ` · ${formatDuration(call.durationSec)}` : ''}
                            </>
                        ) : 'Загрузка…'}
                    </div>
                </div>
                <button
                    onClick={onClose}
                    className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-surface hover:text-foreground transition-colors"
                    title="Закрыть (Esc)"
                >
                    <X className="h-5 w-5" />
                </button>
            </div>

            {/* Tabs */}
            <div className="flex items-center gap-1 border-b border-gray-200 px-[2px] pt-[2px]">
                <TabButton active={activeTab === 'audio'} onClick={() => setActiveTab('audio')} icon={Headphones} label="Аудио" ready={!!call?.recordingPath} />
                <TabButton active={activeTab === 'transcript'} onClick={() => setActiveTab('transcript')} icon={FileText} label="Транскрипт" ready={!!call?.transcript} />
                <TabButton active={activeTab === 'ai'} onClick={() => setActiveTab('ai')} icon={Sparkles} label="AI-анализ" ready={!!call?.aiAnalysis} />
            </div>

            {/* Body — scrollable */}
            <div className="flex-1 overflow-y-auto p-5">
                {loading && (
                    <div className="flex items-center gap-[2px] text-[13px] text-muted-foreground">
                        <Loader2 className="h-[4px] w-[4px] animate-spin" /> Загрузка…
                    </div>
                )}
                {error && !loading && (
                    <div className="text-[13px] text-destructive">Ошибка: {error}</div>
                )}
                {call && !loading && !error && (
                    <>
                        {activeTab === 'audio' && <AudioPane call={call} autoPlay={autoPlay} />}
                        {activeTab === 'transcript' && <TranscriptPane transcript={call.transcript} />}
                        {activeTab === 'ai' && <AiPane analysis={call.aiAnalysis} summary={call.aiSummary} score={call.aiScore} />}
                    </>
                )}
            </div>
        </>
    )
}

function TabButton({
    active, onClick, icon: Icon, label, ready,
}: {
    active: boolean
    onClick: () => void
    icon: typeof Headphones
    label: string
    ready: boolean
}) {
    return (
        <button
            onClick={onClick}
            className={[
                'inline-flex items-center gap-1.5 rounded-t-md px-3 py-[2px] text-[13px] font-medium transition-colors',
                active
                    ? 'bg-surface text-foreground border-b-2 border-primary'
                    : 'text-muted-foreground hover:text-foreground hover:bg-surface',
            ].join(' ')}
        >
            <Icon className="h-3.5 w-3.5" />
            {label}
            {!ready && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground/60" />}
        </button>
    )
}

function AudioPane({ call, autoPlay }: { call: CallDetail; autoPlay?: boolean }) {
    const audioRef = useRef<HTMLAudioElement | null>(null)

    if (!call.recordingPath) {
        return <EmptyState icon={Headphones} title="Записи нет" hint="Запись появляется через несколько секунд после завершения разговора." />
    }

    return (
        <div className="flex flex-col gap-3">
            <audio
                ref={audioRef}
                src={`/api/calls/${call.id}/recording`}
                controls
                preload="auto"
                className="w-full"
                onLoadedMetadata={() => {
                    // autoPlay triggered from play-button pill click — safe under Chrome autoplay policy
                    // because the gesture chain is still active when metadata loads.
                    if (autoPlay && audioRef.current) {
                        audioRef.current.play().catch(() => { /* blocked — controls visible */ })
                    }
                }}
            />
        </div>
    )
}

function TranscriptPane({ transcript }: { transcript: string | null }) {
    if (!transcript) return <EmptyState icon={FileText} title="Транскрипт обрабатывается" hint="Whisper расшифровывает запись. Обычно 5–15 секунд." />
    return <div className="whitespace-pre-wrap text-[14px] leading-[1.55] text-foreground">{transcript}</div>
}

function AiPane({ analysis, summary, score }: { analysis: any; summary: string | null; score: number | null }) {
    if (!analysis) return <EmptyState icon={Sparkles} title="AI-анализ готовится" hint="Оценка появится через несколько секунд после транскрипта." />
    const scores = (analysis.scores ?? {}) as Record<string, number>
    const flags = (analysis.red_flags ?? []) as string[]
    const outcome = analysis.outcome as string | undefined
    const sentiment = analysis.client_sentiment as string | undefined
    const nextAction = analysis.next_action_type as string | undefined

    return (
        <div className="flex flex-col gap-5">
            <div className="flex items-center gap-3">
                <div className={`flex h-14 w-14 items-center justify-center rounded-full text-[18px] font-bold ${score === null ? 'bg-surface text-muted-foreground' : score >= 8 ? 'bg-emerald-500 text-white' : score >= 5 ? 'bg-primary text-white' : 'bg-red-500 text-white'}`}>
                    {score ?? '—'}
                </div>
                <div>
                    <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Общая оценка</div>
                    <div className="text-[18px] font-semibold">{score !== null ? `${score} / 10` : '—'}</div>
                </div>
            </div>

            {summary && (
                <div>
                    <div className="text-[12px] font-medium text-muted-foreground">Резюме</div>
                    <p className="mt-1 text-[14px] leading-[1.55]">{summary}</p>
                </div>
            )}

            {(outcome || sentiment || nextAction) && (
                <div className="flex flex-wrap gap-[2px] text-[11px]">
                    {outcome && <span className="rounded-full bg-primary/10 px-[2px] py-1 text-primary">Итог: {outcome}</span>}
                    {sentiment && <span className="rounded-full bg-surface px-[2px] py-1 text-foreground">Настроение: {sentiment}</span>}
                    {nextAction && <span className="rounded-full bg-surface px-[2px] py-1 text-foreground">Действие: {nextAction}</span>}
                </div>
            )}

            <div>
                <div className="text-[12px] font-medium text-muted-foreground mb-[2px]">Критерии</div>
                <div className="flex flex-col gap-2.5">
                    {Object.entries(scores).map(([key, val]) => (
                        <div key={key} className="flex flex-col gap-1">
                            <div className="flex items-baseline justify-between">
                                <span className="text-[13px] text-foreground">{key}</span>
                                <span className="text-[12px] tabular-nums text-muted-foreground">{val}</span>
                            </div>
                            <div className="h-1.5 w-full rounded-full bg-surface overflow-hidden">
                                <div
                                    className={`h-full rounded-full ${val >= 8 ? 'bg-emerald-500' : val >= 5 ? 'bg-primary' : 'bg-red-500'}`}
                                    style={{ width: `${Math.min(100, val * 10)}%` }}
                                />
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {flags.length > 0 && (
                <div>
                    <div className="flex items-center gap-1.5 text-[12px] font-medium text-destructive">
                        <AlertTriangle className="h-3.5 w-3.5" />
                        Проблемные моменты
                    </div>
                    <ul className="mt-[2px] list-disc space-y-1 pl-5 text-[13px]">
                        {flags.map((f, i) => <li key={i}>{f}</li>)}
                    </ul>
                </div>
            )}
        </div>
    )
}

function EmptyState({ icon: Icon, title, hint }: { icon: typeof Sparkles; title: string; hint: string }) {
    return (
        <div className="flex flex-col items-center gap-[2px] py-10 text-center">
            <Icon className="h-[8px] w-[8px] text-muted-foreground/60" />
            <div className="text-[14px] font-semibold">{title}</div>
            <div className="max-w-xs text-[12px] text-muted-foreground">{hint}</div>
        </div>
    )
}

function formatDuration(sec: number): string {
    const m = Math.floor(sec / 60).toString().padStart(2, '0')
    const s = (sec % 60).toString().padStart(2, '0')
    return `${m}:${s}`
}

function formatPhone(phone: string | null | undefined): string {
    if (!phone) return ''
    const digits = phone.replace(/\D/g, '')
    if (digits.length === 11 && digits.startsWith('7')) {
        return `+7 ${digits.slice(1, 4)} ${digits.slice(4, 7)}-${digits.slice(7, 9)}-${digits.slice(9)}`
    }
    return phone
}
