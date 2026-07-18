'use client'

import { useState } from 'react'
import { AlertCircle, CheckCircle2, KeyRound, RefreshCw } from 'lucide-react'
import {
    previewProviderState,
    type PreviewProviderState,
    type PreviewProviderStatus,
} from '@/lib/ai-call/provider-preview'

const STATUSES: Array<{ value: PreviewProviderStatus; label: string }> = [
    { value: 'configured', label: 'Настроен' },
    { value: 'missing', label: 'Ключ отсутствует' },
    { value: 'invalid', label: 'Неверный ключ' },
    { value: 'temporary_error', label: 'Временная ошибка' },
]

export function ProviderSettingsPreview() {
    const [states, setStates] = useState<Record<PreviewProviderState['id'], PreviewProviderStatus>>({
        openai: 'configured',
        speechkit: 'configured',
    })

    return (
        <section className="rounded-xl border border-[#E4ECFC] bg-white p-5">
            <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#E8F5FD] text-[#2AABEE]">
                    <KeyRound className="h-5 w-5" />
                </div>
                <div>
                    <h2 className="text-[17px] font-semibold">Настройки провайдеров</h2>
                    <p className="mt-1 text-sm text-[#64748B]">Локальный UI-preview. Production credentials не читаются и не изменяются.</p>
                </div>
            </div>

            <div className="mt-5 space-y-3">
                {(['openai', 'speechkit'] as const).map((id) => {
                    const state = previewProviderState(id, states[id])
                    const ok = state.status === 'configured'
                    return (
                        <article key={id} className="rounded-xl border border-[#E4ECFC] p-4">
                            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                                <div className="flex items-start gap-3">
                                    {ok
                                        ? <CheckCircle2 className="mt-0.5 h-5 w-5 text-[#059669]" />
                                        : <AlertCircle className="mt-0.5 h-5 w-5 text-[#DC2626]" />}
                                    <div>
                                        <div className="font-semibold">{state.name}</div>
                                        <div className="mt-0.5 text-sm text-[#64748B]">{state.message}</div>
                                        {state.maskedValue && (
                                            <code className="mt-2 inline-block rounded-md bg-[#F1F5FD] px-2 py-1 text-xs">{state.maskedValue}</code>
                                        )}
                                    </div>
                                </div>
                                <div className="flex flex-wrap gap-2">
                                    <select
                                        value={states[id]}
                                        onChange={(event) => setStates((current) => ({
                                            ...current,
                                            [id]: event.target.value as PreviewProviderStatus,
                                        }))}
                                        aria-label={`Состояние ${state.name}`}
                                        className="h-11 rounded-lg border border-[#E4ECFC] bg-white px-3 text-sm outline-none focus:border-[#2AABEE]"
                                    >
                                        {STATUSES.map((status) => (
                                            <option key={status.value} value={status.value}>{status.label}</option>
                                        ))}
                                    </select>
                                    <button
                                        type="button"
                                        onClick={() => setStates((current) => ({ ...current, [id]: 'configured' }))}
                                        className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-[#E4ECFC] px-3 text-sm font-semibold hover:bg-[#F1F5FD]"
                                    >
                                        <RefreshCw className="h-4 w-4" />
                                        Проверить mock
                                    </button>
                                </div>
                            </div>
                        </article>
                    )
                })}
            </div>

            <div className="mt-4 rounded-lg bg-[#F1F5FD] px-3 py-2 text-xs text-[#64748B]">
                Полные ключи, raw provider response, process argv и stack trace в интерфейс не выводятся.
            </div>
        </section>
    )
}
