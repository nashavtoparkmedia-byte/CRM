"use client"

import { Phone, PhoneOutgoing, Loader2 } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useSip } from '@/modules/calling/public/v1/sip-client-context'
import { toast } from "sonner"
import {
    MANUAL_CALL_AVAILABILITY_QUERY_V1,
    type ManualCallAvailabilityResultV1,
    type ManualCallPhoneV1,
} from '@/contracts/calling/v1/manual-call'
import { manualCallAvailabilityActionV1 } from '../manual-call-actions'

/**
 * Click-to-call button for one Contact.
 *
 * The button names a canonical Contact (and optionally one of its Contacts phone ids); it never
 * carries a phone number. Before offering a call it asks Calling whether the signed-in employee
 * may call this Contact now: a signed Staff Session with a calling role, the Contact's own
 * verified unique phone, and Contacts' voice permission. When the answer is no, no call and no
 * tel: link is offered. The server checks everything again when the call is started.
 *
 * Flow: POST /api/calls/originate { requestId, contactId, phoneId } → FreeSWITCH dials the
 * Contact through the trunk and bridges the manager's own extension in when the callee answers.
 * The bridge INVITE carries `P-CRM-Outbound-Bridge=true`, so SipContext auto-answers it.
 * One requestId belongs to one press: a double click replays it, never a second call.
 *
 * Where the calling client reports `system_dialer`, the device's own dialer gets a tel: link
 * with the verified number, and only when the call is allowed.
 *
 * `phoneNumber` is deprecated: a caller that still passes a raw number gets a disabled button,
 * because a number that did not come from Contacts is never dialled.
 */
export const CALL_BUTTON_REFUSAL_TEXT: Record<string, string> = {
    deprecated_phone_number: 'Звонок отсюда недоступен — позвоните из карточки человека',
    staff_not_authenticated: 'Войдите по паролю, чтобы звонить',
    staff_not_authorized: 'Нет права звонить',
    no_extension: 'Сотруднику не назначен SIP-номер',
    contact_unknown: 'Контакт не найден',
    contact_redirected: 'Контакт объединён — откройте актуальную карточку',
    contact_archived: 'Контакт в архиве',
    contact_unavailable: 'Карточка контакта недоступна, повторите позже',
    no_verified_number: 'Нет проверенного номера этого контакта',
    voice_denied: 'Звонки этому человеку запрещены',
    all_denied: 'Связь с этим человеком запрещена',
    permission_unavailable: 'Не удалось проверить разрешение на звонок',
    busy: 'Звонок этому контакту уже идёт',
    request_conflict: 'Запрос звонка устарел, нажмите ещё раз',
    provider_unavailable: 'Телефония недоступна',
}

const refusalText = (reason: string) => CALL_BUTTON_REFUSAL_TEXT[reason] ?? 'Звонок недоступен'
const newRequestId = () => crypto.randomUUID()

type Availability =
    | { kind: 'loading' }
    | { kind: 'available'; phone: ManualCallPhoneV1 }
    | { kind: 'unavailable'; reason: string }

export default function CallButton({ contactId, phoneId, phoneNumber, label = 'Позвонить' }: {
    contactId?: string
    phoneId?: string
    /** @deprecated A raw number is never dialled; pass contactId (and phoneId) instead. */
    phoneNumber?: string
    label?: string
}) {
    const { status, activeCall, outboundMode, startPlaceholderOutbound, cancelPlaceholderOutbound, setActiveCallFsUuid } = useSip()
    const [busy, setBusy] = useState(false)
    const [availability, setAvailability] = useState<Availability>(
        contactId ? { kind: 'loading' } : { kind: 'unavailable', reason: 'deprecated_phone_number' },
    )
    const requestId = useRef<string>(newRequestId())
    void phoneNumber

    useEffect(() => {
        if (!contactId) {
            setAvailability({ kind: 'unavailable', reason: 'deprecated_phone_number' })
            return
        }
        let cancelled = false
        setAvailability({ kind: 'loading' })
        manualCallAvailabilityActionV1({ contract: MANUAL_CALL_AVAILABILITY_QUERY_V1, contactId })
            .then((result: ManualCallAvailabilityResultV1) => {
                if (cancelled) return
                if (result.status !== 'available') {
                    setAvailability({ kind: 'unavailable', reason: result.reason })
                    return
                }
                const phone = phoneId
                    ? result.phones.find(candidate => candidate.phoneId === phoneId)
                    : result.phones.find(candidate => candidate.preferred) ?? result.phones[0]
                setAvailability(phone ? { kind: 'available', phone } : { kind: 'unavailable', reason: 'no_verified_number' })
            })
            .catch(() => { if (!cancelled) setAvailability({ kind: 'unavailable', reason: 'permission_unavailable' }) })
        return () => { cancelled = true }
    }, [contactId, phoneId])

    const baseClass = "inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-white hover:bg-primary/90 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"

    if (availability.kind !== 'available') {
        return (
            <button
                type="button"
                disabled
                title={availability.kind === 'loading' ? 'Проверяем, можно ли звонить…' : refusalText(availability.reason)}
                data-call-unavailable={availability.kind === 'loading' ? 'loading' : availability.reason}
                className={baseClass}
            >
                {availability.kind === 'loading' ? <Loader2 className="h-3.5 w-3.5 animate-spin"/> : <Phone className="h-3.5 w-3.5"/>}
                {label}
            </button>
        )
    }

    const { phone } = availability

    if (outboundMode === 'system_dialer') {
        return (
            <a
                href={`tel:${phone.phone}`}
                title={`Позвонить ${phone.phone}`}
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
        `Позвонить ${phone.phone}`

    return (
        <button
            type="button"
            disabled={disabled}
            title={title}
            onClick={async () => {
                setBusy(true)
                // Open the popup and the ringback tone right away; SipContext upgrades this
                // placeholder into the real session when the bridge INVITE arrives.
                startPlaceholderOutbound(phone.phone)
                try {
                    // Pre-warm microphone permission inside the user gesture; never awaited.
                    navigator.mediaDevices.getUserMedia({ audio: true, video: false })
                        .then(stream => { stream.getTracks().forEach(t => t.stop()) })
                        .catch(err => console.warn('[CallButton] mic pre-warm failed:', err?.message ?? err))
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
                        body: JSON.stringify({ requestId: requestId.current, contactId, phoneId: phone.phoneId }),
                    })
                    const body = await res.json().catch(() => ({}))
                    if (res.status === 202) {
                        cancelPlaceholderOutbound()
                        toast.error('Исход звонка неизвестен. Повторный набор не выполняется.')
                    } else if (!res.ok) {
                        cancelPlaceholderOutbound()
                        toast.error(refusalText(String(body?.error ?? '')))
                    } else if (body?.fsUuid) {
                        // Lets "Отбой" before the bridge leg arrives cancel the trunk leg.
                        setActiveCallFsUuid(body.fsUuid)
                    }
                } catch {
                    cancelPlaceholderOutbound()
                    toast.error('Ошибка сети. Звонок не начат.')
                }
                // The next press is a new intent.
                requestId.current = newRequestId()
                setBusy(false)
            }}
            className={baseClass}
        >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin"/> : activeCall ? <PhoneOutgoing className="h-3.5 w-3.5"/> : <Phone className="h-3.5 w-3.5"/>}
            {label}
        </button>
    )
}
