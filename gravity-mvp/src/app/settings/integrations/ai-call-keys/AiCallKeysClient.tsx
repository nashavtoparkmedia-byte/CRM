"use client"

import { useState } from 'react'
import {
    AlertCircle, Loader2, PlugZap, Save, Trash2, Eye, EyeOff,
} from 'lucide-react'
import type { AiCallKeysStatus, KeyStatus } from '@/lib/ai-call/keys-status'
import type { Provider, Key } from '@/lib/ai-call/provider-settings'

interface Props {
    initialStatus: AiCallKeysStatus
    canEdit: boolean
}

type TestResult = { ok: boolean; message: string } | null
type SaveState = { saving: boolean; error: string | null }

export function AiCallKeysSection({ initialStatus, canEdit }: Props) {
    const [status, setStatus] = useState<AiCallKeysStatus>(initialStatus)
    const [openaiTest, setOpenaiTest] = useState<TestResult>(null)
    const [yandexTest, setYandexTest] = useState<TestResult>(null)
    const [testingOpenai, setTestingOpenai] = useState(false)
    const [testingYandex, setTestingYandex] = useState(false)

    async function reloadStatus() {
        try {
            const res = await fetch('/api/settings/ai-call-keys', { cache: 'no-store' })
            if (res.ok) setStatus(await res.json())
        } catch {}
    }

    async function saveKey(provider: Provider, key: Key, value: string): Promise<{ ok: boolean; error?: string }> {
        const res = await fetch('/api/settings/ai-call-keys', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider, key, value }),
        })
        if (!res.ok) {
            const body = await res.json().catch(() => ({}))
            return { ok: false, error: body.error ?? `HTTP ${res.status}` }
        }
        await reloadStatus()
        return { ok: true }
    }

    async function deleteKey(provider: Provider, key: Key): Promise<void> {
        const params = new URLSearchParams({ provider, key })
        await fetch(`/api/settings/ai-call-keys?${params}`, { method: 'DELETE' })
        await reloadStatus()
    }

    async function runTest(provider: 'openai' | 'yandex') {
        const setBusy = provider === 'openai' ? setTestingOpenai : setTestingYandex
        const setRes = provider === 'openai' ? setOpenaiTest : setYandexTest
        setBusy(true)
        setRes(null)
        try {
            const res = await fetch('/api/settings/ai-call-keys/test', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ provider }),
            })
            const data = await res.json()
            setRes({ ok: !!data.ok, message: data.message ?? data.error ?? 'unknown' })
            await reloadStatus()
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            setRes({ ok: false, message: `Ошибка запроса: ${msg}` })
        } finally {
            setBusy(false)
        }
    }

    async function toggleMockMode(enabled: boolean): Promise<void> {
        await saveKey('system', 'mockMode', enabled ? 'true' : 'false')
    }

    return (
        <div className="flex flex-col gap-3 animate-in fade-in duration-200">
            <KeyRow
                title="OpenAI API key"
                hint="LLM-диалог (gpt-4o-mini) + резервный STT/TTS, если ключи Yandex не настроены."
                placeholder="sk-proj-..."
                status={status.openai}
                canEdit={canEdit}
                onSave={value => saveKey('openai', 'apiKey', value)}
                onDelete={() => deleteKey('openai', 'apiKey')}
                onTest={() => runTest('openai')}
                testing={testingOpenai}
                testResult={openaiTest}
                canTest={canEdit && status.openai.configured}
                cantTestReason={!status.openai.configured ? 'Сначала сохрани ключ' : undefined}
            />

            <KeyRow
                title="Yandex SpeechKit API key"
                hint="Нативное русское распознавание речи (STT v3) и синтез голоса (TTS). Приоритет над OpenAI для STT/TTS."
                placeholder="AQVN..."
                status={status.yandexSpeechkit}
                canEdit={canEdit}
                onSave={value => saveKey('yandex', 'apiKey', value)}
                onDelete={() => deleteKey('yandex', 'apiKey')}
                onTest={() => runTest('yandex')}
                testing={testingYandex}
                testResult={yandexTest}
                canTest={canEdit && status.yandexSpeechkit.configured && status.yandexFolderId.configured}
                cantTestReason={
                    !status.yandexSpeechkit.configured
                        ? 'Сначала сохрани ключ'
                        : !status.yandexFolderId.configured
                          ? 'Нужен Yandex Folder ID'
                          : undefined
                }
            />

            <KeyRow
                title="Yandex Folder ID"
                hint="ID каталога Yandex Cloud — нужен SpeechKit для тарификации. Не секрет, поэтому показывается целиком."
                placeholder="b1g..."
                status={status.yandexFolderId}
                canEdit={canEdit}
                onSave={value => saveKey('yandex', 'folderId', value)}
                onDelete={() => deleteKey('yandex', 'folderId')}
                masked={false}
            />

            <MockModeRow
                enabled={status.mockMode.enabled}
                canEdit={canEdit}
                onToggle={toggleMockMode}
                hint="Когда включён — кнопка «AI-звонок (mock)» в карточке водителя создаёт фейковый звонок с готовым транскриптом, чтобы тестировать UI без оплаты внешних сервисов."
            />
        </div>
    )
}

