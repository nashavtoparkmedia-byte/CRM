'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
    CREATE_AI_CALL_CAMPAIGN_COMMAND_V1,
    parseCreateAiCallCampaignCommandV1,
    type CreateAiCallCampaignCommandV1,
    type AiCallCampaignSummaryV1,
} from '@/contracts/calling/v1'

const PENDING_CREATE_STORAGE_KEY = 'yoko.ai-calls.pending-create.v1'

interface PendingCreateEnvelopeV1 {
    version: 1
    actorId: string
    command: CreateAiCallCampaignCommandV1
}

interface ScenarioOption {
    id: string
    name: string
}
function stateLabel(state: string): string {
    return ({
        draft: 'Черновик', ready: 'Готова', scheduled: 'Запланирована', running: 'В работе',
        paused: 'На паузе', cancelling: 'Отменяется', completed: 'Завершена',
        cancelled: 'Отменена', failed: 'Ошибка',
    } as Record<string, string>)[state] ?? state
}

function parseAudience(source: string) {
    return source.split('\n').map((line) => line.trim()).filter(Boolean).map((line, index) => {
        const fields = line.split(',').map((value) => value.trim())
        const phoneE164 = fields.at(-1) ?? ''
        const label = fields.length > 1 ? fields.slice(0, -1).join(', ') : `Участник ${index + 1}`
        return { targetRef: `manual-${index + 1}-${phoneE164}`, phoneE164, label }
    })
}

