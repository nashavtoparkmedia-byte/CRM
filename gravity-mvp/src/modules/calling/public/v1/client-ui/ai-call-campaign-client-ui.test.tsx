// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiCallCampaignDetailV1 } from '@/contracts/calling/v1'
import { AiCallCampaignDetail } from './AiCallCampaignDetail'
import { AiCallCampaignWorkspace } from './AiCallCampaignWorkspace'

function response(body: unknown, ok = true) {
    return { ok, json: async () => body } as Response
}

const progress = {
    total: 2,
    pending: 1,
    waiting: 0,
    claimed: 0,
    running: 0,
    retryWait: 0,
    succeeded: 1,
    failed: 0,
    excluded: 0,
    cancelled: 0,
    completed: 1,
    percent: 50,
}

function summary(id: string, name: string) {
    return {
        id,
        name,
        scenarioId: 'scenario-1',
        scenarioFingerprint: 'a'.repeat(64),
        state: 'running',
        scheduledAt: null,
        startedAt: '2026-09-01T00:00:00.000Z',
        completedAt: null,
        cancelledAt: null,
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:01:00.000Z',
        concurrentLimit: 2,
        ratePerMinute: 30,
        maxAttempts: 3,
        retryBaseMs: 1_000,
        retryMaxMs: 8_000,
        failureCode: null,
        progress,
        cost: {
            status: 'provider_billing_not_ingested',
            currency: null,
            amount: null,
            completedCalls: 1,
            connectedDurationSec: 15,
            simulatedCalls: 1,
            hasSimulatedResults: true,
            basis: 'crm_answered_interval_only',
        },
    } as const
}

function member(id: string, label: string) {
    return {
        id,
        targetRef: id,
        phoneE164: '+79990000001',
        label,
        state: 'succeeded',
        excludedReason: null,
        attemptCount: 1,
        nextEligibleAt: null,
        outcomeCode: 'qualified',
        failureCode: null,
        updatedAt: '2026-09-01T00:01:00.000Z',
        attempts: [{
            id: `${id}-attempt`,
            attemptNumber: 1,
            launchId: `${id}-launch`,
            state: 'succeeded',
            claimRevision: 1,
            dispatchState: 'accepted' as const,
            dispatchReceiptRef: `${id}-effect`,
            logicalEffectRef: `${id}-effect`,
            failureCode: null,
            startedAt: '2026-09-01T00:00:00.000Z',
            completedAt: '2026-09-01T00:01:00.000Z',
            call: null,
        }],
    }
}

function detail(
    members: ReturnType<typeof member>[],
    nextMemberCursor: string | null,
    state = 'running',
): AiCallCampaignDetailV1 {
    return {
        ...summary('campaign-1', 'Campaign one'),
        state,
        members,
        nextMemberCursor,
        recentOutcomes: members.flatMap((entry) => entry.attempts.map((attempt) => ({
            attemptId: attempt.id,
            memberId: entry.id,
            targetRef: entry.targetRef,
            phoneE164: entry.phoneE164,
            label: entry.label,
            attemptNumber: attempt.attemptNumber,
            state: attempt.state,
            failureCode: attempt.failureCode,
            completedAt: attempt.completedAt!,
            callOutcome: null,
            callOutcomeReason: null,
        }))),
        audience: {
            sourceKind: 'explicit_external_snapshot',
            sourceRef: 'manual',
            sourceVersion: 'v1',
            frozenAt: '2026-09-01T00:00:00.000Z',
        },
        audit: [{
            id: 'audit-1', action: 'attempt_succeeded', actorId: 'system', details: {},
            createdAt: '2026-09-01T00:01:00.000Z',
        }],
        operations: {
            activeLeases: 0,
            staleClaims: 0,
            unfinalizedLinkedCalls: 0,
            staleUnfinalizedCalls: [],
            retryWaitMembers: 0,
            permanentFailures: 0,
            lastActivityAt: '2026-09-01T00:01:00.000Z',
            runtimeMode: 'simulated',
            simulatedCalls: 1,
            hasSimulatedResults: true,
        },
    }
}

