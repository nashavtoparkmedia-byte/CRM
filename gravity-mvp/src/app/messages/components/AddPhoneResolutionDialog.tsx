"use client"

import { useEffect, useRef, useState } from "react"
import { AlertTriangle, Check, ExternalLink, GitMerge, Loader2, Phone, Search, X } from "lucide-react"

import { normalizeRussianPhoneE164 } from "@/lib/phoneUtils"

type OwnerContact = {
    id: string
    displayName: string
    phone: string
    channels: string[]
    mainDriverProfile: { id: string; fullName: string; parkName: string } | null
    driverProfileCount: number
    lastContactAt: string | null
    chatId: string | null
    isArchived: boolean
}

type PreflightResult = {
    normalizedPhone: string
    ownershipStatus: 'FREE' | 'SAME_CONTACT' | 'OTHER_CONTACT' | 'AMBIGUOUS'
    resolutionStatus: string
    ownerContacts: OwnerContact[]
    driverProfileSuggestions: { id: string }[]
    searchedParks: string[]
    canAdd: boolean
    canReviewMerge: boolean
    confirmationToken: string
}

type ViewState = 'input' | 'checking' | 'free' | 'same' | 'other' | 'ambiguous' | 'saving' | 'success' | 'error'

interface AddPhoneResolutionDialogProps {
    contactId: string
    onClose: () => void
    onResolved: () => Promise<unknown> | void
    onOpenContact: (owner: OwnerContact) => void
    onReviewMerge: (owner: OwnerContact) => void
}

const CHANNEL_LABELS: Record<string, string> = {
    max: 'MAX',
    telegram: 'Telegram',
    whatsapp: 'WhatsApp',
}

function formatPhone(phone: string): string {
    return phone.length === 12 && phone.startsWith('+7')
        ? `+7 ${phone.slice(2, 5)} ${phone.slice(5, 8)}-${phone.slice(8, 10)}-${phone.slice(10)}`
        : phone
}

function formatLastContact(value: string | null): string {
    if (!value) return 'Нет переписки'
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? 'Нет переписки' : date.toLocaleString('ru-RU')
}

function OwnerCard({ owner, showOpen = true, onOpen }: {
    owner: OwnerContact
    showOpen?: boolean
    onOpen: () => void
}) {
    return (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3" data-testid={`phone-owner-${owner.id}`}>
            <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                    <div className="truncate text-[13px] font-semibold text-[#111]">{owner.displayName || 'Без имени'}</div>
                    <div className="mt-0.5 font-mono text-[11px] text-gray-500">{formatPhone(owner.phone)}</div>
                </div>
                {showOpen && (
                    <button
                        type="button"
                        onClick={onOpen}
                        disabled={!owner.chatId}
                        className="shrink-0 text-[#3390EC] disabled:text-gray-300"
                        title={owner.chatId ? 'Открыть карточку контакта' : 'У контакта нет доступного чата'}
                        aria-label="Открыть карточку контакта"
                    >
                        <ExternalLink size={15} />
                    </button>
                )}
            </div>
            <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] text-gray-500">
                <span>Каналы</span><span className="text-right text-gray-700">{owner.channels.map(channel => CHANNEL_LABELS[channel] || channel).join(', ') || 'нет'}</span>
                <span>Профилей</span><span className="text-right text-gray-700">{owner.driverProfileCount}</span>
                <span>Главный</span><span className="truncate text-right text-gray-700">{owner.mainDriverProfile ? `${owner.mainDriverProfile.fullName}, ${owner.mainDriverProfile.parkName}` : 'не выбран'}</span>
                <span>Последний контакт</span><span className="text-right text-gray-700">{formatLastContact(owner.lastContactAt)}</span>
            </div>
        </div>
    )
}

