/* eslint-disable @typescript-eslint/no-explicit-any -- thrown errors are
   unknown by design; pragmatic cast for the UI. */
"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Sparkles, Loader2, HelpCircle } from "lucide-react"

/**
 * Mock-mode "AI call" trigger. Posts to /api/ai-calls/mock which creates
 * a Call(isAi=true) row with synthetic transcript/summary/qualification,
 * optionally spawns a manager Task, and routes the operator to the
 * call detail page so the result can be inspected.
 *
 * Only used in MVP testing — when the real Yandex pipeline ships, this
 * button is replaced by AiCallButton that kicks off a live voice agent.
 *
 * Variant param controls which mock payload is used:
 *   'qualified' | 'not_qualified' | 'unclear' | 'random' (default)
 */
export default function AiMockCallButton({
    driverId,
    contactId,
    phoneNumber,
    scenarioId,
    label = 'AI-звонок (mock)',
}: {
    driverId?: string
    contactId?: string
    phoneNumber?: string
    scenarioId?: string
    label?: string
}) {
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const router = useRouter()

    async function trigger() {
        setLoading(true)
        setError(null)
        try {
            const res = await fetch('/api/ai-calls/mock', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    driverId,
                    contactId,
                    phoneNumber,
                    scenarioId,
                    variant: 'random',
                }),
            })
            const data = await res.json()
            if (!res.ok) {
                if (data.error === 'mock_mode_disabled') {
                    throw new Error('Mock-режим выключен — включи его в Настройки → AI-обзвон → API ключи')
                }
                throw new Error(data.error ?? `status ${res.status}`)
            }
            router.push(`/calls/${data.callId}`)
        } catch (err: any) {
            setError(err.message ?? 'не удалось создать AI-звонок')
        } finally {
            setLoading(false)
        }
    }

    // Текст подсказки для иконки «?» — короткое объяснение того, что
    // произойдёт после клика. Видно при наведении (native tooltip).
    const hint =
        'Запускает голосовой обзвон лида. Через 1–2 минуты ассистент завершит ' +
        'звонок, а на странице звонка появится анализ разговора и задача ' +
        'менеджеру (если она нужна).'

    return (
        <div className="inline-flex flex-col gap-1">
            <div className="inline-flex items-center gap-1.5">
                <button
                    type="button"
                    onClick={trigger}
                    disabled={loading}
                    className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-white transition-colors hover:bg-primary-dark disabled:cursor-not-allowed disabled:opacity-60"
                    title={hint}
                >
                    {loading
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        : <Sparkles className="h-3.5 w-3.5" />}
                    {label}
                </button>
                {/* Иконка «?» — inline-подсказка для менеджера прямо рядом с
                    кнопкой. Native HTML-tooltip, никакого нового UI-стека. */}
                <span
                    role="img"
                    aria-label="Что делает эта кнопка"
                    title={hint}
                    className="inline-flex h-5 w-5 cursor-help items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-surface hover:text-foreground"
                >
                    <HelpCircle className="h-3.5 w-3.5" />
                </span>
            </div>
            {error && (
                <span className="text-[11px] text-destructive max-w-[260px]">{error}</span>
            )}
        </div>
    )
}
