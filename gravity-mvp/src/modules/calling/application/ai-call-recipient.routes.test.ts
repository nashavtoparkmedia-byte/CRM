import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    callCreate: vi.fn(),
    callUpdate: vi.fn(),
    createTaskV1: vi.fn(),
    getCurrentUser: vi.fn(),
    getMockPayload: vi.fn(),
    getScenario: vi.fn(),
    isMockModeEnabled: vi.fn(),
    listScenarios: vi.fn(),
    operationalLog: vi.fn(),
    originateAiCall: vi.fn(),
    pickRandomVariant: vi.fn(),
    resolveContactRecipient: vi.fn(),
    resolveDriverRecipient: vi.fn(),
    scenarioFindUnique: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
    prisma: {
        aiCallScenario: { findUnique: mocks.scenarioFindUnique },
        call: { create: mocks.callCreate, update: mocks.callUpdate },
    },
}))
vi.mock('@/modules/identity-access/public/v1/user-directory', () => ({
    getCurrentUserIdentityV1: mocks.getCurrentUser,
}))
vi.mock('@/infrastructure/operations/operational-log', () => ({
    operationalLogV1: mocks.operationalLog,
}))
vi.mock('@/lib/ai-call/esl-originate', () => ({ originateAiCall: mocks.originateAiCall }))
vi.mock('@/lib/ai-call/scenarios', () => ({
    DEFAULT_PROJECT_ID: 'default-project',
    getScenario: mocks.getScenario,
    listScenarios: mocks.listScenarios,
}))
vi.mock('@/lib/ai-call/provider-settings', () => ({
    isMockModeEnabled: mocks.isMockModeEnabled,
}))
vi.mock('@/lib/ai-call/mock-payload', () => ({
    getMockPayload: mocks.getMockPayload,
    pickRandomVariant: mocks.pickRandomVariant,
}))
vi.mock('@/contracts/work-management/v1', () => ({
    CREATE_TASK_COMMAND_V1: 'work_management.CreateTaskCommand.v1',
}))
vi.mock('@/modules/work-management/public/v1', () => ({ createTaskV1: mocks.createTaskV1 }))
vi.mock('@/modules/calling/application/ai-call-recipient', () => ({
    resolveAiCallContactRecipient: mocks.resolveContactRecipient,
    resolveAiCallDriverRecipient: mocks.resolveDriverRecipient,
}))

import { POST as startCall } from '@/app/api/ai-calls/start/route'
import { POST as createMockCall } from '@/app/api/ai-calls/mock/route'