// ── KeyRow: single row for secret + plain values ─────────────────────────────

function KeyRow(props: {
    title: string
    /** One-line tooltip + expanded hint on hover. Explains what the key does. */
    hint?: string
    placeholder: string
    status: KeyStatus
    canEdit: boolean
    onSave: (value: string) => Promise<{ ok: boolean; error?: string }>
    onDelete: () => Promise<void>
    onTest?: () => void
    testing?: boolean
    testResult?: TestResult
    canTest?: boolean
    cantTestReason?: string
    masked?: boolean
}) {
    const {
        title, hint, placeholder, status, canEdit,
        onSave, onDelete, onTest, testing = false, testResult, canTest = false, cantTestReason,
        masked = true,
    } = props

    const [value, setValue] = useState('')
    const [show, setShow] = useState(false)
    const [save, setSave] = useState<SaveState>({ saving: false, error: null })
    const [deleting, setDeleting] = useState(false)
    const [editing, setEditing] = useState(false)

    async function handleSave() {
        if (!value.trim()) {
            setSave({ saving: false, error: 'Введи значение' })
            return
        }
        setSave({ saving: true, error: null })
        const res = await onSave(value)
        if (res.ok) {
            setValue('')
            setEditing(false)
            setSave({ saving: false, error: null })
        } else {
            setSave({ saving: false, error: res.error ?? 'не удалось сохранить' })
        }
    }

    async function handleDelete() {
        if (!confirm(`Удалить «${title}»?`)) return
        setDeleting(true)
        try { await onDelete() } finally { setDeleting(false) }
    }

    // Compact status indicator: dot color + short label.
    // ВАЖНО: в проекте --accent определён как #f5f5f5 (нейтральный UI-серый),
    // не как «success green». Поэтому статусные точки нужно красить явными
    // Tailwind палитрами, а не bg-accent / bg-destructive.
    const dot = (() => {
        if (!status.configured) return { color: 'bg-gray-400', label: 'не настроен' }
        if (status.lastCheckStatus && status.lastCheckStatus !== 'ok') {
            return { color: 'bg-red-500', label: 'ошибка проверки' }
        }
        return { color: 'bg-green-500', label: 'настроен' }
    })()

    return (
        <section
            // Inline-hint снизу — единственный канал подсказки. Native
            // `title=` убрали, чтобы desktop-popup поверх окна не дублировал
            // его и не закрывал кнопки.
            className="group rounded-md border border-border bg-card px-4 py-3 transition-colors hover:border-primary/40 hover:bg-surface/40"
        >
            <div className="flex items-center gap-3">
                {/* Status dot — 10px, с тонким контрастным ring для лучшей
                    видимости на белом фоне карточки. */}
                <span
                    aria-hidden
                    className={`inline-block h-2.5 w-2.5 flex-shrink-0 rounded-full ring-2 ring-white ${dot.color}`}
                />
                <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-baseline gap-2">
                        <span className="text-[14px] font-medium text-foreground">{title}</span>
                        <span className="text-[12px] text-muted-foreground">{dot.label}</span>
                        {status.configured && status.mask && (
                            <code className="rounded bg-surface px-1.5 py-0.5 text-[12px] text-foreground border border-border">
                                {masked ? status.mask : status.mask.replace(/^•+\s*/, '')}
                            </code>
                        )}
                    </div>
                    {/* Inline expand при hover. max-h-40 чтобы трехстрочный
                        текст «Mock-режим» влезал целиком (max-h-24 был
                        слишком мал, текст обрезался). */}
                    {hint && (
                        <div className="mt-0.5 max-h-0 overflow-hidden text-[12px] leading-relaxed text-muted-foreground opacity-0 transition-all duration-200 group-hover:mt-1 group-hover:max-h-40 group-hover:opacity-100">
                            {hint}
                        </div>
                    )}
                    {testResult && (
                        <div className={`mt-0.5 text-[11px] ${testResult.ok ? 'text-green-600' : 'text-red-600'}`}>
                            {testResult.message}
                        </div>
                    )}
                </div>

                {canEdit && !editing && (
                    // Жёсткая защита от схлопывания:
                    // - flex-shrink-0 на контейнере (не сжимается, когда
                    //   title-pane с flex-1 пытается забрать место);
                    // - flex (а не inline-flex) на каждой кнопке (inline-flex
                    //   в flex parent в Tailwind v4 даёт baseline-align quirks);
                    // - whitespace-nowrap чтобы текст «Проверить» / «Изменить»
                    //   не переносился на 2 строки при тесном viewport.
                    <div className="flex flex-shrink-0 items-center gap-2">
                        {onTest && (
                            <button
                                type="button"
                                onClick={onTest}
                                disabled={!canTest || testing}
                                title={!canTest ? cantTestReason : 'Проверить подключение'}
                                className="flex h-9 flex-shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-background px-3 text-[13px] font-medium text-foreground transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlugZap className="h-3.5 w-3.5" />}
                                Проверить
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={() => setEditing(true)}
                            className="flex h-9 flex-shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-primary px-3.5 text-[13px] font-medium text-white transition-colors hover:bg-primary-dark"
                        >
                            <Save className="h-3.5 w-3.5" />
                            {status.configured ? 'Изменить' : 'Сохранить'}
                        </button>
                        {status.configured && status.source !== 'env' && (
                            <button
                                type="button"
                                onClick={handleDelete}
                                disabled={deleting}
                                title="Удалить ключ"
                                className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md border border-border bg-background text-destructive transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                            </button>
                        )}
                    </div>
                )}
            </div>

            {canEdit && editing && (
                <div className="mt-3 flex flex-col gap-1.5">
                    <div className="flex gap-2">
                        <div className="flex-1 relative">
                            <input
                                type={show || !masked ? 'text' : 'password'}
                                value={value}
                                onChange={e => setValue(e.target.value)}
                                placeholder={placeholder}
                                autoFocus
                                className="h-9 w-full rounded-md border border-border bg-background px-3 pr-9 font-mono text-[13px] text-foreground outline-none transition-colors focus:border-primary"
                                autoComplete="off"
                                spellCheck={false}
                                onKeyDown={e => {
                                    if (e.key === 'Enter') handleSave()
                                    if (e.key === 'Escape') { setEditing(false); setValue(''); setSave({ saving: false, error: null }) }
                                }}
                            />
                            {masked && (
                                <button
                                    type="button"
                                    onClick={() => setShow(!show)}
                                    className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-surface hover:text-foreground"
                                    title={show ? 'Скрыть' : 'Показать'}
                                >
                                    {show ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                                </button>
                            )}
                        </div>
                        <button
                            type="button"
                            onClick={handleSave}
                            disabled={save.saving || !value.trim()}
                            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-white transition-colors hover:bg-primary-dark disabled:cursor-not-allowed disabled:opacity-60"
                        >
                            {save.saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                            Сохранить
                        </button>
                        <button
                            type="button"
                            onClick={() => { setEditing(false); setValue(''); setSave({ saving: false, error: null }) }}
                            className="inline-flex h-9 items-center rounded-md border border-border bg-background px-3 text-[13px] font-medium text-foreground transition-colors hover:bg-surface"
                        >
                            Отмена
                        </button>
                    </div>
                    {save.error && (
                        <span className="inline-flex items-start gap-1 text-[11px] text-destructive">
                            <AlertCircle className="mt-0.5 h-3 w-3 flex-shrink-0" />
                            {save.error}
                        </span>
                    )}
                </div>
            )}
        </section>
    )
}

// ── MockModeRow — boolean toggle (Telegram-style switch) ─────────────────────

function MockModeRow({
    enabled,
    canEdit,
    onToggle,
    hint,
}: {
    enabled: boolean
    canEdit: boolean
    onToggle: (enabled: boolean) => Promise<void>
    hint?: string
}) {
    const [busy, setBusy] = useState(false)

    async function handleToggle() {
        if (busy) return
        setBusy(true)
        try { await onToggle(!enabled) } finally { setBusy(false) }
    }

    // Same colour rationale as KeyRow — explicit palette, not bg-accent
    // (which is project-level neutral grey, not «success»).
    const dot = enabled
        ? { color: 'bg-green-500', label: 'включён' }
        : { color: 'bg-gray-400', label: 'выключен' }

    return (
        <section
            className="group rounded-md border border-border bg-card px-4 py-3 transition-colors hover:border-primary/40 hover:bg-surface/40"
        >
            <div className="flex items-center gap-3">
                <span aria-hidden className={`inline-block h-2.5 w-2.5 flex-shrink-0 rounded-full ring-2 ring-white ${dot.color}`} />
                <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2">
                        <span className="text-[14px] font-medium text-foreground">Mock-режим</span>
                        <span className="text-[12px] text-muted-foreground">{dot.label}</span>
                    </div>
                    {hint && (
                        <div className="mt-0.5 max-h-0 overflow-hidden text-[12px] leading-relaxed text-muted-foreground opacity-0 transition-all duration-200 group-hover:mt-1 group-hover:max-h-40 group-hover:opacity-100">
                            {hint}
                        </div>
                    )}
                </div>
                {canEdit && (
                    <button
                        type="button"
                        onClick={handleToggle}
                        disabled={busy}
                        role="switch"
                        aria-checked={enabled}
                        title={enabled ? 'Выключить mock-режим' : 'Включить mock-режим'}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                            enabled ? 'bg-primary' : 'bg-muted-foreground/30'
                        } disabled:cursor-not-allowed disabled:opacity-60`}
                    >
                        <span
                            aria-hidden
                            className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                                enabled ? 'translate-x-5' : 'translate-x-0.5'
                            }`}
                        />
                    </button>
                )}
            </div>
        </section>
    )
}
