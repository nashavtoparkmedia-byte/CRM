'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
    CREATE_AI_CALL_CAMPAIGN_COMMAND_V1,
    type AiCallCampaignSummaryV1,
} from '@/contracts/calling/v1'

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

export function AiCallCampaignWorkspace() {
    const [campaigns, setCampaigns] = useState<AiCallCampaignSummaryV1[]>([])
    const [scenarios, setScenarios] = useState<ScenarioOption[]>([])
    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [name, setName] = useState('')
    const [scenarioId, setScenarioId] = useState('')
    const [scheduledAt, setScheduledAt] = useState('')
    const [audienceText, setAudienceText] = useState('')

    const load = useCallback(async () => {
        try {
            const [campaignResponse, scenarioResponse] = await Promise.all([
                fetch('/api/ai-calls/campaigns?limit=50', { cache: 'no-store' }),
                fetch('/api/settings/ai-call-scenarios', { cache: 'no-store' }),
            ])
            if (!campaignResponse.ok) throw new Error('Не удалось загрузить кампании')
            const campaignBody = await campaignResponse.json()
            setCampaigns(campaignBody.campaigns ?? [])
            if (scenarioResponse.ok) {
                const scenarioBody = await scenarioResponse.json()
                const options = (scenarioBody.scenarios ?? []) as ScenarioOption[]
                setScenarios(options)
                setScenarioId((current) => current || options[0]?.id || '')
            }
            setError(null)
        } catch (loadError) {
            setError(loadError instanceof Error ? loadError.message : 'Ошибка загрузки')
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => { void load() }, [load])
    const audience = useMemo(() => parseAudience(audienceText), [audienceText])

    async function createCampaign(event: React.FormEvent) {
        event.preventDefault()
        setSaving(true)
        setError(null)
        try {
            const response = await fetch('/api/ai-calls/campaigns', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    contract: CREATE_AI_CALL_CAMPAIGN_COMMAND_V1,
                    requestId: crypto.randomUUID(),
                    name: name.trim(),
                    scenarioId,
                    scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : null,
                    concurrentLimit: 4,
                    ratePerMinute: 30,
                    maxAttempts: 3,
                    retryBaseMs: 30_000,
                    retryMaxMs: 300_000,
                    audience: {
                        sourceRef: `manual-ui:${new Date().toISOString()}`,
                        sourceVersion: 'v1',
                        members: audience,
                    },
                }),
            })
            const body = await response.json()
            if (!response.ok) throw new Error(body.error ?? 'Не удалось создать кампанию')
            window.location.assign(`/calls/campaigns/${body.campaign.id}`)
        } catch (saveError) {
            setError(saveError instanceof Error ? saveError.message : 'Ошибка создания')
            setSaving(false)
        }
    }

    return (
        <main className="mx-auto max-w-7xl space-y-6 p-6">
            <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                    <p className="text-sm font-medium text-blue-600">Звонки / AI-кампании</p>
                    <h1 className="text-3xl font-semibold text-slate-950">AI Calls</h1>
                    <p className="mt-1 text-sm text-slate-600">Массовые обзвоны, исходы и операционное состояние.</p>
                </div>
                <button onClick={() => void load()} className="rounded-lg border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50">
                    Обновить
                </button>
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
                                        </div>
                                        <span className="text-sm font-semibold text-slate-700">{campaign.progress.percent}%</span>
                                    </div>
                                    <div className="mt-3 h-2 overflow-hidden rounded bg-slate-100">
                                        <div className="h-full bg-blue-600" style={{ width: `${campaign.progress.percent}%` }} />
                                    </div>
                                    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
                                        <span>Успех: {campaign.progress.succeeded}</span>
                                        <span>Ошибки: {campaign.progress.failed}</span>
                                        <span>Повтор: {campaign.progress.retryWait}</span>
                                        <span>Длительность: {campaign.cost.connectedDurationSec} сек.</span>
                                    </div>
                                </Link>
                            ))}
                        </div>
                    )}
                </div>

                <form onSubmit={createCampaign} className="space-y-4 rounded-xl border border-slate-200 bg-white p-5">
                    <div>
                        <h2 className="font-semibold">Новая кампания</h2>
                        <p className="mt-1 text-xs text-slate-500">Только явный неизменяемый список. Динамические CRM-сегменты пока не подключены.</p>
                    </div>
                    <label className="block text-sm font-medium">Название
                        <input required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal" />
                    </label>
                    <label className="block text-sm font-medium">Сценарий
                        <select required value={scenarioId} onChange={(e) => setScenarioId(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal">
                            <option value="">Выберите сценарий</option>
                            {scenarios.map((scenario) => <option key={scenario.id} value={scenario.id}>{scenario.name}</option>)}
                        </select>
                    </label>
                    <label className="block text-sm font-medium">Запуск (необязательно)
                        <input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal" />
                    </label>
                    <label className="block text-sm font-medium">Аудитория: имя, +телефон
                        <textarea required rows={8} value={audienceText} onChange={(e) => setAudienceText(e.target.value)} placeholder={'Анна, +79990000001\nИван, +79990000002'} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm font-normal" />
                    </label>
                    <p className="text-xs text-slate-500">Распознано участников: {audience.length}. Лимит: 10 000.</p>
                    <button disabled={saving || audience.length === 0 || !scenarioId} className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
                        {saving ? 'Создание…' : 'Создать и запланировать'}
                    </button>
                </form>
            </section>
        </main>
    )
}
