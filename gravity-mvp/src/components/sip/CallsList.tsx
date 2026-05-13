"use client"

import { useEffect, useState } from "react"
import { PhoneIncoming, PhoneOutgoing, PhoneMissed } from "lucide-react"

interface CallRow {
    id: string
    direction: 'inbound' | 'outbound'
    status: string
    fromNumber: string
    toNumber: string
    startedAt: string
    durationSec: number | null
}

/**
 * Compact list of recent calls for a driver / contact card. Polls /api/calls
 * once on mount; the SipProvider's SSE subscription keeps the floating
 * popup live, so this list intentionally stays simple.
 */
export default function CallsList({ driverId, contactId, limit = 10 }: { driverId?: string; contactId?: string; limit?: number }) {
    const [calls, setCalls] = useState<CallRow[]>([])
    const [loading, setLoading] = useState(true)

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

    if (loading) return <div className="text-[13px] text-muted-foreground py-2">Загрузка…</div>
    if (calls.length === 0) {
        return <div className="text-[13px] text-muted-foreground py-2">Звонков пока нет</div>
    }

    return (
        <ul className="divide-y divide-border">
            {calls.map(c => <CallRowItem key={c.id} call={c}/>)}
        </ul>
    )
}

function CallRowItem({ call }: { call: CallRow }) {
    const Icon = iconFor(call)
    const peerNumber = call.direction === 'inbound' ? call.fromNumber : call.toNumber
    return (
        <li className="flex items-center gap-3 py-2">
            <Icon className={`h-4 w-4 flex-shrink-0 ${colorFor(call)}`}/>
            <div className="min-w-0 flex-1">
                <div className="text-[13px] text-foreground">{formatPhone(peerNumber)}</div>
                <div className="text-[11px] text-muted-foreground">
                    {new Date(call.startedAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}
                </div>
            </div>
            <div className="text-[12px] tabular-nums text-muted-foreground">
                {call.durationSec ? formatDuration(call.durationSec) : statusLabel(call.status)}
            </div>
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