export function AiCallCampaignWorkspace({ canEdit, actorId }: { canEdit: boolean; actorId: string | null }) {
    const [campaigns, setCampaigns] = useState<AiCallCampaignSummaryV1[]>([])
    const [nextCursor, setNextCursor] = useState<string | null>(null)
    const [scenarios, setScenarios] = useState<ScenarioOption[]>([])
    const [loading, setLoading] = useState(true)
    const [scenarioLoading, setScenarioLoading] = useState(canEdit)
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [scenarioError, setScenarioError] = useState<string | null>(null)
    const [name, setName] = useState('')
    const [scenarioId, setScenarioId] = useState('')
    const [scheduledAt, setScheduledAt] = useState('')
    const [audienceText, setAudienceText] = useState('')
    const [retainedCreate, setRetainedCreate] = useState(false)
    const createCommand = useRef<CreateAiCallCampaignCommandV1 | null>(null)

    const load = useCallback(async (cursor?: string) => {
        try {
            const campaignUrl = cursor
                ? `/api/ai-calls/campaigns?limit=50&cursor=${encodeURIComponent(cursor)}`
                : '/api/ai-calls/campaigns?limit=50'
            const campaignResponse = await fetch(campaignUrl, { cache: 'no-store' })
            if (!campaignResponse.ok) throw new Error('Не удалось загрузить кампании')
            const campaignBody = await campaignResponse.json()
            setCampaigns((current) => cursor
                ? [...current, ...(campaignBody.campaigns ?? [])]
                : campaignBody.campaigns ?? [])
            setNextCursor(campaignBody.nextCursor ?? null)
            setError(null)
        } catch (loadError) {
            setError(loadError instanceof Error ? loadError.message : 'Ошибка загрузки')
        } finally {
            if (!cursor) setLoading(false)
        }
    }, [])

    const loadScenarioOptions = useCallback(async () => {
        if (!canEdit) return
        setScenarioLoading(true)
        try {
            const response = await fetch('/api/ai-calls/campaigns/scenario-options', { cache: 'no-store' })
            const body = await response.json()
            if (!response.ok) throw new Error(body.error ?? 'Не удалось загрузить сценарии')
            const options = (body.scenarios ?? []) as ScenarioOption[]
            setScenarios(options)
            setScenarioId((current) => current || options[0]?.id || '')
            setScenarioError(null)
        } catch (loadError) {
            setScenarios([])
            if (!createCommand.current) setScenarioId('')
            setScenarioError(loadError instanceof Error ? loadError.message : 'Ошибка загрузки сценариев')
        } finally {
            setScenarioLoading(false)
        }
    }, [canEdit])

    useEffect(() => { void load() }, [load])
    useEffect(() => { void loadScenarioOptions() }, [loadScenarioOptions])
    useEffect(() => {
        if (!canEdit || !actorId) return
        try {
            const stored = window.sessionStorage.getItem(PENDING_CREATE_STORAGE_KEY)
            if (!stored) return
            const envelope = JSON.parse(stored) as Partial<PendingCreateEnvelopeV1>
            if (envelope.version !== 1 || envelope.actorId !== actorId) {
                window.sessionStorage.removeItem(PENDING_CREATE_STORAGE_KEY)
                return
            }
            const command = parseCreateAiCallCampaignCommandV1(envelope.command)
            createCommand.current = command
            setName(command.name)
            setScenarioId(command.scenarioId)
            setScheduledAt(command.scheduledAt ? command.scheduledAt.slice(0, 16) : '')
            setAudienceText(command.audience.members.map((member) => (
                `${member.label ? `${member.label}, ` : ''}${member.phoneE164}`
            )).join('\n'))
            setRetainedCreate(true)
        } catch {
            window.sessionStorage.removeItem(PENDING_CREATE_STORAGE_KEY)
        }
    }, [actorId, canEdit])
    const audience = useMemo(() => parseAudience(audienceText), [audienceText])

    async function createCampaign(event: React.FormEvent) {
        event.preventDefault()
        if (!canEdit || !actorId) return
        setSaving(true)
        setError(null)
        try {
            if (!createCommand.current) {
                const requestId = crypto.randomUUID()
                const command: CreateAiCallCampaignCommandV1 = {
                    contract: CREATE_AI_CALL_CAMPAIGN_COMMAND_V1,
                    requestId,
                    name: name.trim(),
                    scenarioId,
                    scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : null,
                    concurrentLimit: 4,
                    ratePerMinute: 30,
                    maxAttempts: 3,
                    retryBaseMs: 30_000,
                    retryMaxMs: 300_000,
                    audience: {
                        sourceRef: `manual-ui:${requestId}`,
                        sourceVersion: 'v1',
                        members: audience,
                    },
                }
                // Persist before the request. If session storage is unavailable,
                // fail closed instead of issuing a command whose identity a reload can lose.
                const envelope: PendingCreateEnvelopeV1 = { version: 1, actorId, command }
                window.sessionStorage.setItem(PENDING_CREATE_STORAGE_KEY, JSON.stringify(envelope))
                createCommand.current = command
            }
            const response = await fetch('/api/ai-calls/campaigns', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(createCommand.current),
            })
            const body = await response.json()
            if (!response.ok) throw new Error(body.error ?? 'Не удалось создать кампанию')
            createCommand.current = null
            window.sessionStorage.removeItem(PENDING_CREATE_STORAGE_KEY)
            setRetainedCreate(false)
            window.location.assign(`/calls/campaigns/${body.campaign.id}`)
        } catch (saveError) {
            setRetainedCreate(createCommand.current !== null)
            setError(saveError instanceof Error ? saveError.message : 'Ошибка создания')
            setSaving(false)
        }
    }

    function resetCreateCommand() {
        createCommand.current = null
        window.sessionStorage.removeItem(PENDING_CREATE_STORAGE_KEY)
        setRetainedCreate(false)
        setError(null)
    }

    return (
        <main className="mx-auto max-w-7xl space-y-6 p-6">
            <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                    <p className="text-sm font-medium text-blue-600">Звонки / AI-кампании</p>
                    <h1 className="text-3xl font-semibold text-slate-950">AI Calls</h1>
                    <p className="mt-1 text-sm text-slate-600">Массовые обзвоны, исходы и операционное состояние.</p>
                </div>
                <button onClick={() => { setLoading(true); void load() }} className="rounded-lg border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50">
                    Обновить
                </button>
            </div>

            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
                Запуск во внешнюю телефонию заблокирован: production-миграция не применена, провайдер,
                биллинг и лимиты расходов не подключены. Доступен только явно включённый изолированный simulation proof.
            </div>

            {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div>}

            <section className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(320px,1fr)]">
                <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
                    <div className="border-b border-slate-200 px-5 py-4">
                        <h2 className="font-semibold">Кампании</h2>
                    </div>
                    {loading ? <p className="p-5 text-sm text-slate-500">Загрузка…</p> : campaigns.length === 0 ? (
                        <p className="p-5 text-sm text-slate-500">Кампаний пока нет.</p>
                    ) : (
                        <div className="divide-y divide-slate-100">
                            {campaigns.map((campaign) => (
                                <Link key={campaign.id} href={`/calls/campaigns/${campaign.id}`} className="block p-5 hover:bg-slate-50">
                                    <div className="flex items-center justify-between gap-3">
                                        <div>
                                            <p className="font-medium text-slate-950">{campaign.name}</p>
                                            <p className="mt-1 text-xs text-slate-500">{stateLabel(campaign.state)} · {campaign.progress.completed}/{campaign.progress.total}</p>
                                            {campaign.cost.hasSimulatedResults && <span className="mt-2 inline-flex rounded bg-amber-100 px-2 py-1 text-[10px] font-semibold uppercase text-amber-900">Симуляция</span>}
                                        </div>
                                        <span className="text-sm font-semibold text-slate-700">{campaign.progress.percent}%</span>
                                    </div>
                                    <div className="mt-3 h-2 overflow-hidden rounded bg-slate-100">
                                        <div className="h-full bg-blue-600" style={{ width: `${campaign.progress.percent}%` }} />
                                    </div>
                                    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
                                        <span>Успех: {campaign.progress.succeeded}</span>
                                        <span>Ошибки: {campaign.progress.failed}</span>
                                        <span>Ожидают: {campaign.progress.pending + campaign.progress.waiting}</span>
                                        <span>Повтор: {campaign.progress.retryWait}</span>
                                        <span>Длительность: {campaign.cost.connectedDurationSec} сек.</span>
                                        {campaign.failureCode && <span className="font-medium text-red-700">Ошибка кампании: {campaign.failureCode}</span>}
                                    </div>
                                </Link>
                            ))}
                            {nextCursor && <div className="p-4 text-center"><button onClick={() => void load(nextCursor)} className="rounded-lg border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50">Показать ещё</button></div>}
                        </div>
                    )}
                </div>

                {canEdit ? <form onSubmit={createCampaign} className="space-y-4 rounded-xl border border-slate-200 bg-white p-5">
                    <div>
                        <h2 className="font-semibold">Новая кампания</h2>
                        <p className="mt-1 text-xs text-slate-500">Только явный неизменяемый список. Динамические CRM-сегменты пока не подключены.</p>
                    </div>
                    <label className="block text-sm font-medium">Название
                        <input required disabled={retainedCreate} maxLength={200} value={name} onChange={(e) => setName(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal" />
                    </label>
                    <label className="block text-sm font-medium">Сценарий
                        <select required disabled={retainedCreate || scenarioLoading} value={scenarioId} onChange={(e) => setScenarioId(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal">
                            <option value="">Выберите сценарий</option>
                            {scenarios.map((scenario) => <option key={scenario.id} value={scenario.id}>{scenario.name}</option>)}
                        </select>
                    </label>
                    {scenarioLoading && <p className="text-xs text-slate-500">Загрузка сценариев…</p>}
                    {!scenarioLoading && !scenarioError && scenarios.length === 0 && <p className="text-xs text-slate-600">Нет активных сценариев, доступных для новой кампании.</p>}
                    {scenarioError && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800">
                        <p>{scenarioError}</p>
                        <button type="button" onClick={() => void loadScenarioOptions()} className="mt-2 rounded border border-red-300 px-3 py-1 font-medium">Повторить загрузку сценариев</button>
                    </div>}
                    <label className="block text-sm font-medium">Запуск (необязательно)
                        <input disabled={retainedCreate} type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal" />
                    </label>
                    <label className="block text-sm font-medium">Аудитория: имя, +телефон
                        <textarea required disabled={retainedCreate} rows={8} value={audienceText} onChange={(e) => setAudienceText(e.target.value)} placeholder={'Анна, +79990000001\nИван, +79990000002'} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm font-normal" />
                    </label>
                    <p className="text-xs text-slate-500">Распознано участников: {audience.length}. Лимит: 10 000.</p>
                    {retainedCreate && <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950">Команда и снимок аудитории сохранены для безопасного повтора после неоднозначного ответа. Чтобы изменить данные, явно сбросьте эту попытку.</div>}
                    <button disabled={saving || audience.length === 0 || !scenarioId || (!retainedCreate && (scenarioLoading || scenarioError !== null))} className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
                        {saving ? 'Создание…' : retainedCreate ? 'Повторить безопасно' : 'Создать и запланировать'}
                    </button>
                    {retainedCreate && <button type="button" onClick={resetCreateCommand} className="w-full rounded-lg border border-slate-300 px-4 py-2 text-sm">Сбросить сохранённую попытку</button>}
                </form> : <aside className="rounded-xl border border-slate-200 bg-slate-50 p-5 text-sm text-slate-700"><h2 className="font-semibold text-slate-950">Режим просмотра</h2><p className="mt-2">Создание и управление кампаниями доступны администратору или руководителю.</p></aside>}
            </section>
        </main>
    )
}
