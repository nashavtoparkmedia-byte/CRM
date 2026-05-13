"use client"

import { Phone, PhoneOutgoing } from "lucide-react"
import { useState } from "react"
import { useSip } from "@/lib/sip/SipContext"

/**
 * Click-to-call button for driver / contact / lead cards.
 *
 * Initiates a call through the browser softphone (JsSIP) when the user
 * is registered. If they're using Linphone instead, the dialplan will
 * fork incoming calls to all extensions — but click-to-call from this
 * button always uses the browser session (the only one we control here).
 */
export default function CallButton({ phoneNumber, label = 'Позвонить' }: { phoneNumber: string; label?: string }) {
    const { status, call, activeCall } = useSip()
    const [busy, setBusy] = useState(false)

    const disabled = status !== 'registered' || !!activeCall || busy
    const title =
        status !== 'registered' ? 'SIP не зарегистрирован' :
        activeCall ? 'Завершите текущий звонок' :
        `Позвонить ${phoneNumber}`

    return (
        <button
            disabled={disabled}
            title={title}
            onClick={async () => {
                setBusy(true)
                try { await call(phoneNumber) } catch (err) { console.warn('call failed', err) }
                setBusy(false)
            }}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-white hover:bg-primary/90 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
        >
            {activeCall ? <PhoneOutgoing className="h-3.5 w-3.5"/> : <Phone className="h-3.5 w-3.5"/>}
            {label}
        </button>
    )
}
