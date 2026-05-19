"use client"

import { useState } from "react"
import { Save, RotateCcw, AlertCircle, CheckCircle2, Loader2 } from "lucide-react"
import TelephonyTabs from "../_components/TelephonyTabs"

interface ConfigShape {
    id: string
    enabled: boolean
    model: string
    systemPrompt: string
    updatedAt: string | Date
}

// Curated list of OpenAI models. Admins can also pass any other model name
// directly to the API if OpenAI rolls out a new one.
const MODEL_OPTIONS = [
    { value: 'gpt-4o',         label: 'GPT-4o (рекомендовано — баланс качества и стоимости)' },
    { value: 'gpt-4-turbo',    label: 'GPT-4 Turbo (стабильный fallback)' },
    { value: 'gpt-4o-mini',    label: 'GPT-4o mini (дешевле, для большого потока звонков)' },
]

export default function TelephonyAiClient({
    initialConfig,
    defaultPrompt,
    canEdit,
}: {
    initialConfig: ConfigShape
    defaultPrompt: string
    canEdit: boolean
}) {
    const [enabled, setEnabled] = useState(initialConfig.enabled)
    const [model, setModel] = useState(initialConfig.model)
    const [systemPrompt, setSystemPrompt] = useState(initialConfig.systemPrompt)
    const [saving, setSaving] = useState(false)
    const [status, setStatus] = useState<{ kind: 'ok' | 'error'; message: string } | null>(null)

    const dirty =
        enabled !== initialConfig.enabled ||
        model !== initialConfig.model ||
        systemPrompt !== initialConfig.systemPrompt

    async function handleSave() {
        if (!canEdit) return
        setSaving(true)
        setStatus(null)
        try {
            const res = await fetch('/api/settings/telephony-ai', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled, model, systemPrompt }),
            })
            if (!res.ok) {
                const body = await res.json().catch(() => ({}))
                throw new Error(body.error ?? `status ${res.status}`)
            }
            setStatus({ kind: 'ok', message: 'Сохранено' })
            // Auto-clear the indicator so it doesn't linger
            setTimeout(() => setStatus(null), 2500)
        } catch (err: any) {
            setStatus({ kind: 'error', message: err.message ?? 'ошибка сохранения' })
        } finally {
            setSaving(false)
        }
    }

    function handleResetPrompt() {
        if (!canEdit) return
        setSystemPrompt(defaultPrompt)
    }

    return (
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-6 animate-in fade-in duration-300">
            <TelephonyTabs active="ai" />

            {!canEdit && (
                <div className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-muted-foreground">
                    <AlertCircle className="h-3.5 w-3.5" />
                    Только Администратор / Руководитель может редактировать настройки.
                </div>
            )}

            <section className="flex flex-col gap-4 rounded-md border border-border bg-card p-5">
                <div className="flex items-center justify-between">
                    <div>
                        <div className="text-[15px] font-semibold text-foreground">Включить AI-анализ</div>
                        <div className="text-[13px] text-muted-foreground">
                            Когда выключено — звонки записываются и расшифровываются, но Claude не вызывается.
                        </div>
                    </div>
                    <Toggle checked={enabled} onChange={setEnabled} disabled={!canEdit} />
                </div>
            </section>

            <section className="flex flex-col gap-3 rounded-md border border-border bg-card p-5">
                <label className="text-[13px] font-medium text-muted-foreground" htmlFor="model">
                    Модель
                </label>
                <select
                    id="model"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    disabled={!canEdit}
                    className="h-11 rounded-md border border-border bg-background px-3 text-[15px] text-foreground outline-none transition-colors focus:border-primary disabled:cursor-not-allowed disabled:opacity-60"
                >
                    {!MODEL_OPTIONS.some(o => o.value === model) && (
                        <option value={model}>{model} (custom)</option>
                    )}
                    {MODEL_OPTIONS.map(o => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                </select>
                <p className="text-[12px] text-muted-foreground">
                    GPT-4o рекомендован: достаточно глубоко рассуждает для рубрики и быстро отвечает.
                </p>
            </section>

            <section className="flex flex-col gap-3 rounded-md border border-border bg-card p-5">
                <div className="flex items-center justify-between">
                    <label className="text-[13px] font-medium text-muted-foreground" htmlFor="prompt">
                        Системный промт
                    </label>
                    {canEdit && (
                        <button
                            type="button"
                            onClick={handleResetPrompt}
                            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-muted-foreground hover:text-foreground hover:bg-surface"
                        >
                            <RotateCcw className="h-3 w-3" />
                            Сбросить к шаблону
                        </button>
                    )}
                </div>
                <textarea
                    id="prompt"
                    value={systemPrompt}
                    onChange={(e) => setSystemPrompt(e.target.value)}
                    disabled={!canEdit}
                    rows={16}
                    className="min-h-[300px] w-full rounded-md border border-border bg-background p-3 font-mono text-[13px] leading-[1.5] text-foreground outline-none transition-colors focus:border-primary disabled:cursor-not-allowed disabled:opacity-60"
                />
                <p className="text-[12px] text-muted-foreground">
                    OpenAI автоматически кэширует префикс промта ≥1024 токенов на ~5 минут — экономия ~50% на input при потоке звонков.
                    Изменения мгновенно применяются к новым звонкам и сбрасывают кэш на один цикл.
                </p>
            </section>

            <footer className="sticky bottom-4 z-10 flex items-center justify-between rounded-md border border-border bg-card px-4 py-3 shadow-sm">
                <div className="text-[12px] text-muted-foreground">
                    {status?.kind === 'ok' && (
                        <span className="inline-flex items-center gap-1 text-accent">
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            {status.message}
                        </span>
                    )}
                    {status?.kind === 'error' && (
                        <span className="inline-flex items-center gap-1 text-destructive">
                            <AlertCircle className="h-3.5 w-3.5" />
                            {status.message}
                        </span>
                    )}
                    {!status && (
                        <>Последнее сохранение: {new Date(initialConfig.updatedAt).toLocaleString('ru-RU')}</>
                    )}
                </div>
                <button
                    type="button"
                    onClick={handleSave}
                    disabled={!canEdit || !dirty || saving}
                    className="inline-flex h-11 items-center gap-2 rounded-md bg-primary px-5 text-[15px] font-semibold text-white transition-colors hover:bg-primary-dark disabled:cursor-not-allowed disabled:opacity-60"
                >
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    Сохранить
                </button>
            </footer>
        </div>
    )
}

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            onClick={() => !disabled && onChange(!checked)}
            disabled={disabled}
            className={[
                'relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors',
                checked ? 'bg-primary' : 'bg-border',
                disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
            ].join(' ')}
        >
            <span
                className={[
                    'inline-block h-5 w-5 transform rounded-full bg-white transition-transform',
                    checked ? 'translate-x-5' : 'translate-x-0.5',
                ].join(' ')}
            />
        </button>
    )
}
