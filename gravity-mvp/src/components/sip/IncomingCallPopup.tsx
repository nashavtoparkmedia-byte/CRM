"use client"

import { Phone, PhoneOff, User } from "lucide-react"
import Link from "next/link"
import { useEffect, useRef, useState } from "react"
import { useSip } from "@/lib/sip/SipContext"

/**
 * Compact incoming-call card (bottom-right). Visual style intentionally close
 * to the original Telegram-like toast — full-screen modal was over-bearing.
 *
 * Cross-cutting attention boosters kept from the modal version:
 *  - WebAudio ringtone (440Hz + 480Hz, 2s on / 2s off)
 *  - Tab title flashes "📞 Входящий…" so it's visible from another tab
 *  - Native Notification API (asks permission once, requireInteraction so it
 *    stays visible until the user clicks)
 *  - Visible ring-duration counter, autoFocus on "Принять" (Enter accepts)
 */
export default function IncomingCallPopup() {
    const { incomingCall, answer, decline, activeCall } = useSip()
    const [elapsed, setElapsed] = useState(0)
    const [isAnswering, setIsAnswering] = useState(false)
    const ringtoneRef = useRef<{ stop: () => void } | null>(null)
    const originalTitleRef = useRef<string>('')

    // Reset answering state when popup clears (call ended/declined)
    useEffect(() => {
        if (!incomingCall) setIsAnswering(false)
    }, [incomingCall])

    useEffect(() => {
        if (!incomingCall) {
            ringtoneRef.current?.stop()
            ringtoneRef.current = null
            if (originalTitleRef.current) {
                document.title = originalTitleRef.current
                originalTitleRef.current = ''
            }
            setElapsed(0)
            return
        }

        // WebAudio ringtone — 440/480Hz sine, NA cadence
        try {
            const Ctx: typeof AudioContext = (window.AudioContext ?? (window as any).webkitAudioContext)
            const ctx = new Ctx()
            const gain = ctx.createGain()
            gain.gain.value = 0.08
            gain.connect(ctx.destination)
            const o1 = ctx.createOscillator()
            const o2 = ctx.createOscillator()
            o1.type = 'sine'; o1.frequency.value = 440
            o2.type = 'sine'; o2.frequency.value = 480
            o1.connect(gain); o2.connect(gain)
            o1.start(); o2.start()
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

        // Tab title flash
        if (!originalTitleRef.current) originalTitleRef.current = document.title
        const titles = ['📞 Входящий…', `📞 ${incomingCall.displayName ?? incomingCall.fromNumber}`]
        let i = 0
        const titleFlip = setInterval(() => {
            document.title = titles[i++ % titles.length]
        }, 700)

        // Native browser notification
        let notification: Notification | null = null
        ;(async () => {
            try {
                if ('Notification' in window) {
                    let perm = Notification.permission
                    if (perm === 'default') perm = await Notification.requestPermission()
                    if (perm === 'granted') {
                        notification = new Notification('Входящий звонок', {
                            body: `${incomingCall.displayName ?? incomingCall.fromNumber}`,
                            tag: 'crm-call',
                            requireInteraction: true,
                            silent: true,
                        })
                        notification.onclick = () => { window.focus(); notification?.close() }
                    }
                }
            } catch { /* ignore */ }
        })()

        // Elapsed counter
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

            {incomingCall.driverId && (
                <div className="px-4 pt-1">
                    <Link
                        href={`/drivers/${incomingCall.driverId}`}
                        className="text-[12px] text-primary hover:underline"
                    >
                        Открыть карточку водителя →
                    </Link>
                </div>
            )}

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