export default function AddPhoneResolutionDialog({
    contactId,
    onClose,
    onResolved,
    onOpenContact,
    onReviewMerge,
}: AddPhoneResolutionDialogProps) {
    const [phoneInput, setPhoneInput] = useState('')
    const [view, setView] = useState<ViewState>('input')
    const [preflight, setPreflight] = useState<PreflightResult | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [successAction, setSuccessAction] = useState<'added' | 'same_contact'>('added')
    const requestInFlight = useRef(false)
    const normalizedPreview = normalizeRussianPhoneE164(phoneInput)
    const busy = view === 'checking' || view === 'saving'

    useEffect(() => {
        const onEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && !requestInFlight.current) onClose()
        }
        document.addEventListener('keydown', onEscape)
        return () => document.removeEventListener('keydown', onEscape)
    }, [onClose])

    const applyPreflight = async (result: PreflightResult) => {
        setPreflight(result)
        if (result.ownershipStatus === 'FREE') setView('free')
        if (result.ownershipStatus === 'OTHER_CONTACT') setView('other')
        if (result.ownershipStatus === 'AMBIGUOUS') setView('ambiguous')
        if (result.ownershipStatus === 'SAME_CONTACT') {
            setSuccessAction('same_contact')
            setView('same')
            await onResolved()
        }
    }

    const checkPhone = async () => {
        if (requestInFlight.current) return
        if (!normalizedPreview) {
            setError('Введите российский номер из 10 цифр')
            setView('error')
            return
        }
        requestInFlight.current = true
        setView('checking')
        setError(null)
        try {
            const response = await fetch(`/api/contacts/${contactId}/phones/resolve`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode: 'preflight', phone: phoneInput }),
            })
            const body = await response.json().catch(() => ({}))
            if (!response.ok) throw new Error(body.message || body.error || `Ошибка ${response.status}`)
            await applyPreflight(body as PreflightResult)
        } catch (caught: unknown) {
            setError(caught instanceof Error ? caught.message : 'Не удалось проверить номер')
            setView('error')
        } finally {
            requestInFlight.current = false
        }
    }

    const confirmPhone = async () => {
        if (!preflight || requestInFlight.current) return
        requestInFlight.current = true
        setView('saving')
        setError(null)
        try {
            const response = await fetch(`/api/contacts/${contactId}/phones/resolve`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode: 'confirm', confirmationToken: preflight.confirmationToken }),
            })
            const body = await response.json().catch(() => ({}))
            if (!response.ok) {
                if (body.preflight) {
                    await applyPreflight(body.preflight as PreflightResult)
                    return
                }
                throw new Error(body.message || body.error || `Ошибка ${response.status}`)
            }
            setSuccessAction(body.action === 'same_contact' ? 'same_contact' : 'added')
            setPreflight(current => current ? { ...current, driverProfileSuggestions: body.driverProfileSuggestions || [] } : current)
            await onResolved()
            setView('success')
        } catch (caught: unknown) {
            setError(caught instanceof Error ? caught.message : 'Не удалось добавить номер')
            setView('error')
        } finally {
            requestInFlight.current = false
        }
    }

    const reviewMerge = (owner: OwnerContact) => {
        if (!preflight) return
        fetch(`/api/contacts/${contactId}/phones/resolve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                mode: 'audit',
                action: 'merge_review_opened',
                confirmationToken: preflight.confirmationToken,
            }),
        }).catch(() => {})
        onReviewMerge(owner)
    }

    const resetInput = () => {
        if (busy) return
        setView('input')
        setPreflight(null)
        setError(null)
    }

    const suggestionCount = preflight?.driverProfileSuggestions.length || 0

    return (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/30 p-4" onMouseDown={() => !busy && onClose()}>
            <div
                className="w-full max-w-[440px] rounded-xl border border-gray-200 bg-white shadow-2xl"
                role="dialog"
                aria-modal="true"
                aria-labelledby="add-phone-title"
                data-testid="add-phone-resolution-dialog"
                onMouseDown={event => event.stopPropagation()}
            >
                <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
                    <div className="flex items-center gap-2">
                        <Phone size={15} className="text-[#3390EC]" />
                        <h3 id="add-phone-title" className="text-[14px] font-bold text-[#111]">Добавить номер</h3>
                    </div>
                    <button type="button" onClick={onClose} disabled={busy} className="text-gray-400 hover:text-gray-700 disabled:opacity-30" aria-label="Закрыть">
                        <X size={16} />
                    </button>
                </div>

                <div className="space-y-3 px-4 py-4">
                    {(view === 'input' || view === 'error') && (
                        <>
                            <label className="block">
                                <span className="mb-1 block text-[11px] font-medium text-gray-600">Номер телефона</span>
                                <input
                                    autoFocus
                                    type="tel"
                                    inputMode="tel"
                                    value={phoneInput}
                                    onChange={event => { setPhoneInput(event.target.value); setError(null); if (view === 'error') setView('input') }}
                                    onKeyDown={event => { if (event.key === 'Enter') checkPhone() }}
                                    placeholder="+7 922 215-57-50"
                                    className="h-[36px] w-full rounded-lg border border-gray-200 px-3 font-mono text-[13px] outline-none focus:border-[#3390EC]"
                                />
                            </label>
                            <div className="min-h-[18px] text-[11px]">
                                {normalizedPreview
                                    ? <span className="text-emerald-700">Будет сохранён: {formatPhone(normalizedPreview)}</span>
                                    : phoneInput && <span className="text-gray-500">Введите 10 цифр российского номера</span>}
                            </div>
                            {error && <div className="rounded-md bg-red-50 px-3 py-2 text-[11px] text-red-700" role="alert">{error}</div>}
                            <div className="flex justify-end gap-2">
                                <button type="button" onClick={onClose} className="h-[32px] rounded-lg bg-gray-100 px-3 text-[11px] font-semibold text-gray-700">Отмена</button>
                                <button type="button" onClick={checkPhone} disabled={!phoneInput.trim()} className="flex h-[32px] items-center gap-1 rounded-lg bg-[#3390EC] px-3 text-[11px] font-semibold text-white disabled:opacity-40">
                                    <Search size={12} /> Проверить и добавить
                                </button>
                            </div>
                        </>
                    )}

                    {(view === 'checking' || view === 'saving') && (
                        <div className="flex min-h-[120px] flex-col items-center justify-center gap-2 text-[12px] text-gray-600">
                            <Loader2 size={22} className="animate-spin text-[#3390EC]" />
                            {view === 'checking' ? 'Проверяем владельца номера...' : 'Добавляем номер и ищем профили...'}
                        </div>
                    )}

                    {view === 'free' && preflight && (
                        <>
                            <div className="rounded-lg bg-emerald-50 px-3 py-2 text-[12px] text-emerald-800">Номер свободен и может быть добавлен.</div>
                            <p className="text-[13px] text-gray-700">Добавить номер <strong>{formatPhone(preflight.normalizedPhone)}</strong> к этому контакту?</p>
                            <p className="text-[11px] text-gray-500">Проверено 6 парков. Найдено возможных профилей: {suggestionCount}. Профили не будут привязаны автоматически.</p>
                            <div className="flex justify-end gap-2">
                                <button type="button" onClick={resetInput} className="h-[32px] rounded-lg bg-gray-100 px-3 text-[11px] font-semibold text-gray-700">Назад</button>
                                <button type="button" onClick={confirmPhone} className="h-[32px] rounded-lg bg-[#3390EC] px-3 text-[11px] font-semibold text-white">Добавить номер</button>
                            </div>
                        </>
                    )}

                    {(view === 'same' || view === 'success') && preflight && (
                        <div className="py-2 text-center" data-testid="phone-resolution-success">
                            <Check size={30} className="mx-auto text-emerald-500" />
                            <div className="mt-2 text-[14px] font-semibold text-[#111]">
                                {successAction === 'same_contact' ? 'Этот номер уже добавлен к контакту' : 'Номер добавлен'}
                            </div>
                            <div className="mt-1 text-[11px] text-gray-500">
                                {suggestionCount > 0
                                    ? `Возможные профили водителя: ${suggestionCount}`
                                    : 'Профили водителя не найдены'}
                            </div>
                            <button type="button" onClick={onClose} className="mt-4 h-[32px] rounded-lg bg-[#3390EC] px-4 text-[11px] font-semibold text-white">
                                {suggestionCount > 0 ? 'Проверить профили' : 'Закрыть'}
                            </button>
                        </div>
                    )}

                    {view === 'other' && preflight && preflight.ownerContacts[0] && (
                        <>
                            <div className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-amber-800">
                                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                                <div>
                                    <div className="text-[12px] font-semibold">Номер уже используется</div>
                                    <div className="mt-0.5 text-[11px]">Номер {formatPhone(preflight.normalizedPhone)} уже указан у другого контакта. Ничего не добавлено.</div>
                                </div>
                            </div>
                            <OwnerCard owner={preflight.ownerContacts[0]} onOpen={() => onOpenContact(preflight.ownerContacts[0])} />
                            <div className="flex flex-wrap justify-end gap-2">
                                <button type="button" onClick={onClose} className="h-[32px] rounded-lg bg-gray-100 px-3 text-[11px] font-semibold text-gray-700">Отмена</button>
                                <button type="button" onClick={() => onOpenContact(preflight.ownerContacts[0])} disabled={!preflight.ownerContacts[0].chatId} className="h-[32px] rounded-lg border border-[#3390EC] px-3 text-[11px] font-semibold text-[#3390EC] disabled:border-gray-200 disabled:text-gray-300">Открыть существующий контакт</button>
                                <button type="button" onClick={() => reviewMerge(preflight.ownerContacts[0])} className="flex h-[32px] items-center gap-1 rounded-lg bg-[#3390EC] px-3 text-[11px] font-semibold text-white">
                                    <GitMerge size={12} /> Проверить объединение
                                </button>
                            </div>
                        </>
                    )}

                    {view === 'ambiguous' && preflight && (
                        <>
                            <div className="flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-red-800">
                                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                                <div>
                                    <div className="text-[12px] font-semibold">Номер найден у нескольких контактов</div>
                                    <div className="mt-0.5 text-[11px]">Ничего не добавлено. Нужна ручная проверка.</div>
                                </div>
                            </div>
                            <div className="max-h-[260px] space-y-2 overflow-y-auto">
                                {preflight.ownerContacts.map(owner => <OwnerCard key={owner.id} owner={owner} onOpen={() => onOpenContact(owner)} />)}
                            </div>
                            <div className="text-[10px] font-mono text-gray-400">PHONE_OWNERSHIP_AMBIGUOUS</div>
                            <div className="flex justify-end"><button type="button" onClick={onClose} className="h-[32px] rounded-lg bg-gray-100 px-3 text-[11px] font-semibold text-gray-700">Закрыть</button></div>
                        </>
                    )}
                </div>
            </div>
        </div>
    )
}
