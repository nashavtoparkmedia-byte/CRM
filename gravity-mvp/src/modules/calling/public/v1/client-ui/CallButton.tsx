"use client"

import { Phone, PhoneOutgoing, Loader2 } from "lucide-react"
import { useEffect, useState } from "react"
import { useSip } from '@/modules/calling/public/v1/sip-client-context'
import { toast } from "sonner"
import { isRenderedInMobileShellV1 } from './mobile-shell-client'

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
 *
 * In the Android shell this whole flow is unavailable and always was: the server
 * refuses to hand the shell a SIP password, so the softphone never reaches
 * `registered` and the button below is permanently disabled. There the operator
 * gets a plain tel: link instead, which the shell hands to the system dialer, and
 * the call runs on their own mobile subscription. No SIP credential, no
 * microphone permission, no automatic placement - the dialer opens with the
 * number filled in and the operator presses call themselves.
 *
 * Detected after mount rather than during render, because the server has no
 * User-Agent while producing this markup and a mismatch would hydrate wrong.
 */
export default function CallButton({ phoneNumber, label = 'Позвонить' }: { phoneNumber: string; label?: string }) {
    const { status, activeCall, startPlaceholderOutbound, cancelPlaceholderOutbound, setActiveCallFsUuid } = useSip()
    const [busy, setBusy] = useState(false)
    const [inMobileShell, setInMobileShell] = useState(false)

    useEffect(() => { setInMobileShell(isRenderedInMobileShellV1()) }, [])

    if (inMobileShell) {
        return (
            <a
                href={`tel:${phoneNumber}`}
                title={`Позвонить ${phoneNumber}`}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-white hover:bg-primary/90 transition-colors"
            >
                <Phone className="h-3.5 w-3.5"/>
                {label}
            </a>
        )
    }

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
                // Open the popup + start the ringback tone NOW, before we even
                // call /api/calls/originate. Otherwise the user sees a frozen
                // button with no feedback for 1–2s until FS's b-leg INVITE
                // arrives, with no audible "дозвон" between click and answer.
                // SipContext upgrades this placeholder into a real session
                // when handleIncomingSession sees the P-CRM-Outbound-Bridge
                // INVITE — startedAt is preserved, popup doesn't re-mount.
                startPlaceholderOutbound(phoneNumber)
                try {
                    // Pre-warm microphone permission INSIDE the user-gesture
                    // context. Fire-and-forget — do NOT await. If Chrome shows
                    // a prompt the user may grant or deny; if Chrome silently
                    // never shows the dialog (rare bug or extension policy),
                    // we don't want to block the actual outbound originate.
                    // JsSIP's session.answer() will fire its own getUserMedia
                    // when the bridge callback arrives; by then the permission
                    // grant from this prompt (if any) is already in the store.
                    navigator.mediaDevices.getUserMedia({ audio: true, video: false })
                        .then(stream => {
                            stream.getTracks().forEach(t => t.stop())
                            console.info('[CallButton] mic pre-warm: granted')
                        })
                        .catch(err => console.warn('[CallButton] mic pre-warm failed:', err?.message ?? err))
                    // Audio playback prime — also fire-and-forget. Calling
                    // play() on an audio element without srcObject can hang
                    // forever inside `await`, even though it would normally
                    // reject. The remote stream is attached later in
                    // SipContext.attachRemoteAudio() which has its own
                    // explicit play() — this prime is best-effort only.
                    try {
                        const audioEl = document.querySelector('audio') as HTMLAudioElement | null
                        if (audioEl) {
                            audioEl.muted = true
                            audioEl.play().catch(() => {}).finally(() => { audioEl.muted = false })
                        }
                    } catch {}

                    const res = await fetch('/api/calls/originate', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ phoneNumber }),
                    })
                    const body = await res.json().catch(() => ({}))
                    if (!res.ok) {
                        cancelPlaceholderOutbound()
                        toast.error(body?.error ?? `Не удалось инициировать звонок (HTTP ${res.status})`)
                    } else if (body?.fsUuid) {
                        // Stamp the FS channel UUID onto the placeholder so a
                        // subsequent "Отбой" before the b-leg arrives can
                        // POST /api/calls/cancel and uuid_kill the a-leg.
                        // Without this the callee's phone keeps ringing.
                        setActiveCallFsUuid(body.fsUuid)
                    }
                    // Within ~1s FS will call back to user/101, SipContext
                    // picks it up via newRTCSession + P-CRM-Outbound-Bridge
                    // header and auto-answers, displaying ActiveCallPopup.
                } catch (err: any) {
                    cancelPlaceholderOutbound()
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
