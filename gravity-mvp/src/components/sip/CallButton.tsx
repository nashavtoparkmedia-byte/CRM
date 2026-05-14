"use client"

import { Phone, PhoneOutgoing, Loader2 } from "lucide-react"
import { useState } from "react"
import { useSip } from "@/lib/sip/SipContext"
import { toast } from "sonner"

/**
 * Click-to-call button for driver / contact / lead cards.
 *
 * Flow: POST /api/calls/originate → server triggers an FS originate that
 * first dials the client through the Megafon trunk, then bridges to the
 * manager's extension. The manager's browser sees the bridge as an
 * INCOMING call (popup), with microphone permission requested only at
 * answer time — not when this button is clicked.
 *
 * This avoids the silent NotAllowedError that hits the old direct-JsSIP
 * flow when Chrome has microphone access denied at the site level.
 *
 * SIP registration is still required (manager has to be reachable for the
 * bridge leg) — button is disabled when status !== 'registered'.
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
                    const res = await fetch('/api/calls/originate', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ phoneNumber }),
                    })
                    const body = await res.json().catch(() => ({}))
                    if (!res.ok) {
                        toast.error(body?.error ?? `Не удалось инициировать звонок (HTTP ${res.status})`)
                    } else {
                        toast(`Дозваниваюсь до ${phoneNumber}…`, { description: 'Ответьте на входящий звонок в браузере, когда клиент возьмёт трубку.' })
                    }
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
