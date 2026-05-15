"use client"

import { Phone, PhoneOutgoing, Loader2 } from "lucide-react"
import { useState } from "react"
import { useSip } from "@/lib/sip/SipContext"
import { toast } from "sonner"

/**
 * Click-to-call button for driver / contact / lead cards.
 *
 * Flow: POST /api/calls/originate → server runs FS `bgapi originate` that
 * places two independent legs:
 *   1) sofia/gateway/megafon/<phone>  ← plain RTP / PCMA, dials the client
 *   2) user/<ext>                     ← DTLS-SRTP, rings the browser softphone
 * FS bridges them once both answer. The B-leg INVITE carries a custom SIP
 * header `P-CRM-Outbound-Bridge=true` so SipContext.handleIncomingSession
 * recognises it as the callback half of THIS click-to-call (not a real
 * incoming call) and auto-answers without showing the Accept/Decline popup.
 *
 * Why not direct useSip().call()? The browser-originated WebRTC INVITE
 * inherits DTLS-SRTP into the B-leg offer, but Megafon's SBC only accepts
 * plain RTP. FreeSWITCH 1.10.12 can't bridge SRTP↔plain when the b-leg
 * inherits codec context from the a-leg — every attempt died with 488
 * INCOMPATIBLE_DESTINATION ~3s after the bridge action. The two-leg
 * originate sidesteps that entirely.
 */
export default function CallButton({ phoneNumber, label = 'Позвонить' }: { phoneNumber: string; label?: string }) {
    const { status, activeCall } = useSip()
    const [busy, setBusy] = useState(false)

    const disabled = status !== 'registered' || !!activeCall || busy
    const title =
        status !== 'registered' ? 'SIP не зарегистрирован — переключитесь на менеджера в шапке' :
        activeCall ? 'Завершите текущий звонок' :
        `Позвонить ${phoneNumber}`

    return (
        <button
            disabled={disabled}
            title={title}
            onClick={async () => {
                setBusy(true)
                try {
                    // Pre-warm microphone permission INSIDE the user-gesture
                    // context. Auto-answer fires from a WebSocket event without
                    // transient activation, so Chrome would block its later
                    // getUserMedia() prompt. Warming here saves the grant in
                    // the page's permission store.
                    //
                    // Non-blocking + timeout: if the user has permanently denied
                    // mic for localhost, OR Chrome silently hangs the prompt
                    // (no dialog appears), we don't want to spin forever.
                    // We log/toast the failure but still fire the originate —
                    // JsSIP's session.answer() will try its own getUserMedia
                    // and at least the signalling round-trip will complete so
                    // the UI doesn't get stuck on the spinner.
                    try {
                        const micPromise = navigator.mediaDevices.getUserMedia({ audio: true, video: false })
                        const timeout = new Promise<MediaStream>((_, rej) =>
                            setTimeout(() => rej(new Error('mic prompt timeout 4s')), 4000),
                        )
                        const stream = await Promise.race([micPromise, timeout])
                        stream.getTracks().forEach(t => t.stop())
                    } catch (micErr: any) {
                        console.warn('[CallButton] mic pre-warm skipped:', micErr?.message ?? micErr)
                        toast.warning(`Микрофон: ${micErr?.message ?? 'не доступен'} — звонок продолжается`)
                    }
                    // Same trick for audio playback: prime the <audio> sink
                    // with a silent user-gesture-driven play() so the later
                    // auto-attached remote stream isn't blocked by Chrome's
                    // autoplay policy.
                    try {
                        const audioEl = document.querySelector('audio') as HTMLAudioElement | null
                        if (audioEl) {
                            audioEl.muted = true
                            await audioEl.play().catch(() => {})
                            audioEl.muted = false
                        }
                    } catch {}

                    const res = await fetch('/api/calls/originate', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ phoneNumber }),
                    })
                    const body = await res.json().catch(() => ({}))
                    if (!res.ok) {
                        toast.error(body?.error ?? `Не удалось инициировать звонок (HTTP ${res.status})`)
                    }
                    // Within ~1s FS will call back to user/101, SipContext
                    // picks it up via newRTCSession + P-CRM-Outbound-Bridge
                    // header and auto-answers, displaying ActiveCallPopup.
                } catch (err: any) {
                    toast.error(`Ошибка сети: ${err?.message ?? err}`)
                }
                setBusy(false)
            }}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-white hover:bg-primary/90 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
        >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin"/> : activeCall ? <PhoneOutgoing className="h-3.5 w-3.5"/> : <Phone className="h-3.5 w-3.5"/>}
            {label}
        </button>
    )
}
