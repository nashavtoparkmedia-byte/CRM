"use client"

import { Phone, PhoneOff, User, Volume2, VolumeX } from "lucide-react"
import Link from "next/link"
import { useEffect, useRef, useState } from "react"
import { useSip } from "@/lib/sip/SipContext"
import { startIncomingRingtone, type ActiveRingtone } from "@/lib/sip/callAlertAudio"

/**
 * Compact incoming-call card (bottom-right). Visual style intentionally close
 * to the original Telegram-like toast — full-screen modal was over-bearing.
 *
 * Cross-cutting attention boosters kept from the modal version:
 *  - WebAudio ringtone (440Hz + 480Hz, 2s on / 2s off)
 *  - Tab title flashes "📞 Входящий…" so it's visible from another tab
 *  - Native Notification API when permission was already granted in Chrome
 *    (requireInteraction keeps it visible until the user clicks)
 *  - Visible ring-duration counter, autoFocus on "Принять" (Enter accepts)
 */
export default function IncomingCallPopup() {
    const {
        incomingCall,
        incomingAlert,
        answer,
        decline,
        activeCall,
        callAlertAudioStatus,
        enableCallAlerts,
    } = useSip()
    const [elapsed, setElapsed] = useState(0)
    const [isAnswering, setIsAnswering] = useState(false)
    const ringtoneRef = useRef<ActiveRingtone | null>(null)
    const originalTitleRef = useRef<string>('')
    const attentionCall = incomingCall ?? incomingAlert

    // Reset answering state when popup clears (call ended/declined)
    useEffect(() => {
        if (!incomingCall) setIsAnswering(false)
    }, [incomingCall])

    // The ringtone uses the AudioContext that was unlocked by a previous
    // click in the CRM. Re-run when the manager explicitly enables sound
    // during an already-ringing call.
    useEffect(() => {
        ringtoneRef.current?.stop()
        ringtoneRef.current = null
        if (!attentionCall) return

        let cancelled = false
        void startIncomingRingtone()
            .then(ringtone => {
                if (cancelled) ringtone?.stop()
                else ringtoneRef.current = ringtone
            })
            .catch(err => console.warn('[SIP] ringtone playback failed', err))

        return () => {
            cancelled = true
            ringtoneRef.current?.stop()
            ringtoneRef.current = null
        }
    }, [attentionCall, callAlertAudioStatus])

    useEffect(() => {
        if (!attentionCall) {
            if (originalTitleRef.current) {
                document.title = originalTitleRef.current
                originalTitleRef.current = ''
            }
            setElapsed(0)
            return
        }

        // Tab title flash
        if (!originalTitleRef.current) originalTitleRef.current = document.title
        const titles = ['📞 Входящий…', `📞 ${attentionCall.displayName ?? attentionCall.fromNumber}`]
        let i = 0
        const titleFlip = setInterval(() => {
            document.title = titles[i++ % titles.length]
        }, 700)

        // Native browser notification
        let notification: Notification | null = null
        try {
            // Browsers reject permission prompts that are not initiated by a
            // user gesture. Only show a notification when permission has
            // already been granted in Chrome's site settings.
            if ('Notification' in window && Notification.permission === 'granted') {
                notification = new Notification('Входящий звонок', {
                    body: `${attentionCall.displayName ?? attentionCall.fromNumber}`,
                    tag: 'crm-call',
                    requireInteraction: true,
                    silent: true,
                })
                notification.onclick = () => { window.focus(); notification?.close() }
            }
        } catch {
            // The visual CRM alert remains available when native notifications
            // are disabled by browser or operating-system policy.
        }

        // Elapsed counter
        const startedAt = Date.now()
        const tick = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000)

        return () => {
            clearInterval(titleFlip)
            clearInterval(tick)
            notification?.close()
        }
    }, [attentionCall])

    if (!attentionCall) return null

    const name = attentionCall.displayName ?? formatPhone(attentionCall.fromNumber)
    const subtitle = attentionCall.displayName ? formatPhone(attentionCall.fromNumber) : 'Неизвестный номер'

    return (
        <div className={`fixed ${activeCall ? 'bottom-[220px]' : 'bottom-6'} right-6 z-[60] w-[360px] rounded-md border border-border bg-white shadow-lg animate-in fade-in slide-in-from-bottom-4 duration-200`}>
            <div className="flex items-center gap-3 px-4 pt-4">
                <div className="relative">
                    <div className="absolute inset-0 rounded-full bg-primary/30 animate-ping"/>
                    <div className="relative flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                        <User className="h-6 w-6"/>
                    </div>
                </div>
                <div className="min-w-0 flex-1">
                    <div className="text-[15px] font-semibold text-foreground truncate">{name}</div>
                    <div className="text-[12px] text-muted-foreground">{subtitle}</div>
                </div>
                <span className="text-[11px] text-primary animate-pulse">{elapsed}s</span>
            </div>

            {callAlertAudioStatus !== 'ready' && (
                <div className="px-4 pt-3">
                    {callAlertAudioStatus === 'needs-interaction' ? (
                        <button
                            type="button"
                            onClick={() => { void enableCallAlerts() }}
                            className="flex w-full items-center justify-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] font-medium text-amber-900 hover:bg-amber-100"
                        >
                            <VolumeX className="h-4 w-4"/>
                            Chrome заблокировал звук — включить
                        </button>
                    ) : (
                        <div className="flex items-center gap-2 rounded-md bg-gray-100 px-3 py-2 text-[12px] text-gray-600">
                            <VolumeX className="h-4 w-4"/>
                            Этот браузер не поддерживает звук звонка
                        </div>
                    )}
                </div>
            )}

            {attentionCall.driverId && (
                <div className="px-4 pt-1">
                    <Link
                        href={`/drivers/${attentionCall.driverId}`}
                        className="text-[12px] text-primary hover:underline"
                    >
                        Открыть карточку водителя →
                    </Link>
                </div>
            )}

            {incomingCall ? (
                <div className="flex gap-2 px-4 py-3">
                    <button
                        onClick={decline}
                        disabled={isAnswering}
                        className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-destructive py-2.5 text-white hover:bg-destructive/90 transition-colors text-[14px] font-medium disabled:opacity-50"
                    >
                        <PhoneOff className="h-4 w-4"/>
                        Отклонить
                    </button>
                    <button
                        onClick={() => { setIsAnswering(true); answer() }}
                        autoFocus
                        disabled={isAnswering}
                        className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-emerald-600 py-2.5 text-white hover:bg-emerald-700 transition-colors text-[14px] font-medium disabled:opacity-75"
                    >
                        {isAnswering
                            ? <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="32" strokeLinecap="round"/></svg>
                            : <Phone className="h-4 w-4"/>
                        }
                        {isAnswering ? 'Подключение...' : 'Принять'}
                    </button>
                </div>
            ) : (
                <div className="flex items-center gap-2 px-4 py-3 text-[12px] text-muted-foreground">
                    <Volume2 className="h-4 w-4 text-primary"/>
                    Звонок поступил на подключённое рабочее место
                </div>
            )}
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