function request(path: string, body: unknown): NextRequest {
    return new NextRequest(`https://crm.example${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    })
}

const scenario = { id: 'scenario-1', name: 'Qualification' }

beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('AI_CALL_LIVE_MODE', 'true')
    mocks.getCurrentUser.mockResolvedValue({ id: 'user-1' })
    mocks.isMockModeEnabled.mockResolvedValue(true)
    mocks.resolveContactRecipient.mockResolvedValue({
        status: 'resolved',
        contactId: 'contact-1',
        phone: '+79990000000',
    })
    mocks.resolveDriverRecipient.mockResolvedValue({
        status: 'resolved',
        driverId: 'driver-1',
        phone: '+78880000000',
    })
    mocks.getScenario.mockResolvedValue(scenario)
    mocks.listScenarios.mockResolvedValue([scenario])
    mocks.callCreate.mockResolvedValue({ id: 'call-1', metadata: null })
    mocks.callUpdate.mockResolvedValue({})
    mocks.originateAiCall.mockResolvedValue('+OK accepted')
    mocks.getMockPayload.mockReturnValue({
        durationSec: 30,
        transcript: '[AI] Test',
        aiSummary: 'Test summary',
        qualificationResult: {
            qualification_status: 'qualified',
            lead_summary: 'Test summary',
            reason: 'test',
            manager_task: { should_create: false, summary: 'none', priority: 'normal' },
        },
        aiSessionStatus: 'ended',
        estimatedCostRub: 1,
    })
})

afterEach(() => {
    vi.unstubAllEnvs()
})

describe('AI-call single-recipient route integration', () => {
    it('starts a live Contact call with the Contacts-selected phone and preserves success semantics', async () => {
        const response = await startCall(request('/api/ai-calls/start', {
            contactId: 'contact-1',
            scenarioId: 'scenario-1',
        }))

        expect(response.status).toBe(200)
        const body = await response.json()
        expect(body).toMatchObject({
            ok: true,
            callId: 'call-1',
            scenarioId: 'scenario-1',
            scenarioName: 'Qualification',
        })
        expect(body.fsUuid).toEqual(expect.any(String))
        expect(mocks.resolveContactRecipient).toHaveBeenCalledWith({
            contactId: 'contact-1',
            driverId: null,
            phoneNumber: null,
        })
        expect(mocks.callCreate).toHaveBeenCalledWith({
            data: expect.objectContaining({
                toNumber: '+79990000000',
                driverId: null,
                contactId: 'contact-1',
                managerId: 'user-1',
                isAi: true,
                aiScenarioId: 'scenario-1',
            }),
        })
        expect(mocks.originateAiCall).toHaveBeenCalledTimes(1)
        expect(mocks.resolveDriverRecipient).not.toHaveBeenCalled()
    })

    it('keeps the mock Contact surface on the same Contacts boundary', async () => {
        const response = await createMockCall(request('/api/ai-calls/mock', {
            contactId: 'contact-1',
            variant: 'qualified',
        }))

        expect(response.status).toBe(200)
        await expect(response.json()).resolves.toEqual({
            ok: true,
            callId: 'call-1',
            variant: 'qualified',
            qualificationStatus: 'qualified',
            createdTask: null,
        })
        expect(mocks.resolveContactRecipient).toHaveBeenCalledWith({
            contactId: 'contact-1',
            driverId: null,
            phoneNumber: null,
        })
        expect(mocks.callCreate).toHaveBeenCalledWith({
            data: expect.objectContaining({
                toNumber: '+79990000000',
                contactId: 'contact-1',
                driverId: null,
            }),
        })
        expect(mocks.originateAiCall).not.toHaveBeenCalled()
    })

    it.each([
        ['live', (req: NextRequest) => startCall(req), '/api/ai-calls/start'],
        ['mock', (req: NextRequest) => createMockCall(req), '/api/ai-calls/mock'],
    ])('maps an unreachable %s Contact to the existing bounded error', async (_name, invoke, path) => {
        mocks.resolveContactRecipient.mockResolvedValue({
            status: 'unreachable',
            reason: 'contact_not_found_or_no_callable_phone',
        })
        const response = await invoke(request(path, { contactId: 'missing-or-unreachable' }))
        expect(response.status).toBe(400)
        await expect(response.json()).resolves.toEqual({ error: 'no_phone_number_for_lead' })
        expect(mocks.callCreate).not.toHaveBeenCalled()
        expect(mocks.originateAiCall).not.toHaveBeenCalled()
    })

    it('returns deterministic Contact input failures before storage or telephony', async () => {
        mocks.resolveContactRecipient.mockResolvedValue({
            status: 'invalid_input',
            reason: 'ambiguous_contact_recipient',
        })
        const response = await startCall(request('/api/ai-calls/start', {
            contactId: 'contact-1',
            phoneNumber: '+78880000000',
        }))
        expect(response.status).toBe(400)
        await expect(response.json()).resolves.toEqual({ error: 'ambiguous_contact_recipient' })
        expect(mocks.callCreate).not.toHaveBeenCalled()
        expect(mocks.originateAiCall).not.toHaveBeenCalled()
    })

    it('preserves Identity authorization before Contact resolution', async () => {
        mocks.getCurrentUser.mockResolvedValue(null)
        const live = await startCall(request('/api/ai-calls/start', { contactId: 'contact-1' }))
        const mock = await createMockCall(request('/api/ai-calls/mock', { contactId: 'contact-1' }))
        expect(live.status).toBe(401)
        expect(mock.status).toBe(401)
        expect(mocks.resolveContactRecipient).not.toHaveBeenCalled()
        expect(mocks.callCreate).not.toHaveBeenCalled()
    })

    it.each([
        ['live', (req: NextRequest) => startCall(req), '/api/ai-calls/start'],
        ['mock', (req: NextRequest) => createMockCall(req), '/api/ai-calls/mock'],
    ])('resolves a %s Driver through the Calling Fleet facade', async (_name, invoke, path) => {
        const response = await invoke(request(path, { driverId: 'driver-1', variant: 'qualified' }))
        expect(response.status).toBe(200)
        expect(mocks.resolveDriverRecipient).toHaveBeenCalledWith({
            driverId: 'driver-1',
            contactId: null,
            phoneNumber: null,
        })
        expect(mocks.resolveContactRecipient).not.toHaveBeenCalled()
        expect(mocks.callCreate).toHaveBeenCalledWith({
            data: expect.objectContaining({
                driverId: 'driver-1',
                contactId: null,
                toNumber: '+78880000000',
            }),
        })
    })

    it.each([
        ['live missing Driver', (req: NextRequest) => startCall(req), '/api/ai-calls/start', 'driver_not_found'],
        ['mock missing Driver', (req: NextRequest) => createMockCall(req), '/api/ai-calls/mock', 'driver_not_found'],
        ['live Driver without phone', (req: NextRequest) => startCall(req), '/api/ai-calls/start', 'driver_has_no_callable_phone'],
        ['mock Driver without phone', (req: NextRequest) => createMockCall(req), '/api/ai-calls/mock', 'driver_has_no_callable_phone'],
    ])('maps %s to the existing bounded product error', async (_name, invoke, path, reason) => {
        mocks.resolveDriverRecipient.mockResolvedValue({ status: 'unreachable', reason })
        const response = await invoke(request(path, { driverId: 'driver-1' }))
        expect(response.status).toBe(400)
        await expect(response.json()).resolves.toEqual({ error: 'no_phone_number_for_lead' })
        expect(mocks.callCreate).not.toHaveBeenCalled()
        expect(mocks.originateAiCall).not.toHaveBeenCalled()
    })

    it('rejects Driver plus raw-phone ambiguity before storage or telephony', async () => {
        mocks.resolveDriverRecipient.mockResolvedValue({
            status: 'invalid_input',
            reason: 'ambiguous_driver_recipient',
        })
        const response = await startCall(request('/api/ai-calls/start', {
            driverId: 'driver-1',
            phoneNumber: '+79990000000',
        }))
        expect(response.status).toBe(400)
        await expect(response.json()).resolves.toEqual({ error: 'ambiguous_driver_recipient' })
        expect(mocks.resolveDriverRecipient).toHaveBeenCalledTimes(1)
        expect(mocks.callCreate).not.toHaveBeenCalled()
        expect(mocks.originateAiCall).not.toHaveBeenCalled()
    })
})

function readSource(path: string): string {
    return readFileSync(join(process.cwd(), path), 'utf8')
}

describe('AI-call recipient source boundary', () => {
    const routePaths = [
        'src/app/api/ai-calls/start/route.ts',
        'src/app/api/ai-calls/mock/route.ts',
    ]

    it('removes direct Contact and Driver persistence/private access from both entry routes', () => {
        for (const path of routePaths) {
            const source = readSource(path)
            expect(source, path).not.toMatch(/prisma\.(?:contact|contactPhone)/)
            expect(source, path).not.toMatch(/prisma\.driver/)
            expect(source, path).not.toMatch(/ContactService|@\/lib\/contacts/)
            expect(source, path).not.toMatch(/@\/modules\/contacts\/(?:application|internal)/)
            expect(source, path).toContain('@/modules/calling/application/ai-call-recipient')
        }
    })

    it('uses only the Contacts public surface and exact versioned phone query', () => {
        const source = readSource('src/modules/calling/application/ai-call-recipient.ts')
        expect(source).toContain("from '@/modules/contacts/public/v1'")
        expect(source).toContain('GET_PREFERRED_ACTIVE_CONTACT_PHONE_QUERY_V1')
        expect(source).not.toMatch(/@\/lib\/|prisma|ContactService/)
        expect(source).not.toMatch(/@\/modules\/contacts\/(?:application|internal)/)
    })

    it('uses only the Fleet public surface and exact versioned callable-phone query', () => {
        const source = readSource('src/modules/calling/application/ai-call-recipient.ts')
        expect(source).toContain("from '@/modules/fleet-operations/public/v1'")
        expect(source).toContain('GET_DRIVER_CALLABLE_PHONE_QUERY_V1')
        expect(source).not.toMatch(/@\/modules\/fleet-operations\/(?:application|internal)/)
        expect(source).not.toMatch(/prisma\.driver/)
    })

    it('keeps human Identity first and resolves Driver only after authorization', () => {
        for (const path of routePaths) {
            const source = readSource(path)
            expect(source.indexOf('await getCurrentUser()')).toBeLessThan(source.indexOf('await req.json()'))
            expect(source.indexOf('await getCurrentUser()')).toBeLessThan(
                source.indexOf('resolveAiCallContactRecipient('),
            )
            expect(source.indexOf('await getCurrentUser()')).toBeLessThan(
                source.indexOf('resolveAiCallDriverRecipient('),
            )
        }
    })
})
