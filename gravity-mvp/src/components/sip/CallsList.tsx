"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { PhoneIncoming, PhoneOutgoing, PhoneMissed, Play, Pause, Loader2, Sparkles } from "lucide-react"

interface CallRow {
    id: string
    direction: 'inbound' | 'outbound'
    status: string
    fromNumber: string
    toNumber: string
    startedAt: string
    durationSec: number | null
    recordingPath: string | null
    aiScore?: number | null
    isAi?: boolean
    aiSessionStatus?: 'starting' | 'greeting' | 'active' | 'transferring' | 'ended' | 'failed' | null
    aiSummary?: string | null
}

/**
 * Compact list of recent calls for a driver / contact card. Polls /api/calls
 * once on mount; the SipProvider's SSE subscription keeps the floating
 * popup live, so this list intentionally stays simple.
 *
 * Recordings (Stage 3): if a call has recordingPath, an inline play button
 * lazily fetches a presigned URL from /api/calls/[id]/recording on first
 * click and plays via a single shared <audio> element (only one track at a time).
 */
export default function CallsList({ driverId, contactId, limit = 10 }: { driverId?: string; contactId?: string; limit?: number }) {
    const [calls, setCalls] = useState<CallRow[]>([])
    const [loading, setLoading] = useState(true)
    const [playingCallId, setPlayingCallId] = useState<string | null>(null)
    const [loadingCallId, setLoadingCallId] = useState<string | null>(null)
    const audioRef = useRef<HTMLAudioElement | null>(null)

    useEffect(() => {
        const params = new URLSearchParams()
        if (driverId) params.set('driverId', driverId)
        if (contactId) params.set('contactId', contactId)
        params.set('limit', String(limit))
        fetch(`/api/calls?${params.toString()}`)
            .then(r => r.ok ? r.json() : { calls: [] })
            .then(d => { setCalls(d.calls ?? []); setLoading(false) })
            .catch(() => setLoading(false))
    }, [driverId, contactId, limit])

    async function togglePlay(call: CallRow) {
        if (!call.recordingPath) return
        const audio = audioRef.current
        if (!audio) return

        if (playingCallId === call.id && !audio.paused) {
            audio.pause()
            setPlayingCallId(null)
            return
        }

        setLoadingCallId(call.id)
        try {
            const res = await fetch(`/api/calls/${call.id}/recording`)
            if (!res.ok) throw new Error(`status ${res.status}`)
            const { url } = await res.json()
            audio.src = url
            await audio.play()
            setPlayingCallId(call.id)
        } catch (err) {
            console.warn('recording play failed', err)
            setPlayingCallId(null)
        } finally {
            setLoadingCallId(null)
        }
    }

    if (loading) return <div className="text-[13px] text-muted-foreground py-2">Загрузка…</div>
    if (calls.length === 0) {
        return <div className="text-[13px] text-muted-foreground py-2">Звонков пока нет</div>
    }

    return (
        <>
            <ul className="divide-y divide-border">
                {calls.map(c => (
                    <CallRowItem
                        key={c.id}
                        call={c}
                        isPlaying={playingCallId === c.id}
                        isLoading={loadingCallId === c.id}
                        onTogglePlay={() => togglePlay(c)}
                    />
                ))}
            </ul>
            <audio
                ref={audioRef}
                onEnded={() => setPlayingCallId(null)}
                preload="none"
                className="hidden"
            />
        </>
    )
}

function CallRowItem({
    call, isPlaying, isLoading, onTogglePlay,
}: {
    call: CallRow
    isPlaying: boolean
    isLoading: boolean
    onTogglePlay: () => void
}) {
    const Icon = iconFor(call)
    const peerNumber = call.direction === 'inbound' ? call.fromNumber : call.toNumber
    // The row links to /calls/[id]; the play button stops propagation so a
    // click on the play icon doesn't navigate away while audio is loading.
    return (
        <li className="flex items-center gap-3 py-2 rounded-md transition-colors hover:bg-surface">
            <Link
                href={`/calls/${call.id}`}
                className="flex flex-1 items-center gap-3 min-w-0 outline-none"
            >
                <Icon className={`h-4 w-4 flex-shrink-0 ${colorFor(call)}`}/>
                <div className="min-w-0 flex-1">
                    <div className="text-[13px] text-foreground">{formatPhone(peerNumber)}</div>
                    <div className="text-[11px] text-muted-foreground">
                        {new Date(call.startedAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}
                    </div>
                </div>
                {call.isAi && (
                    <span
                        title={call.aiSummary ?? 'AI-обзвон'}
                        className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary"
                    >
                        <Sparkles className="h-3 w-3"/>
                        ИИ
                    </span>
                )}
                {!call.isAi && typeof call.aiScore === 'number' && (
                    <span
                        title={`AI-оценка ${call.aiScore}/10`}
                        className={[
                            'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
                            call.aiScore >= 8 ? 'bg-accent/10 text-accent'
                            : call.aiScore >= 5 ? 'bg-primary/10 text-primary'
                            : 'bg-destructive/10 text-destructive',
                        ].join(' ')}
                    >
                        <Sparkles className="h-3 w-3"/>
                        {call.aiScore}
                    </span>
                )}
                <div className="text-[12px] tabular-nums text-muted-foreground">
                    {call.durationSec ? formatDuration(call.durationSec) : statusLabel(call.status)}
                </div>
            </Link>
            {call.recordingPath && (
                <button
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); onTogglePlay() }}
                    disabled={isLoading}
                    title={isPlaying ? 'Пауза' : 'Прослушать запись'}
                    className="ml-1 flex h-7 w-7 items-center justify-center rounded-full bg-primary text-white hover:bg-primary-dark disabled:bg-gray-300 transition-colors"
                >
                    {isLoading ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin"/>
                    ) : isPlaying ? (
                        <Pause className="h-3.5 w-3.5"/>
                    ) : (
                        <Play className="h-3.5 w-3.5"/>
                    )}
                </button>
            )}
        </li>
    )
}

function iconFor(c: CallRow) {
    if (c.status === 'missed') return PhoneMissed
    if (c.direction === 'inbound') return PhoneIncoming
    return PhoneOutgoing
}

function colorFor(c: CallRow): string {
    if (c.status === 'missed') return 'text-red-500'
    if (c.status === 'completed') return 'text-green-600'
    return 'text-muted-foreground'
}

function statusLabel(s: string): string {
    return ({ missed: 'Пропущен', no_answer: 'Не ответил', busy: 'Занято', failed: 'Сбой', rejected: 'Отклонён', ringing: '…' } as Record<string, string>)[s] ?? s
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
