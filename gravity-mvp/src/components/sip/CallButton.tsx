"use client"

import { Phone, PhoneOutgoing, Loader2 } from "lucide-react"
import { useState } from "react"
import { useSip } from "@/lib/sip/SipContext"
import { toast } from "sonner"

/**
 * Click-to-call button for driver / contact / lead cards.
 *
 * Flow: useSip().call(phoneNumber) → JsSIP issues INVITE through the
 * registered WebSocket → FS sofia dial-plan bridges to the Megafon trunk.
 * The browser is the originator, so the call shows up in ActiveCallPopup
 * with statuses "Дозваниваюсь…" → "Идёт вызов…" → "Разговор · MM:SS" —
 * no Accept/Decline confusion, no popup that pretends it's an incoming call.
 *
 * Why not /api/calls/originate? Server-side originate then re-INVITEs the
 * manager's extension, which JsSIP correctly sees as a NEW INCOMING call —
 * triggering IncomingCallPopup with Accept/Decline buttons. From the user's
 * perspective that's wrong: "I clicked Call — why am I being asked to
 * accept it?". Direct JsSIP keeps the originator role on the browser side.
 *
 * Chrome only shows the microphone prompt on this onClick (real user
 * gesture), not on a delayed answer step, which avoids the silent
 * NotAllowedError we hit before.
 */
export default function CallButton({ phoneNumber, label = 'Позвонить' }: { phoneNumber: string; label?: string }) {
    const { status, activeCall, call } = useSip()
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
                    await call(phoneNumber)
                } catch (err: any) {
                    toast.error(`Не удалось набрать: ${err?.message ?? err}`)
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
