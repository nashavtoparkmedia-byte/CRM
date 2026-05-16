"use client"

import { useState } from 'react'
import Link from 'next/link'
import {
    KeyRound, CheckCircle2, AlertCircle, Loader2, PlugZap, Sparkles, Info, BadgeCheck,
} from 'lucide-react'
import type { AiCallKeysStatus } from '@/lib/ai-call/keys-status'

interface Props {
    initialStatus: AiCallKeysStatus
    canEdit: boolean
}

type TestResult = { ok: boolean; message: string } | null

export default function AiCallKeysClient({ initialStatus, canEdit }: Props) {
    const status = initialStatus
    const [openaiTest, setOpenaiTest] = useState<TestResult>(null)
    const [yandexTest, setYandexTest] = useState<TestResult>(null)
    const [testingOpenai, setTestingOpenai] = useState(false)
    const [testingYandex, setTestingYandex] = useState(false)

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
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            setRes({ ok: false, message: `Ошибка запроса: ${msg}` })
        } finally {
            setBusy(false)
        }
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
                        Секреты хранятся в файле <code className="rounded bg-surface px-1 py-0.5 text-[12px]">.env</code> — здесь видно только статус и последние 4 символа.
                    </p>
                </div>
            </header>

            {!canEdit && (
                <div className="flex items-start gap-2 rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-muted-foreground">
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                    <span>Только Администратор / Руководитель может менять API ключи. Запрос к <code>.env</code> требует доступа к серверу.</span>
                </div>
            )}

            <KeyCard
                title="OpenAI API key"
                subtitle="Для будущего LLM-диалога (gpt-4o-mini). В Day-1 не используется."
                envName={status.openai.envName}
                configured={status.openai.configured}
                mask={status.openai.mask}
                testLabel="Проверить подключение"
                onTest={() => runTest('openai')}
                testing={testingOpenai}
                testResult={openaiTest}
                canTest={canEdit && status.openai.configured}
                hint="Получить ключ — https://platform.openai.com/api-keys"
            />

            <KeyCard
                title="Yandex SpeechKit API key"
                subtitle="Для распознавания речи (STT v3). Без ключа bridge работает в Day-1 режиме без STT."
                envName={status.yandexSpeechkit.envName}
                configured={status.yandexSpeechkit.configured}
                mask={status.yandexSpeechkit.mask}
                testLabel="Проверить подключение"
                onTest={() => runTest('yandex')}
                testing={testingYandex}
                testResult={yandexTest}
                canTest={canEdit && status.yandexSpeechkit.configured && status.yandexFolderId.configured}
                cantTestReason={
                    !status.yandexSpeechkit.configured
                        ? 'Сначала задай YANDEX_API_KEY'
                        : !status.yandexFolderId.configured
                          ? 'Нужен ещё YANDEX_FOLDER_ID'
                          : undefined
                }
                hint="Получить ключ — https://console.yandex.cloud/folders/.../service-accounts"
            />

            <FolderIdCard
                configured={status.yandexFolderId.configured}
                value={status.yandexFolderId.value}
                envName={status.yandexFolderId.envName}
            />

            <MockModeCard enabled={status.mockMode.enabled} envName={status.mockMode.envName} />

            {/* Inline-подсказка «Как настроить» — короткий гайд на самой
                странице, чтобы админ не уходил во вкладку «Инструкция» за
                базовыми шагами. Полная справка живёт в /ai-call-help. */}
            <section className="rounded-md border border-border bg-surface/40 p-5">
                <h2 className="mb-2 flex items-center gap-2 text-[15px] font-semibold text-foreground">
                    <Info className="h-4 w-4 text-primary" />
                    Как настроить
                </h2>
                <ol className="ml-5 list-decimal space-y-1.5 text-[13px] text-foreground leading-relaxed">
                    <li>Открой файл <code className="rounded bg-background px-1 py-0.5 text-[12px] border border-border">gravity-mvp/.env</code></li>
                    <li>Добавь нужную строку, например <code className="rounded bg-background px-1 py-0.5 text-[12px] border border-border">YANDEX_API_KEY=AQVN...</code></li>
                    <li>Сохрани и перезапусти dev-сервер — Next.js перечитывает env только при старте</li>
                    <li>Обнови эту страницу: статус сменится на «настроено», нажми <b>«Проверить подключение»</b>, чтобы убедиться, что ключ принят</li>
                </ol>
                <p className="mt-3 text-[12px] text-muted-foreground">
                    Нет ключей Yandex/OpenAI — оставь <code>AI_CALL_MOCK_MODE=true</code>: бизнес-флоу будет работать на mock-сценариях без оплаты внешних сервисов.
                </p>
                <p className="mt-3 text-[12px] text-muted-foreground">
                    Подробнее — <Link href="/settings/integrations/ai-call-help" className="text-primary underline-offset-2 hover:underline">Инструкция → Для администратора</Link>
                </p>
            </section>
        </div>
    )
}

