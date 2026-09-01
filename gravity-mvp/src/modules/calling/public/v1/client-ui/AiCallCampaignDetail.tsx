'use client'

import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
    CONTROL_AI_CALL_CAMPAIGN_COMMAND_V1,
    type AiCallCampaignDetailV1,
} from '@/contracts/calling/v1'

export function AiCallCampaignDetail({ campaignId, canEdit }: { campaignId: string; canEdit: boolean }) {
    const [campaign, setCampaign] = useState<AiCallCampaignDetailV1 | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [mutating, setMutating] = useState(false)
    const [nextMemberCursor, setNextMemberCursor] = useState<string | null>(null)
    const loadedMore = useRef(false)

    const load = useCallback(async (cursor?: string, replace = false) => {
        try {
            const query = new URLSearchParams({ memberLimit: '200' })
            if (cursor) query.set('memberCursor', cursor)
            const response = await fetch(`/api/ai-calls/campaigns/${encodeURIComponent(campaignId)}?${query}`, { cache: 'no-store' })
            const body = await response.json()
            if (!response.ok) throw new Error(body.error ?? 'Не удалось загрузить кампанию')
            setCampaign((current) => {
                if (replace) return body.campaign
                if (!cursor) {
                    if (!current || current.members.length <= body.campaign.members.length) return body.campaign
                    const freshIds = new Set(body.campaign.members.map((member: { id: string }) => member.id))
                    return {
                        ...body.campaign,
                        members: [
                            ...body.campaign.members,
                            ...current.members.filter((member) => !freshIds.has(member.id)),
                        ],
                    }
                }
                const existing = new Set((current?.members ?? []).map((member) => member.id))
                return {
                    ...body.campaign,
                    members: [
                        ...(current?.members ?? []),
                        ...body.campaign.members.filter((member: { id: string }) => !existing.has(member.id)),
                    ],
                }
            })
            if (replace) {
                loadedMore.current = false
                setNextMemberCursor(body.campaign.nextMemberCursor ?? null)
            } else if (cursor) {
                loadedMore.current = true
                setNextMemberCursor(body.campaign.nextMemberCursor ?? null)
            } else if (!loadedMore.current) {
                setNextMemberCursor(body.campaign.nextMemberCursor ?? null)
            }
            setError(null)
        } catch (loadError) {
            setError(loadError instanceof Error ? loadError.message : 'Ошибка загрузки')
        }
    }, [campaignId])

    useEffect(() => {
        void load()
        const timer = setInterval(() => void load(), 4_000)
        return () => clearInterval(timer)
    }, [load])

    async function control(action: 'pause' | 'resume' | 'cancel') {
        setMutating(true)
        try {
            const response = await fetch(`/api/ai-calls/campaigns/${encodeURIComponent(campaignId)}`, {
                method: 'PATCH', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    contract: CONTROL_AI_CALL_CAMPAIGN_COMMAND_V1,
                    requestId: crypto.randomUUID(), campaignId, action,
                }),
            })
            const body = await response.json()
            if (!response.ok) throw new Error(body.error ?? 'Команда не выполнена')
            await load(undefined, true)
        } catch (controlError) {
            setError(controlError instanceof Error ? controlError.message : 'Ошибка команды')
        } finally {
            setMutating(false)
        }
    }

    if (!campaign) return <main className="p-6"><Link href="/calls/campaigns" className="text-sm text-blue-600">← Кампании</Link><p className="mt-4 text-sm">{error ?? 'Загрузка…'}</p></main>
    const p = campaign.progress
    return (
        <main className="mx-auto max-w-7xl space-y-6 p-6">
            <Link href="/calls/campaigns" className="text-sm font-medium text-blue-600">← AI-кампании</Link>
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div><h1 className="text-3xl font-semibold">{campaign.name}</h1><p className="mt-1 text-sm text-slate-600">{campaign.state} · сценарий {campaign.scenarioId} · frozen {campaign.scenarioFingerprint.slice(0, 12)}</p></div>
                {canEdit ? <div className="flex gap-2">
                    {campaign.state === 'running' && <button disabled={mutating} onClick={() => void control('pause')} className="rounded-lg border px-4 py-2 text-sm">Пауза</button>}
                    {campaign.state === 'paused' && <button disabled={mutating} onClick={() => void control('resume')} className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white">Продолжить</button>}
                    {!['completed', 'cancelled', 'failed'].includes(campaign.state) && <button disabled={mutating} onClick={() => void control('cancel')} className="rounded-lg border border-red-300 px-4 py-2 text-sm text-red-700">Отменить</button>}
                </div> : <p className="rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-700">Режим просмотра: управление доступно администратору или руководителю.</p>}
            </div>
            {(error || campaign.failureCode) && <div role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{error ?? `Ошибка кампании: ${campaign.failureCode}`}</div>}
            {campaign.cost.hasSimulatedResults && <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm font-medium text-amber-950">Контролируемая симуляция: {campaign.cost.simulatedCalls} звонков. Провайдер и тарификация не использовались.</div>}

            <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
                {[
                    ['Прогресс', `${p.completed}/${p.total} · ${p.percent}%`], ['Успешно', p.succeeded],
                    ['Ожидают', p.pending + p.waiting], ['Повтор', p.retryWait], ['Ошибки', p.failed], ['В работе', p.running + p.claimed],
                ].map(([label, value]) => <div key={String(label)} className="rounded-xl border bg-white p-4"><p className="text-xs text-slate-500">{label}</p><p className="mt-1 text-xl font-semibold">{value}</p></div>)}
            </section>

            <section className="grid gap-4 lg:grid-cols-3">
                <div className="rounded-xl border bg-white p-4"><h2 className="font-semibold">Операции</h2><dl className="mt-3 space-y-2 text-sm"><div className="flex justify-between"><dt>Режим</dt><dd>{campaign.operations.runtimeMode}</dd></div><div className="flex justify-between"><dt>Активные leases</dt><dd>{campaign.operations.activeLeases}</dd></div><div className="flex justify-between"><dt>Просроченные claims</dt><dd>{campaign.operations.staleClaims}</dd></div><div className="flex justify-between"><dt>Связанные активные звонки</dt><dd>{campaign.operations.unfinalizedLinkedCalls}</dd></div><div className="flex justify-between"><dt>Последняя активность</dt><dd>{new Date(campaign.operations.lastActivityAt).toLocaleString()}</dd></div></dl></div>
                <div className="rounded-xl border bg-white p-4"><h2 className="font-semibold">Стоимость</h2><p className="mt-3 text-2xl font-semibold">—</p><p className="mt-1 text-xs text-slate-500">Тарифы и счета провайдера не загружены. CRM видит {campaign.cost.connectedDurationSec} сек. в {campaign.cost.completedCalls} завершённых звонках; симулировано: {campaign.cost.simulatedCalls}.</p></div>
                <div className="rounded-xl border bg-white p-4"><h2 className="font-semibold">Аудитория</h2><p className="mt-3 text-sm">{campaign.audience.sourceKind}</p><p className="mt-1 break-all text-xs text-slate-500">{campaign.audience.sourceRef} · {campaign.audience.sourceVersion}</p></div>
            </section>

            {campaign.operations.staleUnfinalizedCalls.length > 0 && <section role="alert" className="rounded-xl border border-red-300 bg-red-50 p-5 text-red-950">
                <h2 className="font-semibold">Требуют восстановления</h2>
                <p className="mt-1 text-sm">Эти связанные звонки не завершили финализацию. Runtime повторно согласует уже принятый dispatch без нового звонка; терминальные сироты требуют операторского расследования.</p>
                <div className="mt-3 space-y-2">{campaign.operations.staleUnfinalizedCalls.map((call) => <div key={call.attemptId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-200 bg-white p-3 text-sm">
                    <Link href={`/calls/${call.callId}`} className="font-medium text-blue-700">{call.label ?? call.targetRef}</Link>
                    <span>{call.sessionStatus ?? 'статус неизвестен'} · {call.recoveryReason === 'terminal_link_orphan'
                        ? `терминальная попытка ${call.attemptState}${call.failureCode ? ` · ${call.failureCode}` : ''}`
                        : `claim истёк ${call.claimUntil ? new Date(call.claimUntil).toLocaleString() : 'в неизвестное время'}`}</span>
                </div>)}</div>
            </section>}

            <section className="overflow-hidden rounded-xl border bg-white">
                <div className="border-b px-5 py-4"><h2 className="font-semibold">Участники, попытки и исходы</h2></div>
                <div className="divide-y">
                    {campaign.members.map((member) => <div key={member.id} className="p-5">
                        <div className="flex flex-wrap justify-between gap-2"><div><p className="font-medium">{member.label ?? member.targetRef}</p><p className="text-xs text-slate-500">{member.phoneE164} · {member.state}</p></div><p className="text-sm">{member.outcomeCode ?? member.failureCode ?? '—'}</p></div>
                        <div className="mt-3 space-y-3">{member.attempts.map((attempt) => <div key={attempt.id} className="rounded-lg bg-slate-50 p-3 text-sm">
                            <div className="flex flex-wrap justify-between gap-2"><span>Попытка {attempt.attemptNumber} · {attempt.state} · dispatch {attempt.dispatchState}</span><span className="text-xs text-slate-500">{attempt.failureCode ?? attempt.dispatchReceiptRef ?? attempt.logicalEffectRef ?? ''}</span></div>
                            {attempt.call && <div className="mt-2 border-t pt-2"><div className="flex flex-wrap gap-3 text-xs"><Link href={`/calls/${attempt.call.id}`} className="text-blue-600">Звонок {attempt.call.id}</Link><span>{attempt.call.durationSec ?? 0} сек.</span><span>{attempt.call.outcome ?? attempt.call.sessionStatus}</span><span>follow-up: {attempt.call.followUpState ?? '—'}</span></div>{attempt.call.summary && <p className="mt-2">{attempt.call.summary}</p>}{attempt.call.transcript && <pre className="mt-2 whitespace-pre-wrap rounded bg-white p-2 text-xs">{attempt.call.transcript}</pre>}</div>}
                        </div>)}</div>
                    </div>)}
                </div>
                {nextMemberCursor && <div className="border-t p-4 text-center"><button onClick={() => void load(nextMemberCursor)} className="rounded-lg border px-4 py-2 text-sm">Показать ещё участников</button></div>}
            </section>

            <section className="rounded-xl border bg-white p-5"><h2 className="font-semibold">Последние исходы</h2><div className="mt-3 space-y-2">{campaign.recentOutcomes.length === 0 ? <p className="text-sm text-slate-500">Завершённых попыток пока нет.</p> : campaign.recentOutcomes.map((outcome) => <div key={outcome.attemptId} className="flex flex-wrap justify-between gap-3 border-b pb-2 text-sm"><span>{outcome.label ?? outcome.targetRef} · попытка {outcome.attemptNumber}</span><span>{outcome.state} · {outcome.failureCode ?? outcome.callOutcome ?? 'без кода'}</span></div>)}</div></section>

            <section className="rounded-xl border bg-white p-5"><h2 className="font-semibold">Журнал действий</h2><div className="mt-3 space-y-3">{campaign.audit.map((event) => <div key={event.id} className="flex flex-wrap justify-between gap-3 border-b pb-3 text-sm"><span>{event.action} · {event.actorId}</span><time className="text-xs text-slate-500">{new Date(event.createdAt).toLocaleString()}</time></div>)}</div></section>
        </main>
    )
}