afterEach(() => {
    cleanup()
    window.sessionStorage.clear()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

describe('AI call campaign CRM workspace', () => {
    it('renders real list state, simulation visibility, pagination, and bounded create errors', async () => {
        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input)
            if (url.endsWith('/scenario-options')) {
                return response({ scenarios: [{ id: 'scenario-1', name: 'Scenario one' }] })
            }
            if (init?.method === 'POST') return response({ error: 'Создание запрещено' }, false)
            if (url.includes('cursor=next-page')) {
                return response({ campaigns: [summary('campaign-2', 'Campaign two')], nextCursor: null })
            }
            return response({ campaigns: [summary('campaign-1', 'Campaign one')], nextCursor: 'next-page' })
        })
        vi.stubGlobal('fetch', fetchMock)
        vi.stubGlobal('crypto', { randomUUID: () => 'request-1' })

        render(<AiCallCampaignWorkspace canEdit actorId="admin-1" />)
        expect(await screen.findByText('Campaign one')).toBeTruthy()
        expect(screen.getByText('Симуляция')).toBeTruthy()
        expect(screen.getByText('Ожидают: 1')).toBeTruthy()

        fireEvent.click(screen.getByRole('button', { name: 'Показать ещё' }))
        expect(await screen.findByText('Campaign two')).toBeTruthy()

        fireEvent.change(screen.getByLabelText(/Название/), { target: { value: 'New campaign' } })
        fireEvent.change(screen.getByLabelText(/Аудитория/), { target: { value: 'Lead, +79990000002' } })
        fireEvent.click(screen.getByRole('button', { name: 'Создать и запланировать' }))
        expect(await screen.findByText('Создание запрещено')).toBeTruthy()
        expect(fetchMock).toHaveBeenCalledWith('/api/ai-calls/campaigns', expect.objectContaining({ method: 'POST' }))
    })

    it('retains one immutable create identity across an ambiguous retry', async () => {
        const postBodies: string[] = []
        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input)
            if (url.endsWith('/scenario-options')) {
                return response({ scenarios: [{ id: 'scenario-1', name: 'Scenario one' }] })
            }
            if (init?.method === 'POST') {
                postBodies.push(String(init.body))
                if (postBodies.length === 1) throw new Error('Ответ сервера потерян')
                return response({ error: 'Статус первой попытки неизвестен' }, false)
            }
            return response({ campaigns: [], nextCursor: null })
        })
        vi.stubGlobal('fetch', fetchMock)
        vi.stubGlobal('crypto', { randomUUID: () => 'stable-create-request' })

        render(<AiCallCampaignWorkspace canEdit actorId="admin-1" />)
        await screen.findByText('Кампаний пока нет.')
        fireEvent.change(screen.getByLabelText(/Название/), { target: { value: 'Stable campaign' } })
        fireEvent.change(screen.getByLabelText(/Аудитория/), { target: { value: 'Lead, +79990000002' } })
        fireEvent.click(screen.getByRole('button', { name: 'Создать и запланировать' }))
        expect(await screen.findByText('Ответ сервера потерян')).toBeTruthy()
        fireEvent.click(screen.getByRole('button', { name: 'Повторить безопасно' }))
        expect(await screen.findByText('Статус первой попытки неизвестен')).toBeTruthy()
        expect(postBodies).toHaveLength(2)
        expect(postBodies[1]).toBe(postBodies[0])
        expect(JSON.parse(postBodies[0])).toMatchObject({
            requestId: 'stable-create-request',
            audience: { sourceRef: 'manual-ui:stable-create-request' },
        })
        fireEvent.click(screen.getByRole('button', { name: 'Сбросить сохранённую попытку' }))
        expect(screen.getByRole('button', { name: 'Создать и запланировать' })).toBeTruthy()
    })

    it('restores the exact pending create command after a response-loss reload', async () => {
        const postBodies: string[] = []
        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input)
            if (url.endsWith('/scenario-options')) {
                return response({ scenarios: [{ id: 'scenario-1', name: 'Scenario one' }] })
            }
            if (init?.method === 'POST') {
                postBodies.push(String(init.body))
                throw new Error(postBodies.length === 1 ? 'Ответ потерян до reload' : 'Повтор пока неоднозначен')
            }
            return response({ campaigns: [], nextCursor: null })
        })
        vi.stubGlobal('fetch', fetchMock)
        vi.stubGlobal('crypto', { randomUUID: () => 'reload-stable-request' })

        const firstMount = render(<AiCallCampaignWorkspace canEdit actorId="admin-1" />)
        await screen.findByText('Кампаний пока нет.')
        fireEvent.change(screen.getByLabelText(/Название/), { target: { value: 'Reload-safe campaign' } })
        fireEvent.change(screen.getByLabelText(/Аудитория/), { target: { value: 'Lead, +79990000002' } })
        fireEvent.click(screen.getByRole('button', { name: 'Создать и запланировать' }))
        expect(await screen.findByText('Ответ потерян до reload')).toBeTruthy()
        firstMount.unmount()

        render(<AiCallCampaignWorkspace canEdit actorId="admin-1" />)
        expect(await screen.findByRole('button', { name: 'Повторить безопасно' })).toBeTruthy()
        expect((screen.getByLabelText(/Название/) as HTMLInputElement).value).toBe('Reload-safe campaign')
        fireEvent.click(screen.getByRole('button', { name: 'Повторить безопасно' }))
        expect(await screen.findByText('Повтор пока неоднозначен')).toBeTruthy()
        expect(postBodies).toHaveLength(2)
        expect(postBodies[1]).toBe(postBodies[0])
        expect(JSON.parse(postBodies[1])).toMatchObject({
            requestId: 'reload-stable-request',
            audience: { sourceRef: 'manual-ui:reload-stable-request' },
        })
    })

    it('keeps managers read-only and does not fetch write-support scenario options', async () => {
        const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
            response({ campaigns: [], nextCursor: null })
        ))
        vi.stubGlobal('fetch', fetchMock)
        render(<AiCallCampaignWorkspace canEdit={false} actorId="manager-1" />)
        expect(await screen.findByText('Режим просмотра')).toBeTruthy()
        expect(screen.queryByText('Новая кампания')).toBeNull()
        expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/scenario-options'))).toBe(false)
    })

    it('deletes another actor pending command without rendering or submitting it', async () => {
        window.sessionStorage.setItem('yoko.ai-calls.pending-create.v1', JSON.stringify({
            version: 1,
            actorId: 'former-admin',
            command: {
                contract: 'calling.CreateAiCallCampaignCommand.v1',
                requestId: 'former-request',
                name: 'Former actor campaign',
                scenarioId: 'scenario-1',
                scheduledAt: null,
                concurrentLimit: 4,
                ratePerMinute: 30,
                maxAttempts: 3,
                retryBaseMs: 30_000,
                retryMaxMs: 300_000,
                audience: {
                    sourceRef: 'manual-ui:former-request',
                    sourceVersion: 'v1',
                    members: [{ targetRef: 'former-lead', phoneE164: '+79990000009', label: 'Former lead' }],
                },
            },
        }))
        const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
            if (String(input).endsWith('/scenario-options')) {
                return response({ scenarios: [{ id: 'scenario-1', name: 'Scenario one' }] })
            }
            return response({ campaigns: [], nextCursor: null })
        })
        vi.stubGlobal('fetch', fetchMock)
        render(<AiCallCampaignWorkspace canEdit actorId="current-admin" />)
        await screen.findByText('Кампаний пока нет.')
        expect((screen.getByLabelText(/Название/) as HTMLInputElement).value).toBe('')
        expect(screen.queryByText('Former actor campaign')).toBeNull()
        expect(screen.queryByText('Former lead')).toBeNull()
        expect(window.sessionStorage.getItem('yoko.ai-calls.pending-create.v1')).toBeNull()
        expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
    })

    it('fails closed with an actionable scenario-options retry before creating', async () => {
        let scenarioRequests = 0
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            if (String(input).endsWith('/scenario-options')) {
                scenarioRequests += 1
                return scenarioRequests === 1
                    ? response({ error: 'Сценарии временно недоступны' }, false)
                    : response({ scenarios: [{ id: 'scenario-1', name: 'Scenario one' }] })
            }
            return response({ campaigns: [], nextCursor: null })
        })
        vi.stubGlobal('fetch', fetchMock)

        render(<AiCallCampaignWorkspace canEdit actorId="admin-1" />)
        expect(await screen.findByText('Сценарии временно недоступны')).toBeTruthy()
        fireEvent.change(screen.getByLabelText(/Название/), { target: { value: 'Recovered scenario campaign' } })
        fireEvent.change(screen.getByLabelText(/Аудитория/), { target: { value: 'Lead, +79990000002' } })
        expect((screen.getByRole('button', { name: 'Создать и запланировать' }) as HTMLButtonElement).disabled).toBe(true)

        fireEvent.click(screen.getByRole('button', { name: 'Повторить загрузку сценариев' }))
        await waitFor(() => expect(screen.queryByText('Сценарии временно недоступны')).toBeNull())
        expect((screen.getByRole('button', { name: 'Создать и запланировать' }) as HTMLButtonElement).disabled).toBe(false)
        expect(scenarioRequests).toBe(2)
    })
})

