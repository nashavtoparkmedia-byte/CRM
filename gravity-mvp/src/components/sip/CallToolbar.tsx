"use client"

import { Phone, PhoneOff, MicOff, Mic, RefreshCw, Volume2, VolumeX } from "lucide-react"
import { useSip } from '@/modules/calling/public/v1/sip-client-context'
import { useEffect, useState } from "react"

/**
 * Compact softphone indicator for the top bar. Shows:
 *  - SIP registration status (green dot when registered)
 *  - The extension number this user is bound to
 *  - Active call state with elapsed time, mute, and hangup controls
 */
export default function CallToolbar() {
    const {
        status,
        extension,
        activeCall,
        hangup,
        toggleMute,
        callAlertAudioStatus,
        enableCallAlerts,
        reconnect,
    } = useSip()
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
            <div className="flex items-center gap-[2px] bg-primary/10 px-3 py-1 rounded-full text-[13px]">
                <span className="relative flex h-[2px] w-[2px]">
                    <span className="absolute inset-0 animate-ping rounded-full bg-primary/60"/>
                    <span className="relative h-[2px] w-[2px] rounded-full bg-primary"/>
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
        <div className="flex items-center gap-1.5">
            <button
                type="button"
                onClick={() => {
                    if (status === 'identity-required') window.location.assign('/login')
                    else if (status !== 'registered') void reconnect()
                }}
                disabled={status === 'registered' || status === 'connecting'}
                className="flex items-center gap-1.5 bg-secondary px-2.5 py-1 rounded-full text-[12px]"
                title={statusTitle(status, extension)}
            >
                <span className={`h-[2px] w-[2px] rounded-full ${statusColor(status)}`}/>
                {status === 'connecting'
                    ? <RefreshCw className="h-3.5 w-3.5 animate-spin text-muted-foreground"/>
                    : <Phone className="h-3.5 w-3.5 text-muted-foreground"/>
                }
                <span className="text-muted-foreground">{extension ?? '—'}</span>
            </button>

            {callAlertAudioStatus === 'needs-interaction' && (
                <button
                    type="button"
                    onClick={() => { void enableCallAlerts() }}
                    title="Chrome требует один клик, чтобы разрешить рингтон входящих звонков"
                    className="flex items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-[12px] font-medium text-amber-900 hover:bg-amber-100"
                >
                    <VolumeX className="h-3.5 w-3.5"/>
                    <span className="max-xl:hidden">Включить звук</span>
                </button>
            )}

            {callAlertAudioStatus === 'unsupported' && (
                <span title="Браузер не поддерживает звук звонка" className="rounded-full bg-secondary p-1.5 text-muted-foreground">
                    <VolumeX className="h-3.5 w-3.5"/>
                </span>
            )}

            {callAlertAudioStatus === 'ready' && (
                <span title="Звук входящих звонков включён" className="text-green-600">
                    <Volume2 className="h-3.5 w-3.5"/>
                </span>
            )}
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
        case 'identity-required': return 'Выберите пользователя CRM, чтобы принимать звонки'
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
