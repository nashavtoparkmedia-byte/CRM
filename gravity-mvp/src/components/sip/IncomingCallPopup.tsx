"use client"

import { Phone, PhoneOff, User } from "lucide-react"
import Link from "next/link"
import { useSip } from "@/lib/sip/SipContext"

/**
 * Floating call card for incoming calls. Pinned bottom-right so it doesn't
 * obscure the chat workspace. Shows caller info (display name from CRM
 * contact lookup, fallback to the raw number), with accept/decline buttons.
 *
 * When the caller is a known driver, the "К карточке" link jumps the
 * manager straight to the driver record while the call is ringing.
 */
export default function IncomingCallPopup() {
    const { incomingCall, answer, decline } = useSip()
    if (!incomingCall) return null

    const name = incomingCall.displayName ?? formatPhone(incomingCall.fromNumber)
    const subtitle = incomingCall.displayName ? formatPhone(incomingCall.fromNumber) : 'Неизвестный номер'

    return (
        <div className="fixed bottom-6 right-6 z-50 w-[360px] rounded-md border border-border bg-white shadow-lg animate-in fade-in slide-in-from-bottom-4 duration-200">
            <div className="flex items-center gap-3 px-4 pt-4">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <User className="h-6 w-6"/>
                </div>
                <div className="min-w-0 flex-1">
                    <div className="text-[15px] font-semibold text-foreground truncate">{name}</div>
                    <div className="text-[12px] text-muted-foreground">{subtitle}</div>
                </div>
                <span className="text-[11px] text-primary animate-pulse">Входящий…</span>
            </div>

            {incomingCall.driverId && (
                <div className="px-4 pt-2">
                    <Link
                        href={`/drivers/${incomingCall.driverId}`}
                        className="text-[12px] text-primary hover:underline"
                    >
                        Открыть карточку водителя →
                    </Link>
                </div>
            )}

            <div className="flex gap-2 px-4 py-4">
                <button
                    onClick={decline}
                    className="flex flex-1 items-center justify-center gap-2 rounded-md bg-destructive py-2 text-white hover:bg-destructive/90 transition-colors text-[14px] font-medium"
                >
                    <PhoneOff className="h-4 w-4"/>
                    Отклонить
                </button>
                <button
                    onClick={answer}
                    className="flex flex-1 items-center justify-center gap-2 rounded-md bg-primary py-2 text-white hover:bg-primary/90 transition-colors text-[14px] font-medium"
                >
                    <Phone className="h-4 w-4"/>
                    Принять
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