describe('AI call campaign CRM detail', () => {
    it('shows progress, recent outcomes and simulation while preserving paged members and controls', async () => {
        let paused = false
        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input)
            if (init?.method === 'PATCH') {
                paused = true
                return response({ campaign: detail([member('ignored-control-page', 'Ignored')], 'stale-cursor', 'paused') })
            }
            if (url.includes('memberCursor=fresh-cursor')) {
                return response({ campaign: detail([member('member-2', 'Lead two')], null, 'paused') })
            }
            return response({ campaign: detail(
                [member('member-1', 'Lead one')],
                paused ? 'fresh-cursor' : 'stale-cursor',
                paused ? 'paused' : 'running',
            ) })
        })
        vi.stubGlobal('fetch', fetchMock)
        vi.stubGlobal('crypto', { randomUUID: () => 'control-1' })

        render(<AiCallCampaignDetail campaignId="campaign-1" canEdit />)
        expect(await screen.findByText('Campaign one')).toBeTruthy()
        expect(screen.getByText(/Контролируемая симуляция/)).toBeTruthy()
        expect(screen.getByText('Ожидают')).toBeTruthy()
        expect(screen.getByText('Последние исходы')).toBeTruthy()
        expect(screen.getByText(/Lead one · попытка 1/)).toBeTruthy()
        expect(screen.getByText('Связанные активные звонки')).toBeTruthy()
        expect(screen.queryByText('Требуют восстановления')).toBeNull()

        fireEvent.click(screen.getByRole('button', { name: 'Пауза' }))
        await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
            '/api/ai-calls/campaigns/campaign-1',
            expect.objectContaining({ method: 'PATCH' }),
        ))
        expect(await screen.findByRole('button', { name: 'Продолжить' })).toBeTruthy()
        fireEvent.click(screen.getByRole('button', { name: 'Показать ещё участников' }))
        expect(await screen.findByText('Lead two')).toBeTruthy()
        expect(fetchMock.mock.calls.some(([input]) => String(input).includes('memberCursor=fresh-cursor'))).toBe(true)
        expect(fetchMock.mock.calls.some(([input]) => String(input).includes('memberCursor=stale-cursor'))).toBe(false)
    })

    it('renders globally projected recent outcomes and hides controls for read-only managers', async () => {
        const campaign = detail([member('member-loaded', 'Loaded member')], null)
        campaign.recentOutcomes = [{
            attemptId: 'global-latest-attempt',
            memberId: 'member-after-first-page',
            targetRef: 'later-page-target',
            phoneE164: '+79990000999',
            label: 'Globally latest lead',
            attemptNumber: 2,
            state: 'succeeded',
            failureCode: null,
            completedAt: '2026-09-01T00:05:00.000Z',
            callOutcome: 'qualified',
            callOutcomeReason: 'completed',
        }]
        vi.stubGlobal('fetch', vi.fn(async () => response({ campaign })))
        render(<AiCallCampaignDetail campaignId="campaign-1" canEdit={false} />)
        expect(await screen.findByText(/Globally latest lead · попытка 2/)).toBeTruthy()
        expect(screen.getByText(/Режим просмотра: управление/)).toBeTruthy()
        expect(screen.queryByRole('button', { name: 'Пауза' })).toBeNull()
        expect(screen.queryByRole('button', { name: 'Отменить' })).toBeNull()
    })

    it('distinguishes an expired linked Call from ordinary active execution', async () => {
        const campaign = detail([member('member-stale', 'Stale member')], null)
        campaign.operations.unfinalizedLinkedCalls = 1
        campaign.operations.staleClaims = 1
        campaign.operations.staleUnfinalizedCalls = [{
            attemptId: 'attempt-stale',
            memberId: 'member-stale',
            callId: 'call-stale',
            targetRef: 'lead-stale',
            label: 'Lead requiring recovery',
            sessionStatus: 'active',
            startedAt: '2026-09-01T00:00:00.000Z',
            attemptState: 'running',
            failureCode: 'dial_reconciliation_error',
            recoveryReason: 'expired_claim',
            claimUntil: '2026-09-01T00:00:05.000Z',
        }]
        vi.stubGlobal('fetch', vi.fn(async () => response({ campaign })))

        render(<AiCallCampaignDetail campaignId="campaign-1" canEdit={false} />)
        expect(await screen.findByText('Требуют восстановления')).toBeTruthy()
        expect(screen.getByRole('link', { name: 'Lead requiring recovery' }).getAttribute('href')).toBe('/calls/call-stale')
        expect(screen.getByText(/claim истёк/)).toBeTruthy()
    })

    it('surfaces a defensive terminal linked-Call orphan as an operator incident', async () => {
        const campaign = detail([member('member-orphan', 'Orphan member')], null)
        campaign.operations.unfinalizedLinkedCalls = 1
        campaign.operations.staleUnfinalizedCalls = [{
            attemptId: 'attempt-orphan',
            memberId: 'member-orphan',
            callId: 'call-orphan',
            targetRef: 'lead-orphan',
            label: 'Terminal orphan',
            sessionStatus: 'active',
            startedAt: '2026-09-01T00:00:00.000Z',
            attemptState: 'permanent_failure',
            failureCode: 'legacy_terminal_error',
            recoveryReason: 'terminal_link_orphan',
            claimUntil: null,
        }]
        vi.stubGlobal('fetch', vi.fn(async () => response({ campaign })))

        render(<AiCallCampaignDetail campaignId="campaign-1" canEdit={false} />)
        expect(await screen.findByText('Требуют восстановления')).toBeTruthy()
        expect(screen.getByText(/терминальная попытка permanent_failure/)).toBeTruthy()
        expect(screen.getByText(/legacy_terminal_error/)).toBeTruthy()
    })
})
