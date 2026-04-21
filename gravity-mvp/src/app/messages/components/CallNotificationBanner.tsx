"use client"

import { useState, useEffect, useRef } from "react"
import { PhoneIncoming, PhoneOutgoing, Phone } from "lucide-react"
import { ActiveCall } from "../hooks/useCallEvents"

export default function CallNotificationBanner({ activeCall }: { activeCall: ActiveCall | null }) {
    const [elapsed, setElapsed] = useState(0)
    const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

    useEffect(() => {
        if (activeCall?.status === 'active') {
            const start = Date.now()
            intervalRef.current = setInterval(() => {
                setElapsed(Math.floor((Date.now() - start) / 1000))
            }, 1000)
        } else {
            setElapsed(0)
        }
        return () => {
            if (intervalRef.current) clearInterval(intervalRef.current)
        }
    }, [activeCall?.status, activeCall?.callSessionId])

    if (!activeCall) return null

    const isRinging = activeCall.status === 'ringing'
    const isInbound = activeCall.direction === 'inbound'
    const Icon = isInbound ? PhoneIncoming : PhoneOutgoing

    const formatTime = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

    const displayName = activeCall.contactName || activeCall.phoneNumber

    return (
        <div className="h-12 flex items-center px-4 gap-3 bg-green-50 border-b border-green-100 shrink-0 animate-in slide-in-from-top-2 duration-200">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
                isRinging ? 'bg-green-500 animate-pulse' : 'bg-green-500'
            }`}>
                <Icon size={16} className="text-white" />
            </div>

            <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-green-900 truncate">
                    {isInbound ? 'Входящий звонок' : 'Исходящий звонок'}
                    {' · '}
                    <span className="font-semibold">{displayName}</span>
                </div>
                {activeCall.phoneNumber !== displayName && (
                    <div className="text-xs text-green-600 font-mono">{activeCall.phoneNumber}</div>
                )}
            </div>

            {!isRinging && (
                <div className="text-sm font-mono text-green-700 tabular-nums">
                    {formatTime(elapsed)}
                </div>
            )}

            {isRinging && (
                <div className="text-xs text-green-600 font-medium">
                    Звонит...
                </div>
            )}
        </div>
    )
}
