"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { PhoneIncoming, PhoneOutgoing, PhoneMissed, Play, Pause, Sparkles } from "lucide-react"

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
}

/**
 * Compact list of recent calls for a driver / contact card. Polls /api/calls
 * once on mount; the SipProvider's SSE subscription keeps the floating
 * popup live, so this list intentionally stays simple.
 *
 * Recordings: if a call has recordingPath, an inline play button sets the
 * shared <audio> src to /api/calls/[id]/recording — Next.js streams the MP3
 * from MinIO server-side, which avoids the Docker-internal hostname and
 * mixed-content issues that arise with presigned URLs.
 */
export default function CallsList({ driverId, contactId, limit = 10 }: { driverId?: string; contactId?: string; limit?: number }) {
    const [calls, setCalls] = useState<CallRow[]>([])
    const [loading, setLoading] = useState(true)
    const [playingCallId, setPlayingCallId] = useState<string | null>(null)
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

    function togglePlay(call: CallRow) {
        if (!call.recordingPath) return
        const audio = audioRef.current
        if (!audio) return

        if (playingCallId === call.id && !audio.paused) {
            audio.pause()
            setPlayingCallId(null)
            return
        }

        audio.src = `/api/calls/${call.id}/recording`
        audio.play()
            .then(() => setPlayingCallId(call.id))
            .catch(err => {
                console.warn('recording play failed', err)
                setPlayingCallId(null)
            })
    }

    if (loading) return <div className="text-[13px] text-muted-foreground py-[2px]">Загрузка…</div>
    if (calls.length === 0) {
        return <div className="text-[13px] text-muted-foreground py-[2px]">Звонков пока нет</div>
    }

    return (
        <>
            <ul className="divide-y divide-border">
                {calls.map(c => (
                    <CallRowItem
                        key={c.id}
                        call={c}
                        isPlaying={playingCallId === c.id}
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
    call, isPlaying, onTogglePlay,
}: {
    call: CallRow
    isPlaying: boolean
    onTogglePlay: () => void
}) {
    const Icon = iconFor(call)
    const peerNumber = call.direction === 'inbound' ? call.fromNumber : call.toNumber
    // The row links to /calls/[id]; the play button stops propagation so a
    // click on the play icon doesn't navigate away while audio is loading.
    return (
        <li className="flex items-center gap-3 py-[2px] rounded-md transition-colors hover:bg-surface">
            <Link
                href={`/calls/${call.id}`}
                className="flex flex-1 items-center gap-3 min-w-0 outline-none"
            >
                <Icon className={`h-[4px] w-[4px] flex-shrink-0 ${colorFor(call)}`}/>
                <div className="min-w-0 flex-1">
                    <div className="text-[13px] text-foreground">{formatPhone(peerNumber)}</div>
                    <div className="text-[11px] text-muted-foreground">
                        {new Date(call.startedAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}
                    </div>
                </div>
                {typeof call.aiScore === 'number' && (
                    <span
                        title={`AI-оценка ${call.aiScore}/10`}
                        className={[
                            'inline-flex items-center gap-1 rounded-full px-[2px] py-0.5 text-[11px] font-medium',
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
                    {call.durationSec ? formatDuration(call.durationSec) : statusLabel(call.status, call.direction)}
                </div>
            </Link>
            {call.recordingPath && (
                <button
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); onTogglePlay() }}
                    title={isPlaying ? 'Пауза' : 'Прослушать запись'}
                    className="ml-1 flex h-7 w-7 items-center justify-center rounded-full bg-primary text-white hover:bg-primary-dark transition-colors"
                >
                    {isPlaying ? (
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
    if (c.direction === 'inbound' && c.status !== 'completed' && c.status !== 'active' && c.status !== 'ringing') return PhoneMissed
    if (c.direction === 'inbound') return PhoneIncoming
    return PhoneOutgoing
}

function colorFor(c: CallRow): string {
    if (c.status === 'completed') return 'text-green-600'
    if (c.direction === 'inbound' && (c.status === 'missed' || c.status === 'no_answer')) return 'text-red-500'
    if (c.direction === 'outbound' && c.status === 'no_answer') return 'text-red-500'
    if (c.status === 'busy') return 'text-red-500'
    return 'text-muted-foreground'
}

function statusLabel(s: string, direction: 'inbound' | 'outbound'): string {
    if (s === 'completed') return 'Завершён'
    if (s === 'active') return '…'
    if (s === 'ringing') return '…'
    if (s === 'missed') return 'Пропущен'
    if (s === 'busy') return 'Занято'
    if (s === 'cancelled') return 'Отменён'
    if (s === 'rejected') return direction === 'inbound' ? 'Отклонён' : 'Отклонён абонентом'
    if (s === 'failed') return 'Сбой'
    if (s === 'no_answer') return direction === 'inbound' ? 'Пропущен' : 'Без ответа'
    return s
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
