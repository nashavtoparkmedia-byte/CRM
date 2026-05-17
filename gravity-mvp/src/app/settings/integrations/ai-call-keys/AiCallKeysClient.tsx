"use client"

import { useState } from 'react'
import Link from 'next/link'
import {
    KeyRound, CheckCircle2, AlertCircle, Loader2, PlugZap, Sparkles, Info, BadgeCheck,
    Save, Trash2, Eye, EyeOff,
} from 'lucide-react'
import type { AiCallKeysStatus, KeyStatus } from '@/lib/ai-call/keys-status'
import type { Provider, Key } from '@/lib/ai-call/provider-settings'

interface Props {
    initialStatus: AiCallKeysStatus
    canEdit: boolean
}

type TestResult = { ok: boolean; message: string } | null
type SaveState = { saving: boolean; error: string | null }

export default function AiCallKeysClient({ initialStatus, canEdit }: Props) {
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
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-6 animate-in fade-in duration-300">
            <header className="flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/10">
                    <KeyRound className="h-5 w-5 text-primary" />
                </div>
                <div className="flex-1">
                    <h1 className="text-[20px] font-semibold leading-tight text-foreground">API ключи AI-обзвона</h1>
                    <p className="text-[13px] text-muted-foreground">
                        Ключи хранятся в базе данных в зашифрованном виде. В UI видна только маска последних 4 символов.
                    </p>
                </div>
            </header>

            {!canEdit && (
                <div className="flex items-start gap-2 rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-muted-foreground">
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                    <span>Только Администратор / Руководитель может менять API ключи.</span>
                </div>
            )}

            <SecretCard
                title="OpenAI API key"
                subtitle="Для LLM-диалога (gpt-4o-mini) и резервного STT/TTS, если нет Yandex."
                placeholder="sk-proj-..."
                hint="Получить ключ — https://platform.openai.com/api-keys"
                status={status.openai}
                canEdit={canEdit}
                onSave={value => saveKey('openai', 'apiKey', value)}
                onDelete={() => deleteKey('openai', 'apiKey')}
                onTest={() => runTest('openai')}
                testing={testingOpenai}
                testResult={openaiTest}
                canTest={canEdit && status.openai.configured}
                cantTestReason={!status.openai.configured ? 'Сначала задай ключ и нажми «Сохранить»' : undefined}
            />

            <SecretCard
                title="Yandex SpeechKit API key"
                subtitle="Для нативного русского распознавания речи (STT v3) и синтеза (TTS)."
                placeholder="AQVN..."
                hint="Получить ключ — https://console.yandex.cloud/folders/.../service-accounts"
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
                        ? 'Сначала задай API key и нажми «Сохранить»'
                        : !status.yandexFolderId.configured
                          ? 'Нужен ещё Yandex Folder ID'
                          : undefined
                }
            />

            <PlainCard
                title="Yandex Folder ID"
                subtitle="ID каталога Yandex Cloud — нужен SpeechKit для тарификации. Не секрет, показывается целиком."
                placeholder="b1g..."
                status={status.yandexFolderId}
                canEdit={canEdit}
                onSave={value => saveKey('yandex', 'folderId', value)}
                onDelete={() => deleteKey('yandex', 'folderId')}
            />

            <MockModeCard
                enabled={status.mockMode.enabled}
                canEdit={canEdit}
                onToggle={toggleMockMode}
            />

            {/* Inline-подсказка «Как настроить» — короткий гайд на самой
                странице, чтобы админ не уходил во вкладку «Инструкция». */}
            <section className="rounded-md border border-border bg-surface/40 p-5">
                <h2 className="mb-2 flex items-center gap-2 text-[15px] font-semibold text-foreground">
                    <Info className="h-4 w-4 text-primary" />
                    Как настроить
                </h2>
                <ol className="ml-5 list-decimal space-y-1.5 text-[13px] text-foreground leading-relaxed">
                    <li>Получи API ключ у провайдера (ссылки в карточках выше)</li>
                    <li>Вставь его в нужное поле и нажми <b>«Сохранить»</b></li>
                    <li>Нажми <b>«Проверить подключение»</b> — система отправит тестовый запрос и покажет результат</li>
                    <li>Если хочешь полностью обновить ключ — сначала <b>«Удалить»</b>, затем сохрани новый</li>
                </ol>
                <p className="mt-3 text-[12px] text-muted-foreground">
                    Если ключей пока нет — включи <b>Mock-режим</b> ниже: бизнес-флоу будет работать на фейковых сценариях без оплаты внешних сервисов.
                </p>
                <p className="mt-3 text-[12px] text-muted-foreground">
                    Подробнее — <Link href="/settings/integrations/ai-call-help" className="text-primary underline-offset-2 hover:underline">Инструкция → Для администратора</Link>
                </p>
            </section>
        </div>
    )
}

