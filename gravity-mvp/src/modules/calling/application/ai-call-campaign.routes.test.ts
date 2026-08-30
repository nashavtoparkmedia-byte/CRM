import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    currentUser: vi.fn(),
    create: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    control: vi.fn(),
    log: vi.fn(),
}))

vi.mock('@/modules/identity-access/public/v1/user-directory', () => ({
    getCurrentUserIdentityV1: mocks.currentUser,
}))
vi.mock('@/modules/calling/public/v1/ai-call-campaign-management-handler', () => ({
    aiCallCampaignManagementV1: {
        create: mocks.create,
        list: mocks.list,
        get: mocks.get,
        control: mocks.control,
    },
}))
vi.mock('@/infrastructure/operations/operational-log', () => ({ operationalLogV1: mocks.log }))

import { GET as listCampaigns, POST as createCampaign } from '@/app/api/ai-calls/campaigns/route'
import { PATCH as controlCampaign } from '@/app/api/ai-calls/campaigns/[id]/route'

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
    mocks.list.mockResolvedValue({ campaigns: [], nextCursor: null })
})

describe('AI call campaign route authorization', () => {
    it('requires a session before reading and does not invoke the owner', async () => {
        mocks.currentUser.mockResolvedValue(null)
        const response = await listCampaigns(request('/api/ai-calls/campaigns'))
        expect(response.status).toBe(401)
        expect(mocks.list).not.toHaveBeenCalled()
    })

    it('allows authenticated reads but denies manager mutations before parsing', async () => {
        mocks.currentUser.mockResolvedValue({ id: 'manager-1', role: 'Менеджер' })
        expect((await listCampaigns(request('/api/ai-calls/campaigns'))).status).toBe(200)
        const createResponse = await createCampaign(request('/api/ai-calls/campaigns', 'POST', { malformed: true }))
        expect(createResponse.status).toBe(403)
        expect(mocks.create).not.toHaveBeenCalled()
        const controlResponse = await controlCampaign(
            request('/api/ai-calls/campaigns/campaign-1', 'PATCH', { malformed: true }),
            { params: Promise.resolve({ id: 'campaign-1' }) },
        )
        expect(controlResponse.status).toBe(403)
        expect(mocks.control).not.toHaveBeenCalled()
    })

    it('passes supervisor mutations to the Calling owner with trusted actor context', async () => {
        mocks.currentUser.mockResolvedValue({ id: 'supervisor-1', role: 'Руководитель' })
        mocks.create.mockResolvedValue({ id: 'campaign-1' })
        const body = { contract: 'calling.CreateAiCallCampaignCommand.v1' }
        const response = await createCampaign(request('/api/ai-calls/campaigns', 'POST', body))
        expect(response.status).toBe(201)
        expect(mocks.create).toHaveBeenCalledWith(body, { id: 'supervisor-1' })
    })

    it('rejects untrusted origins and non-JSON mutation bodies before Calling', async () => {
        mocks.currentUser.mockResolvedValue({ id: 'supervisor-1', role: 'Руководитель' })
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
