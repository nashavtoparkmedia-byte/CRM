"use client"

import { PhoneOff, PhoneOutgoing, PhoneIncoming, MicOff, Mic } from "lucide-react"
import { useEffect, useState } from "react"
import { useSip } from "@/lib/sip/SipContext"

/**
 * Floating card for any active call (outgoing OR an incoming that was
 * already answered). Different from IncomingCallPopup — that one shows
 * Accept/Decline while the phone is ringing. This one shows the live
 * call state once the call is in flight: "Дозваниваюсь…" / "Идёт вызов…"
 * / "Разговор · 01:23", with mute + hangup controls.
 *
 * Sits bottom-right (same corner as the incoming popup, but the two
 * never appear simultaneously — incoming → activeCall via answer()).
 */
export default function ActiveCallPopup() {
    const { activeCall, hangup, toggleMute } = useSip()
    const [elapsed, setElapsed] = useState(0)

    // Tick once a second while the call is up
    useEffect(() => {
        if (!activeCall) {
            setElapsed(0)
            return
        }
        // For active state, start from answeredAt; otherwise from startedAt
        const base = activeCall.state === 'active' && activeCall.answeredAt
            ? activeCall.answeredAt
            : activeCall.startedAt
        setElapsed(Math.floor((Date.now() - base) / 1000))
        const id = setInterval(() => setElapsed(Math.floor((Date.now() - base) / 1000)), 1000)
        return () => clearInterval(id)
    }, [activeCall])

    if (!activeCall) return null

    const isOutbound = activeCall.direction === 'outbound'
    const Icon = isOutbound ? PhoneOutgoing : PhoneIncoming

    const name = activeCall.displayName ?? formatPhone(activeCall.peerNumber)
    const subtitle = activeCall.displayName ? formatPhone(activeCall.peerNumber) : 'Неизвестный номер'

    const statusText =
        activeCall.state === 'connecting' ? (isOutbound ? 'Дозваниваюсь…' : 'Соединение…') :
        activeCall.state === 'ringing' ? 'Идёт вызов…' :
        activeCall.state === 'active' ? `Разговор · ${formatElapsed(elapsed)}` :
        'Завершение…'

    return (
        <div className="fixed bottom-6 right-6 z-50 w-[360px] rounded-md border border-border bg-white shadow-lg animate-in fade-in slide-in-from-bottom-4 duration-200">
            <div className="flex items-center gap-3 px-4 pt-4">
                <div className="relative">
                    {activeCall.state !== 'active' && (
                        <div className="absolute inset-0 rounded-full bg-primary/30 animate-ping"/>
                    )}
                    <div className="relative flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                        <Icon className="h-6 w-6"/>
                    </div>
                </div>
                <div className="min-w-0 flex-1">
                    <div className="text-[15px] font-semibold text-foreground truncate">{name}</div>
                    <div className="text-[12px] text-muted-foreground truncate">{subtitle}</div>
                </div>
            </div>

            <div className="px-4 pt-2 pb-1">
                <div className="text-[13px] text-primary font-medium">{statusText}</div>
            </div>

            <div className="flex gap-2 px-4 py-3">
                <button
                    onClick={toggleMute}
                    disabled={activeCall.state !== 'active'}
                    title={activeCall.isMuted ? 'Включить микрофон' : 'Отключить микрофон'}
                    className="flex items-center justify-center gap-2 rounded-md border border-border bg-white px-3 py-2 text-foreground hover:bg-surface disabled:opacity-40 disabled:cursor-not-allowed transition-colors text-[13px] font-medium"
                >
                    {activeCall.isMuted ? <MicOff className="h-4 w-4"/> : <Mic className="h-4 w-4"/>}
                </button>
                <button
                    onClick={hangup}
                    className="flex flex-1 items-center justify-center gap-2 rounded-md bg-destructive py-2 text-white hover:bg-destructive/90 transition-colors text-[14px] font-medium"
                >
                    <PhoneOff className="h-4 w-4"/>
                    Отбой
                </button>
            </div>
        </div>
    )
}

function formatPhone(phone: string): string {
    const digits = phone.replace(/\D/g, '')
    if (digits.length === 11 && digits.startsWith('7')) {
        return `+7 ${digits.slice(1, 4)} ${digits.slice(4, 7)}-${digits.slice(7, 9)}-${digits.slice(9)}`
    }
    return phone
}

function formatElapsed(sec: number): string {
    const m = Math.floor(sec / 60).toString().padStart(2, '0')
    const s = (sec % 60).toString().padStart(2, '0')
    return `${m}:${s}`
}