// ── Card for a SECRET value (apiKey) ──────────────────────────────────────────

function SecretCard(props: {
    title: string
    subtitle: string
    placeholder: string
    hint?: string
    status: KeyStatus
    canEdit: boolean
    onSave: (value: string) => Promise<{ ok: boolean; error?: string }>
    onDelete: () => Promise<void>
    onTest: () => void
    testing: boolean
    testResult: TestResult
    canTest: boolean
    cantTestReason?: string
}) {
    const {
        title, subtitle, placeholder, hint, status, canEdit,
        onSave, onDelete, onTest, testing, testResult, canTest, cantTestReason,
    } = props

    const [value, setValue] = useState('')
    const [show, setShow] = useState(false)
    const [save, setSave] = useState<SaveState>({ saving: false, error: null })
    const [deleting, setDeleting] = useState(false)

    async function handleSave() {
        if (!value.trim()) {
            setSave({ saving: false, error: 'Введи значение перед сохранением' })
            return
        }
        setSave({ saving: true, error: null })
        const res = await onSave(value)
        if (res.ok) {
            setValue('')
            setSave({ saving: false, error: null })
        } else {
            setSave({ saving: false, error: res.error ?? 'не удалось сохранить' })
        }
    }

    async function handleDelete() {
        if (!confirm(`Удалить «${title}»? Действие необратимо.`)) return
        setDeleting(true)
        try { await onDelete() } finally { setDeleting(false) }
    }

    return (
        <section className="rounded-md border border-border bg-card p-5">
            <div className="flex items-start justify-between gap-3 mb-3">
                <div className="flex-1">
                    <div className="flex items-center gap-2">
                        <h2 className="text-[16px] font-semibold text-foreground">{title}</h2>
                        <StatusBadge status={status} />
                    </div>
                    <p className="mt-1 text-[13px] text-muted-foreground">{subtitle}</p>
                </div>
            </div>

            {/* Current value (mask) — only if configured */}
            {status.configured && status.mask && (
                <div className="mb-3 flex flex-wrap items-center gap-3 rounded-md border border-border bg-surface/50 px-3 py-2 text-[13px]">
                    <span className="text-muted-foreground">Текущее значение:</span>
                    <code className="rounded bg-background px-2 py-0.5 text-[12px] text-foreground border border-border">{status.mask}</code>
                    {status.source === 'env' && (
                        <span className="text-[11px] text-muted-foreground">
                            (источник: <code>.env</code> — сохрани через форму, чтобы перенести в БД)
                        </span>
                    )}
                    {canEdit && (
                        <button
                            type="button"
                            onClick={handleDelete}
                            disabled={deleting || status.source === 'env'}
                            title={status.source === 'env' ? 'Значение в .env — удаляется правкой .env, не через UI' : undefined}
                            className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-[12px] font-medium text-destructive transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            {deleting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                            Удалить ключ
                        </button>
                    )}
                </div>
            )}

            {/* Input + Save */}
            {canEdit && (
                <div className="flex flex-col gap-2">
                    <div className="flex gap-2">
                        <div className="flex-1 relative">
                            <input
                                type={show ? 'text' : 'password'}
                                value={value}
                                onChange={e => setValue(e.target.value)}
                                placeholder={placeholder}
                                className="h-10 w-full rounded-md border border-border bg-background px-3 pr-10 font-mono text-[13px] text-foreground outline-none transition-colors focus:border-primary"
                                autoComplete="off"
                                spellCheck={false}
                            />
                            <button
                                type="button"
                                onClick={() => setShow(!show)}
                                className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-surface hover:text-foreground"
                                title={show ? 'Скрыть' : 'Показать'}
                            >
                                {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                            </button>
                        </div>
                        <button
                            type="button"
                            onClick={handleSave}
                            disabled={save.saving || !value.trim()}
                            className="inline-flex h-10 items-center gap-1.5 rounded-md bg-primary px-4 text-[13px] font-medium text-white transition-colors hover:bg-primary-dark disabled:cursor-not-allowed disabled:opacity-60"
                        >
                            {save.saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                            Сохранить
                        </button>
                        <button
                            type="button"
                            onClick={onTest}
                            disabled={!canTest || testing}
                            title={!canTest ? cantTestReason : undefined}
                            className="inline-flex h-10 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-[13px] font-medium text-foreground transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlugZap className="h-3.5 w-3.5" />}
                            Проверить
                        </button>
                    </div>
                    {save.error && (
                        <span className="inline-flex items-start gap-1 text-[12px] text-destructive">
                            <AlertCircle className="mt-0.5 h-3 w-3 flex-shrink-0" />
                            {save.error}
                        </span>
                    )}
                </div>
            )}

            {/* Test result */}
            {testResult && (
                <span className={`mt-3 inline-flex items-start gap-1 text-[12px] ${testResult.ok ? 'text-accent' : 'text-destructive'}`}>
                    {testResult.ok ? <CheckCircle2 className="mt-0.5 h-3 w-3 flex-shrink-0" /> : <AlertCircle className="mt-0.5 h-3 w-3 flex-shrink-0" />}
                    {testResult.message}
                </span>
            )}

            {/* Last check from DB */}
            {!testResult && status.lastCheckedAt && (
                <p className="mt-2 text-[12px] text-muted-foreground">
                    Последняя проверка:{' '}
                    <span className={status.lastCheckStatus === 'ok' ? 'text-accent' : 'text-destructive'}>
                        {status.lastCheckMessage ?? status.lastCheckStatus}
                    </span>
                </p>
            )}

            {hint && <p className="mt-2 text-[12px] text-muted-foreground">{hint}</p>}
        </section>
    )
}

// ── Card for a PLAIN-TEXT value (folderId) ────────────────────────────────────

function PlainCard(props: {
    title: string
    subtitle: string
    placeholder: string
    status: KeyStatus
    canEdit: boolean
    onSave: (value: string) => Promise<{ ok: boolean; error?: string }>
    onDelete: () => Promise<void>
}) {
    const { title, subtitle, placeholder, status, canEdit, onSave, onDelete } = props
    const [value, setValue] = useState('')
    const [save, setSave] = useState<SaveState>({ saving: false, error: null })
    const [deleting, setDeleting] = useState(false)

    async function handleSave() {
        if (!value.trim()) { setSave({ saving: false, error: 'Введи значение' }); return }
        setSave({ saving: true, error: null })
        const res = await onSave(value)
        if (res.ok) { setValue(''); setSave({ saving: false, error: null }) }
        else setSave({ saving: false, error: res.error ?? 'не удалось сохранить' })
    }

    async function handleDelete() {
        if (!confirm(`Удалить «${title}»?`)) return
        setDeleting(true)
        try { await onDelete() } finally { setDeleting(false) }
    }

    return (
        <section className="rounded-md border border-border bg-card p-5">
            <div className="flex items-start justify-between gap-3 mb-3">
                <div className="flex-1">
                    <div className="flex items-center gap-2">
                        <h2 className="text-[16px] font-semibold text-foreground">{title}</h2>
                        <StatusBadge status={status} />
                    </div>
                    <p className="mt-1 text-[13px] text-muted-foreground">{subtitle}</p>
                </div>
            </div>

            {status.configured && status.mask && (
                <div className="mb-3 flex flex-wrap items-center gap-3 rounded-md border border-border bg-surface/50 px-3 py-2 text-[13px]">
                    <span className="text-muted-foreground">Текущее значение:</span>
                    <code className="rounded bg-background px-2 py-0.5 text-[12px] text-foreground border border-border">{status.mask}</code>
                    {status.source === 'env' && (
                        <span className="text-[11px] text-muted-foreground">(источник: <code>.env</code>)</span>
                    )}
                    {canEdit && (
                        <button
                            type="button"
                            onClick={handleDelete}
                            disabled={deleting || status.source === 'env'}
                            title={status.source === 'env' ? 'Значение в .env — удаляется правкой .env' : undefined}
                            className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-[12px] font-medium text-destructive transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            {deleting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                            Удалить
                        </button>
                    )}
                </div>
            )}

            {canEdit && (
                <div className="flex flex-col gap-2">
                    <div className="flex gap-2">
                        <input
                            type="text"
                            value={value}
                            onChange={e => setValue(e.target.value)}
                            placeholder={placeholder}
                            className="h-10 flex-1 rounded-md border border-border bg-background px-3 font-mono text-[13px] text-foreground outline-none transition-colors focus:border-primary"
                            autoComplete="off"
                            spellCheck={false}
                        />
                        <button
                            type="button"
                            onClick={handleSave}
                            disabled={save.saving || !value.trim()}
                            className="inline-flex h-10 items-center gap-1.5 rounded-md bg-primary px-4 text-[13px] font-medium text-white transition-colors hover:bg-primary-dark disabled:cursor-not-allowed disabled:opacity-60"
                        >
                            {save.saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                            Сохранить
                        </button>
                    </div>
                    {save.error && (
                        <span className="inline-flex items-start gap-1 text-[12px] text-destructive">
                            <AlertCircle className="mt-0.5 h-3 w-3 flex-shrink-0" />
                            {save.error}
                        </span>
                    )}
                </div>
            )}
        </section>
    )
}

// ── Card for Mock mode (boolean toggle) ───────────────────────────────────────

function MockModeCard({
    enabled,
    canEdit,
    onToggle,
}: {
    enabled: boolean
    canEdit: boolean
    onToggle: (enabled: boolean) => Promise<void>
}) {
    const [busy, setBusy] = useState(false)

    async function handleToggle() {
        if (busy) return
        setBusy(true)
        try { await onToggle(!enabled) } finally { setBusy(false) }
    }

    return (
        <section className="rounded-md border border-border bg-card p-5">
            <div className="flex items-start justify-between gap-4">
                <div className="flex-1">
                    <div className="flex items-center gap-2">
                        <Sparkles className="h-4 w-4 text-primary" />
                        <h2 className="text-[16px] font-semibold text-foreground">Mock-режим</h2>
                        {enabled ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent">
                                <BadgeCheck className="h-3 w-3" />
                                включён
                            </span>
                        ) : (
                            <span className="inline-flex items-center gap-1 rounded-full bg-surface px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                                выключен
                            </span>
                        )}
                    </div>
                    <p className="mt-1 text-[13px] text-muted-foreground">
                        Когда включён — кнопка «AI-звонок (mock)» в карточке водителя создаёт фейковый звонок с заранее заготовленным транскриптом, чтобы тестировать UI без OpenAI/Yandex.
                    </p>
                </div>
                {canEdit && (
                    <button
                        type="button"
                        onClick={handleToggle}
                        disabled={busy}
                        className={`inline-flex h-10 items-center gap-1.5 rounded-md px-4 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                            enabled
                                ? 'border border-border bg-background text-foreground hover:bg-surface'
                                : 'bg-primary text-white hover:bg-primary-dark'
                        }`}
                    >
                        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                        {enabled ? 'Выключить' : 'Включить'}
                    </button>
                )}
            </div>
        </section>
    )
}

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: KeyStatus }) {
    if (status.configured) {
        return (
            <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent">
                <CheckCircle2 className="h-3 w-3" />
                настроено
                {status.source === 'env' && <span className="text-[10px] text-muted-foreground">(.env)</span>}
            </span>
        )
    }
    return (
        <span className="inline-flex items-center gap-1 rounded-full bg-surface px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            <AlertCircle className="h-3 w-3" />
            не настроено
        </span>
    )
}
