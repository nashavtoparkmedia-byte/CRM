import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    integrationAdminPrincipal: vi.fn(),
    create: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    control: vi.fn(),
    scenarioOptions: vi.fn(),
    log: vi.fn(),
}))

vi.mock('@/modules/identity-access/public/v1', () => ({
    getIntegrationAdminPrincipal: mocks.integrationAdminPrincipal,
}))
vi.mock('@/modules/calling/public/v1/ai-call-campaign-management-handler', () => ({
    aiCallCampaignManagementV1: {
        create: mocks.create,
        list: mocks.list,
        scenarioOptions: mocks.scenarioOptions,
        get: mocks.get,
        control: mocks.control,
    },
}))
vi.mock('@/infrastructure/operations/operational-log', () => ({ operationalLogV1: mocks.log }))

import { GET as listCampaigns, POST as createCampaign } from '@/app/api/ai-calls/campaigns/route'
import { GET as getCampaign, PATCH as controlCampaign } from '@/app/api/ai-calls/campaigns/[id]/route'
import { GET as listCampaignScenarioOptions } from '@/app/api/ai-calls/campaigns/scenario-options/route'

function request(
    path: string,
    method = 'GET',
    body?: unknown,
    headerOverrides: Record<string, string | null> = {},
) {
    const headers = new Headers({ host: 'crm.example', origin: 'https://crm.example' })
    if (body !== undefined) headers.set('content-type', 'application/json')
    for (const [name, value] of Object.entries(headerOverrides)) {
        if (value === null) headers.delete(name)
        else headers.set(name, value)
    }
    return new NextRequest(`https://crm.example${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : {
            body: JSON.stringify(body),
        }),
    })
}

beforeEach(() => {
    vi.clearAllMocks()
    mocks.integrationAdminPrincipal.mockResolvedValue(null)
    mocks.list.mockResolvedValue({ campaigns: [], nextCursor: null })
    mocks.get.mockResolvedValue({ id: 'campaign-1', state: 'running' })
    mocks.scenarioOptions.mockResolvedValue([{ id: 'scenario-1', name: 'Scenario 1' }])
})

describe('AI call campaign route authorization', () => {
    it('rejects anonymous and forged CRM identity selectors before every read owner operation', async () => {
        for (const cookie of [
            undefined,
            'crm_user_id=forged-administrator',
            'crm_user_id=disabled-user',
            'crm_user_id=manager-user',
        ]) {
            const response = await listCampaigns(request('/api/ai-calls/campaigns', 'GET', undefined, {
                cookie: cookie ?? null,
            }))
            expect(response.status).toBe(401)
        }
        expect(mocks.list).not.toHaveBeenCalled()

        const detailResponse = await getCampaign(
            request('/api/ai-calls/campaigns/campaign-1', 'GET', undefined, {
                cookie: 'crm_user_id=forged-administrator',
            }),
            { params: Promise.resolve({ id: 'campaign-1' }) },
        )
        expect(detailResponse.status).toBe(401)
        expect(mocks.get).not.toHaveBeenCalled()

        expect((await listCampaignScenarioOptions()).status).toBe(401)
        expect(mocks.scenarioOptions).not.toHaveBeenCalled()
    })

    it('serves bounded reads only for a cryptographically verified capability principal', async () => {
        mocks.integrationAdminPrincipal.mockResolvedValue({
            id: 'identity-access:integration-admin-session',
            kind: 'integration_admin_session',
        })
        expect((await listCampaigns(request('/api/ai-calls/campaigns'))).status).toBe(200)
        expect((await getCampaign(
            request('/api/ai-calls/campaigns/campaign-1'),
            { params: Promise.resolve({ id: 'campaign-1' }) },
        )).status).toBe(200)
        const response = await listCampaignScenarioOptions()
        expect(response.status).toBe(200)
        await expect(response.json()).resolves.toEqual({
            scenarios: [{ id: 'scenario-1', name: 'Scenario 1' }],
        })
        expect(mocks.scenarioOptions).toHaveBeenCalledWith()
    })

    it('rejects unsigned admin, disabled, and manager selectors before mutation parsing', async () => {
        const createResponse = await createCampaign(request(
            '/api/ai-calls/campaigns',
            'POST',
            { malformed: true },
            { cookie: 'crm_user_id=forged-administrator' },
        ))
        expect(createResponse.status).toBe(401)
        expect(mocks.create).not.toHaveBeenCalled()
        const controlResponse = await controlCampaign(
            request('/api/ai-calls/campaigns/campaign-1', 'PATCH', { malformed: true }, {
                cookie: 'crm_user_id=manager-user',
            }),
            { params: Promise.resolve({ id: 'campaign-1' }) },
        )
        expect(controlResponse.status).toBe(401)
        expect(mocks.control).not.toHaveBeenCalled()
    })

    it('passes mutations with only the verified capability principal as actor', async () => {
        mocks.integrationAdminPrincipal.mockResolvedValue({
            id: 'identity-access:integration-admin-session',
            kind: 'integration_admin_session',
        })
        mocks.create.mockResolvedValue({ id: 'campaign-1' })
        const body = { contract: 'calling.CreateAiCallCampaignCommand.v1' }
        const response = await createCampaign(request('/api/ai-calls/campaigns', 'POST', body, {
            cookie: 'crm_user_id=manager-user',
        }))
        expect(response.status).toBe(201)
        expect(mocks.create).toHaveBeenCalledWith(body, { id: 'identity-access:integration-admin-session' })

        mocks.control.mockResolvedValue({ id: 'campaign-1' })
        const controlBody = { contract: 'calling.ControlAiCallCampaignCommand.v1', action: 'pause' }
        const controlResponse = await controlCampaign(
            request('/api/ai-calls/campaigns/campaign-1', 'PATCH', controlBody, {
                cookie: 'crm_user_id=disabled-user',
            }),
            { params: Promise.resolve({ id: 'campaign-1' }) },
        )
        expect(controlResponse.status).toBe(200)
        expect(mocks.control).toHaveBeenCalledWith(
            { ...controlBody, campaignId: 'campaign-1' },
            { id: 'identity-access:integration-admin-session' },
        )
    })

    it('rejects untrusted origins and non-JSON mutation bodies before Calling', async () => {
        mocks.integrationAdminPrincipal.mockResolvedValue({
            id: 'identity-access:integration-admin-session',
            kind: 'integration_admin_session',
        })
        const createCandidates = [
            request('/api/ai-calls/campaigns', 'POST', {}, { origin: null }),
            request('/api/ai-calls/campaigns', 'POST', {}, { origin: 'https://attacker.example' }),
            request('/api/ai-calls/campaigns', 'POST', {}, { 'x-forwarded-host': 'attacker.example' }),
            request('/api/ai-calls/campaigns', 'POST', {}, { 'x-forwarded-proto': 'http' }),
        ]
        for (const candidate of createCandidates) {
            expect((await createCampaign(candidate)).status).toBe(403)
        }
        expect((await createCampaign(request('/api/ai-calls/campaigns', 'POST', {}, {
            'content-type': 'text/plain',
        }))).status).toBe(415)

        const context = { params: Promise.resolve({ id: 'campaign-1' }) }
        expect((await controlCampaign(
            request('/api/ai-calls/campaigns/campaign-1', 'PATCH', {}, { origin: null }),
            context,
        )).status).toBe(403)
        expect((await controlCampaign(
            request('/api/ai-calls/campaigns/campaign-1', 'PATCH', {}, { 'content-type': 'text/plain' }),
            context,
        )).status).toBe(415)
        expect(mocks.create).not.toHaveBeenCalled()
        expect(mocks.control).not.toHaveBeenCalled()
    })
})
