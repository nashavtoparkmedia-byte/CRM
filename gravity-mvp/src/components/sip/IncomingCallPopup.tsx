"use client"

import { Phone, PhoneOff, User } from "lucide-react"
import Link from "next/link"
import { useEffect, useRef, useState } from "react"
import { useSip } from "@/lib/sip/SipContext"

/**
 * Modal-style incoming-call card. Designed to be impossible to miss:
 *  - Dimmed full-page backdrop (z-50)
 *  - Centered ~440px card with pulsing avatar
 *  - Ringtone loop via WebAudio (no asset needed; double-frequency tone)
 *  - Browser tab title flashes "📞 Входящий..." so it's visible in the favicon area
 *  - Native browser Notification (asks permission once) — fires even when the
 *    CRM tab is in the background, so the manager won't miss a call while on
 *    another tab
 *  - Visible ring-duration counter (FS hangs up at ~30s anyway)
 */
export default function IncomingCallPopup() {
    const { incomingCall, answer, decline } = useSip()
    const [elapsed, setElapsed] = useState(0)
    const ringtoneRef = useRef<{ stop: () => void } | null>(null)
    const originalTitleRef = useRef<string>('')

    // Side effects when an incoming call appears
    useEffect(() => {
        if (!incomingCall) {
            // Cleanup on disappearance
            ringtoneRef.current?.stop()
            ringtoneRef.current = null
            if (originalTitleRef.current) {
                document.title = originalTitleRef.current
                originalTitleRef.current = ''
            }
            setElapsed(0)
            return
        }

        // 1. Start a WebAudio ringtone (no external file required).
        try {
            const Ctx: typeof AudioContext = (window.AudioContext ?? (window as any).webkitAudioContext)
            const ctx = new Ctx()
            const gain = ctx.createGain()
            gain.gain.value = 0.08            // soft but audible
            gain.connect(ctx.destination)
            const o1 = ctx.createOscillator()
            const o2 = ctx.createOscillator()
            o1.type = 'sine'; o1.frequency.value = 440
            o2.type = 'sine'; o2.frequency.value = 480
            o1.connect(gain); o2.connect(gain)
            o1.start(); o2.start()
            // North-American-style ring cadence: 2s on, 4s off, repeat
            let on = true
            const pulse = setInterval(() => {
                on = !on
                gain.gain.value = on ? 0.08 : 0
            }, 2000)
            ringtoneRef.current = {
                stop: () => {
                    clearInterval(pulse)
                    try { o1.stop(); o2.stop(); ctx.close() } catch {}
                },
            }
        } catch (err) {
            console.warn('[SIP] ringtone playback failed', err)
        }

        // 2. Flash tab title
        if (!originalTitleRef.current) originalTitleRef.current = document.title
        const titles = ['📞 Входящий…', `📞 ${incomingCall.displayName ?? incomingCall.fromNumber}`]
        let i = 0
        const titleFlip = setInterval(() => {
            document.title = titles[i++ % titles.length]
        }, 700)

        // 3. Native browser notification (best-effort)
        let notification: Notification | null = null
        ;(async () => {
            try {
                if ('Notification' in window) {
                    let perm = Notification.permission
                    if (perm === 'default') perm = await Notification.requestPermission()
                    if (perm === 'granted') {
                        notification = new Notification('Входящий звонок', {
                            body: `${incomingCall.displayName ?? incomingCall.fromNumber}`,
                            tag: 'crm-call',                // collapses duplicates
                            requireInteraction: true,       // don't auto-dismiss
                            silent: true,                   // ringtone handles audio
                        })
                        notification.onclick = () => { window.focus(); notification?.close() }
                    }
                }
            } catch { /* ignore */ }
        })()

        // 4. Elapsed-time counter
        const startedAt = Date.now()
        const tick = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000)

        return () => {
            clearInterval(titleFlip)
            clearInterval(tick)
            notification?.close()
        }
    }, [incomingCall])

    if (!incomingCall) return null

    const name = incomingCall.displayName ?? formatPhone(incomingCall.fromNumber)
    const subtitle = incomingCall.displayName ? formatPhone(incomingCall.fromNumber) : 'Неизвестный номер'

    return (
        <>
            {/* Full-screen dimmed backdrop so the call is impossible to miss */}
            <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm animate-in fade-in duration-150"/>

            {/* Centered call card */}
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
                <div className="pointer-events-auto w-[440px] max-w-[92vw] rounded-md border border-border bg-white shadow-2xl animate-in fade-in zoom-in-95 duration-200">
                    {/* Header with pulsing avatar */}
                    <div className="flex flex-col items-center gap-3 px-6 pt-7 pb-4">
                        <div className="relative">
                            <div className="absolute inset-0 rounded-full bg-primary/30 animate-ping"/>
                            <div className="relative flex h-20 w-20 items-center justify-center rounded-full bg-primary/10 text-primary">
                                <User className="h-10 w-10"/>
                            </div>
                        </div>
                        <div className="text-center">
                            <div className="text-[18px] font-semibold text-foreground">{name}</div>
                            <div className="text-[14px] text-muted-foreground mt-0.5">{subtitle}</div>
                        </div>
                        <div className="flex items-center gap-2 text-[12px] text-primary">
                            <span className="relative flex h-2 w-2">
                                <span className="absolute inset-0 animate-ping rounded-full bg-primary/60"/>
                                <span className="relative h-2 w-2 rounded-full bg-primary"/>
                            </span>
                            Входящий звонок · {elapsed}s
                        </div>
                    </div>

                    {incomingCall.driverId && (
                        <div className="px-6 pb-2 text-center">
                            <Link
                                href={`/drivers/${incomingCall.driverId}`}
                                className="text-[13px] text-primary hover:underline"
                            >
                                Открыть карточку водителя →
                            </Link>
                        </div>
                    )}

                    {/* Big action buttons */}
                    <div className="flex gap-3 px-6 pb-6 pt-2">
                        <button
                            onClick={decline}
                            className="flex flex-1 items-center justify-center gap-2 rounded-md bg-destructive py-3 text-white hover:bg-destructive/90 transition-colors text-[15px] font-medium h-12"
                        >
                            <PhoneOff className="h-5 w-5"/>
                            Отклонить
                        </button>
                        <button
                            onClick={answer}
                            className="flex flex-1 items-center justify-center gap-2 rounded-md bg-accent py-3 text-white hover:bg-accent/90 transition-colors text-[15px] font-medium h-12 shadow-lg"
                            autoFocus
                        >
                            <Phone className="h-5 w-5"/>
                            Принять
                        </button>
                    </div>
                </div>
            </div>
        </>
    )
}

function formatPhone(phone: string): string {
    const digits = phone.replace(/\D/g, '')
    if (digits.length === 11 && digits.startsWith('7')) {
        return `+7 ${digits.slice(1, 4)} ${digits.slice(4, 7)}-${digits.slice(7, 9)}-${digits.slice(9)}`
    }
    return phone
}
