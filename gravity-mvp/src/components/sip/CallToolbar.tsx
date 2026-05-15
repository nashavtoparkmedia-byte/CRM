"use client"

import { Phone, PhoneOff, MicOff, Mic } from "lucide-react"
import { useSip } from "@/lib/sip/SipContext"
import { useEffect, useState } from "react"

/**
 * Compact softphone indicator for the top bar. Shows:
 *  - SIP registration status (green dot when registered)
 *  - The extension number this user is bound to
 *  - Active call state with elapsed time, mute, and hangup controls
 */
export default function CallToolbar() {
    const { status, extension, activeCall, hangup, toggleMute } = useSip()
    const [elapsed, setElapsed] = useState(0)

    useEffect(() => {
        if (!activeCall || activeCall.state !== 'active' || !activeCall.answeredAt) {
            setElapsed(0)
            return
        }
        const start = activeCall.answeredAt
        const id = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000)
        return () => clearInterval(id)
    }, [activeCall])

    if (activeCall) {
        return (
            <div className="flex items-center gap-2 bg-primary/10 px-3 py-1 rounded-full text-[13px]">
                <span className="relative flex h-2 w-2">
                    <span className="absolute inset-0 animate-ping rounded-full bg-primary/60"/>
                    <span className="relative h-2 w-2 rounded-full bg-primary"/>
                </span>
                <span className="font-medium text-foreground">
                    {activeCall.displayName ?? activeCall.peerNumber}
                </span>
                <span className="tabular-nums text-muted-foreground">
                    {formatElapsed(elapsed)}
                </span>
                <button
                    onClick={toggleMute}
                    title={activeCall.isMuted ? 'Включить микрофон' : 'Отключить микрофон'}
                    className="ml-1 rounded-full p-1 hover:bg-primary/20"
                >
                    {activeCall.isMuted ? <MicOff className="h-3.5 w-3.5"/> : <Mic className="h-3.5 w-3.5"/>}
                </button>
                <button
                    onClick={hangup}
                    title="Завершить"
                    className="rounded-full bg-destructive p-1 text-white hover:bg-destructive/80"
                >
                    <PhoneOff className="h-3.5 w-3.5"/>
                </button>
            </div>
        )
    }

    return (
        <div
            className="flex items-center gap-1.5 bg-secondary px-2.5 py-1 rounded-full text-[12px]"
            title={statusTitle(status, extension)}
        >
            <span className={`h-2 w-2 rounded-full ${statusColor(status)}`}/>
            <Phone className="h-3.5 w-3.5 text-muted-foreground"/>
            <span className="text-muted-foreground">{extension ?? '—'}</span>
        </div>
    )
}

function statusColor(s: string): string {
    switch (s) {
        case 'registered': return 'bg-green-500'
        case 'connecting': return 'bg-yellow-500 animate-pulse'
        case 'failed': return 'bg-red-500'
        default: return 'bg-gray-400'
    }
}

function statusTitle(s: string, ext: string | null): string {
    switch (s) {
        case 'registered': return `SIP подключён, добавочный ${ext ?? '?'}`
        case 'connecting': return 'Подключение к SIP…'
        case 'failed': return 'Ошибка подключения SIP. Проверьте FreeSWITCH'
        case 'unregistered': return 'SIP отключён'
        default: return 'SIP неактивен'
    }
}

function formatElapsed(sec: number): string {
    const m = Math.floor(sec / 60).toString().padStart(2, '0')
    const s = (sec % 60).toString().padStart(2, '0')
    return `${m}:${s}`
}