function KeyCard(props: {
    title: string
    subtitle: string
    envName: string
    configured: boolean
    mask: string | null
    testLabel: string
    onTest: () => void
    testing: boolean
    testResult: TestResult
    canTest: boolean
    cantTestReason?: string
    hint?: string
}) {
    const { title, subtitle, envName, configured, mask, testLabel, onTest, testing, testResult, canTest, cantTestReason, hint } = props
    return (
        <section className="rounded-md border border-border bg-card p-5">
            <div className="flex items-start justify-between gap-4">
                <div className="flex-1">
                    <div className="flex items-center gap-2">
                        <h2 className="text-[16px] font-semibold text-foreground">{title}</h2>
                        <StatusBadge configured={configured} />
                    </div>
                    <p className="mt-1 text-[13px] text-muted-foreground">{subtitle}</p>
                    <div className="mt-3 flex flex-wrap items-center gap-4 text-[12px] text-muted-foreground">
                        <span>
                            Переменная: <code className="rounded bg-surface px-1.5 py-0.5 text-[12px] text-foreground border border-border">{envName}</code>
                        </span>
                        {configured && mask && (
                            <span>
                                Значение: <code className="rounded bg-surface px-1.5 py-0.5 text-[12px] text-foreground border border-border">{mask}</code>
                            </span>
                        )}
                    </div>
                    {hint && <p className="mt-2 text-[12px] text-muted-foreground">{hint}</p>}
                </div>
                <div className="flex flex-col items-end gap-2">
                    <button
                        type="button"
                        onClick={onTest}
                        disabled={!canTest || testing}
                        title={!canTest ? cantTestReason : undefined}
                        className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-[12px] font-medium text-foreground transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlugZap className="h-3.5 w-3.5" />}
                        {testLabel}
                    </button>
                    {testResult && (
                        <span
                            className={`inline-flex max-w-[260px] items-start gap-1 text-right text-[12px] ${
                                testResult.ok ? 'text-accent' : 'text-destructive'
                            }`}
                        >
                            {testResult.ok ? (
                                <CheckCircle2 className="mt-0.5 h-3 w-3 flex-shrink-0" />
                            ) : (
                                <AlertCircle className="mt-0.5 h-3 w-3 flex-shrink-0" />
                            )}
                            <span>{testResult.message}</span>
                        </span>
                    )}
                </div>
            </div>
        </section>
    )
}

function FolderIdCard({
    configured,
    value,
    envName,
}: {
    configured: boolean
    value: string | null
    envName: string
}) {
    return (
        <section className="rounded-md border border-border bg-card p-5">
            <div className="flex items-start justify-between gap-4">
                <div className="flex-1">
                    <div className="flex items-center gap-2">
                        <h2 className="text-[16px] font-semibold text-foreground">Yandex Folder ID</h2>
                        <StatusBadge configured={configured} />
                    </div>
                    <p className="mt-1 text-[13px] text-muted-foreground">
                        ID каталога Yandex Cloud — нужен SpeechKit для тарификации. Не является секретом, поэтому показывается целиком.
                    </p>
                    <div className="mt-3 flex flex-wrap items-center gap-4 text-[12px] text-muted-foreground">
                        <span>
                            Переменная: <code className="rounded bg-surface px-1.5 py-0.5 text-[12px] text-foreground border border-border">{envName}</code>
                        </span>
                        {configured && value && (
                            <span>
                                Значение: <code className="rounded bg-surface px-1.5 py-0.5 text-[12px] text-foreground border border-border">{value}</code>
                            </span>
                        )}
                    </div>
                </div>
            </div>
        </section>
    )
}

function MockModeCard({ enabled, envName }: { enabled: boolean; envName: string }) {
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
                        Когда включён — кнопка «AI-звонок (mock)» в карточке водителя создаёт фейковый звонок с заранее заготовленным транскриптом, чтобы можно было тестировать UI без OpenAI/Yandex.
                    </p>
                    <div className="mt-3 text-[12px] text-muted-foreground">
                        Переменная: <code className="rounded bg-surface px-1.5 py-0.5 text-[12px] text-foreground border border-border">{envName}={enabled ? 'true' : 'false'}</code>
                    </div>
                    {!enabled && (
                        <p className="mt-2 text-[12px] text-muted-foreground">
                            Чтобы включить — добавь <code className="rounded bg-surface px-1.5 py-0.5 text-[12px] text-foreground border border-border">AI_CALL_MOCK_MODE=true</code> в <code>.env</code> и перезапусти dev-сервер.
                        </p>
                    )}
                </div>
            </div>
        </section>
    )
}

function StatusBadge({ configured }: { configured: boolean }) {
    if (configured) {
        return (
            <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent">
                <CheckCircle2 className="h-3 w-3" />
                настроено
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
