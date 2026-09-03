import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    callCreate: vi.fn(),
    aiCallMessageCreate: vi.fn(),
    claimControlledRealAiCall: vi.fn(),
    createTaskV1: vi.fn(),
    dispatchControlledRealAiCall: vi.fn(),
    getActiveScenario: vi.fn(),
    getCurrentUser: vi.fn(),
    getMockPayload: vi.fn(),
    getScenario: vi.fn(),
    isControlledOperatorAuthenticated: vi.fn(),
    isMockModeEnabled: vi.fn(),
    listScenarios: vi.fn(),
    operationalLog: vi.fn(),
    readControlledRealCallReadiness: vi.fn(),
    recordDispatchAccepted: vi.fn(),
    recordDispatchRejected: vi.fn(),
    recordDispatchUnknown: vi.fn(),
    pickRandomVariant: vi.fn(),
    resolveContactRecipient: vi.fn(),
    resolveDriverRecipient: vi.fn(),
    scenarioFindUnique: vi.fn(),
    transaction: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
    prisma: {
        $transaction: mocks.transaction,
        aiCallScenario: { findUnique: mocks.scenarioFindUnique },
        aiCallMessage: { create: mocks.aiCallMessageCreate },
        call: { create: mocks.callCreate },
    },
}))
vi.mock('@/modules/identity-access/public/v1/user-directory', () => ({
    getCurrentUserIdentityV1: mocks.getCurrentUser,
}))
vi.mock('@/infrastructure/operations/operational-log', () => ({
    operationalLogV1: mocks.operationalLog,
}))
vi.mock('@/modules/calling/application/controlled-real-ai-call-runtime', () => ({
    claimControlledRealAiCall: mocks.claimControlledRealAiCall,
    dispatchControlledRealAiCall: mocks.dispatchControlledRealAiCall,
    readControlledRealCallReadiness: mocks.readControlledRealCallReadiness,
    recordControlledRealAiCallDispatchAccepted: mocks.recordDispatchAccepted,
    recordControlledRealAiCallDispatchRejected: mocks.recordDispatchRejected,
    recordControlledRealAiCallDispatchUnknown: mocks.recordDispatchUnknown,
}))
vi.mock('@/modules/calling/application/controlled-real-ai-call-operator-auth', () => ({
    isControlledRealCallOperatorAuthenticated: mocks.isControlledOperatorAuthenticated,
}))
vi.mock('@/lib/ai-call/scenarios', () => ({
    DEFAULT_PROJECT_ID: 'default-project',
    getActiveScenario: mocks.getActiveScenario,
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
import { ControlledRealAiCallDispatchError } from './controlled-real-ai-call-provider'

function request(path: string, body: unknown): NextRequest {
    const controlledBody = path === '/api/ai-calls/start' && typeof body === 'object' && body !== null
        ? {
            requestId: 'operator-proof-0001',
            confirmation: 'PLACE_ONE_CONTROLLED_REAL_AI_CALL',
            scenarioId: 'scenario-1',
            ...body,
        }
        : body
    return new NextRequest(`https://crm.example${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(controlledBody),
    })
}

const scenario = { id: 'scenario-1', name: 'Qualification' }

beforeEach(() => {
    vi.clearAllMocks()
    mocks.getCurrentUser.mockResolvedValue({ id: 'user-1', role: 'Администратор', status: 'Активен' })
    mocks.isControlledOperatorAuthenticated.mockReturnValue(true)
    mocks.isMockModeEnabled.mockResolvedValue(true)
    mocks.resolveContactRecipient.mockResolvedValue({
        status: 'resolved',
        contactId: 'contact-1',
        phone: '+79990000000',
    })
    mocks.resolveDriverRecipient.mockResolvedValue({
        status: 'resolved',
        driverId: 'driver-1',
        phone: '+79990000000',
    })
    mocks.getScenario.mockResolvedValue(scenario)
    mocks.getActiveScenario.mockResolvedValue(scenario)
    mocks.listScenarios.mockResolvedValue([scenario])
    mocks.callCreate.mockImplementation(async (input) => ({
        id: input.data.id ?? 'call-1',
        fsUuid: input.data.fsUuid,
        managerId: input.data.managerId,
        toNumber: input.data.toNumber,
        aiScenarioId: input.data.aiScenarioId,
        isAi: input.data.isAi,
        isSimulation: input.data.isSimulation,
        status: input.data.status,
        aiSessionStatus: input.data.aiSessionStatus,
        metadata: input.data.metadata,
    }))
    mocks.aiCallMessageCreate.mockResolvedValue({ id: 'message-1' })
    mocks.transaction.mockImplementation(async (operation) => operation({
        aiCallMessage: { create: mocks.aiCallMessageCreate },
        call: { create: mocks.callCreate },
    }))
    mocks.dispatchControlledRealAiCall.mockResolvedValue({
        provider: 'freeswitch',
        providerReference: 'fs-uuid-1',
    })
    mocks.recordDispatchAccepted.mockResolvedValue(undefined)
    mocks.recordDispatchRejected.mockResolvedValue(undefined)
    mocks.recordDispatchUnknown.mockResolvedValue(undefined)
    mocks.claimControlledRealAiCall.mockResolvedValue({
        kind: 'claimed',
        call: {
            id: 'controlled_live_call_1',
            fsUuid: 'fs-uuid-1',
            managerId: 'user-1',
            toNumber: '+79990000000',
            aiScenarioId: 'scenario-1',
            isAi: true,
            isSimulation: false,
            status: 'ringing',
            aiSessionStatus: 'starting',
            metadata: {},
        },
        fsUuid: 'fs-uuid-1',
        requestFingerprint: 'request-fingerprint-1',
        scenarioName: 'Qualification',
    })
    mocks.readControlledRealCallReadiness.mockResolvedValue({
        ready: true,
        blockers: [],
        public: {
            ready: true,
            blockers: [],
            attemptLimit: 1,
            automaticRetry: false,
            allowedDestinationMasked: '+79***00',
            providers: {
                telephony: 'freeswitch', trunk: 'megafon', llm: 'openai', stt: 'openai', tts: 'openai',
            },
        },
        admission: {
            allowedDestinationE164: '+79990000000',
            approvedRequestId: 'operator-proof-0001',
            callerNumberE164: '+79991112233',
            providers: {
                telephony: 'freeswitch', trunk: 'megafon', llm: 'openai', stt: 'openai', tts: 'openai',
            },
        },
    })
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
            callId: 'controlled_live_call_1',
            scenarioId: 'scenario-1',
            scenarioName: 'Qualification',
        })
        expect(body.fsUuid).toEqual(expect.any(String))
        expect(mocks.resolveContactRecipient).toHaveBeenCalledWith({
            contactId: 'contact-1',
            driverId: null,
            phoneNumber: null,
        })
        expect(mocks.claimControlledRealAiCall).toHaveBeenCalledWith(expect.objectContaining({
            toNumber: '+79990000000',
            driverId: null,
            contactId: 'contact-1',
            actorId: 'user-1',
            scenarioId: 'scenario-1',
        }))
        expect(mocks.recordDispatchAccepted).toHaveBeenCalledWith({
            callId: 'controlled_live_call_1',
            requestFingerprint: 'request-fingerprint-1',
            providerReference: 'fs-uuid-1',
        })
        expect(mocks.dispatchControlledRealAiCall).toHaveBeenCalledTimes(1)
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
            callId: expect.any(String),
            variant: 'qualified',
            qualificationStatus: 'qualified',
            createdTask: null,
        })
        expect(mocks.resolveContactRecipient).toHaveBeenCalledWith({
            contactId: 'contact-1',
            driverId: null,
            phoneNumber: null,
        })
        expect(mocks.callCreate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                toNumber: '+79990000000',
                contactId: 'contact-1',
                driverId: null,
                isSimulation: true,
            }),
        }))
        expect(mocks.dispatchControlledRealAiCall).not.toHaveBeenCalled()
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
        expect(mocks.claimControlledRealAiCall).not.toHaveBeenCalled()
        expect(mocks.dispatchControlledRealAiCall).not.toHaveBeenCalled()
    })

    it('rejects an ambiguous Contact plus raw-phone request before owner lookup or telephony', async () => {
        const response = await startCall(request('/api/ai-calls/start', {
            contactId: 'contact-1',
            phoneNumber: '+78880000000',
        }))
        expect(response.status).toBe(400)
        await expect(response.json()).resolves.toEqual({ error: 'exactly_one_recipient_required' })
        expect(mocks.resolveContactRecipient).not.toHaveBeenCalled()
        expect(mocks.callCreate).not.toHaveBeenCalled()
        expect(mocks.claimControlledRealAiCall).not.toHaveBeenCalled()
        expect(mocks.dispatchControlledRealAiCall).not.toHaveBeenCalled()
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
    ])('resolves a %s Driver through the Calling Fleet facade', async (name, invoke, path) => {
        const response = await invoke(request(path, { driverId: 'driver-1', variant: 'qualified' }))
        expect(response.status).toBe(200)
        expect(mocks.resolveDriverRecipient).toHaveBeenCalledWith({
            driverId: 'driver-1',
            contactId: null,
            phoneNumber: null,
        })
        expect(mocks.resolveContactRecipient).not.toHaveBeenCalled()
        if (name === 'live') {
            expect(mocks.claimControlledRealAiCall).toHaveBeenCalledWith(expect.objectContaining({
                driverId: 'driver-1',
                contactId: null,
                toNumber: '+79990000000',
            }))
        } else {
            expect(mocks.callCreate).toHaveBeenCalledWith(expect.objectContaining({
                data: expect.objectContaining({
                    driverId: 'driver-1',
                    contactId: null,
                    toNumber: '+79990000000',
                }),
            }))
        }
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
        expect(mocks.claimControlledRealAiCall).not.toHaveBeenCalled()
        expect(mocks.dispatchControlledRealAiCall).not.toHaveBeenCalled()
    })

    it('rejects Driver plus raw-phone ambiguity before storage or telephony', async () => {
        const response = await startCall(request('/api/ai-calls/start', {
            driverId: 'driver-1',
            phoneNumber: '+79990000000',
        }))
        expect(response.status).toBe(400)
        await expect(response.json()).resolves.toEqual({ error: 'exactly_one_recipient_required' })
        expect(mocks.resolveDriverRecipient).not.toHaveBeenCalled()
        expect(mocks.callCreate).not.toHaveBeenCalled()
        expect(mocks.claimControlledRealAiCall).not.toHaveBeenCalled()
        expect(mocks.dispatchControlledRealAiCall).not.toHaveBeenCalled()
    })

    it('fails closed before storage when controlled live readiness is disabled', async () => {
        mocks.readControlledRealCallReadiness.mockResolvedValue({
            ready: false,
            blockers: ['controlled_gate_disabled'],
            admission: null,
            public: {
                ready: false,
                blockers: ['controlled_gate_disabled'],
                attemptLimit: 1,
                automaticRetry: false,
                allowedDestinationMasked: null,
                providers: {
                    telephony: 'freeswitch', trunk: 'megafon', llm: 'openai', stt: 'unselected', tts: 'unselected',
                },
            },
        })
        const response = await startCall(request('/api/ai-calls/start', { contactId: 'contact-1' }))
        expect(response.status).toBe(503)
        await expect(response.json()).resolves.toMatchObject({ error: 'controlled_real_call_not_ready' })
        expect(mocks.callCreate).not.toHaveBeenCalled()
        expect(mocks.claimControlledRealAiCall).not.toHaveBeenCalled()
        expect(mocks.dispatchControlledRealAiCall).not.toHaveBeenCalled()
    })

    it('rejects a resolved but non-allowlisted destination', async () => {
        mocks.resolveContactRecipient.mockResolvedValue({
            status: 'resolved',
            contactId: 'contact-1',
            phone: '+79990000001',
        })
        const response = await startCall(request('/api/ai-calls/start', { contactId: 'contact-1' }))
        expect(response.status).toBe(403)
        await expect(response.json()).resolves.toEqual({ error: 'destination_not_allowlisted' })
        expect(mocks.callCreate).not.toHaveBeenCalled()
        expect(mocks.claimControlledRealAiCall).not.toHaveBeenCalled()
        expect(mocks.dispatchControlledRealAiCall).not.toHaveBeenCalled()
    })

    it('returns an existing canonical Call on retry without a second provider effect', async () => {
        const first = await startCall(request('/api/ai-calls/start', { contactId: 'contact-1' }))
        expect(first.status).toBe(200)
        const claimed = await mocks.claimControlledRealAiCall.mock.results[0].value
        mocks.claimControlledRealAiCall.mockResolvedValue({ ...claimed, kind: 'duplicate' })

        const replay = await startCall(request('/api/ai-calls/start', { contactId: 'contact-1' }))
        expect(replay.status).toBe(200)
        await expect(replay.json()).resolves.toMatchObject({
            ok: true,
            duplicate: true,
            dispatched: false,
            callId: claimed.call.id,
        })
        expect(mocks.claimControlledRealAiCall).toHaveBeenCalledTimes(2)
        expect(mocks.dispatchControlledRealAiCall).toHaveBeenCalledTimes(1)
    })

    it('normalizes provider rejection into the canonical failed lifecycle', async () => {
        mocks.dispatchControlledRealAiCall.mockRejectedValue(new Error('provider detail'))
        const response = await startCall(request('/api/ai-calls/start', { contactId: 'contact-1' }))
        expect(response.status).toBe(502)
        await expect(response.json()).resolves.toMatchObject({ error: 'provider_originate_failed' })
        expect(mocks.recordDispatchRejected).toHaveBeenCalledWith({
            callId: 'controlled_live_call_1',
            requestFingerprint: 'request-fingerprint-1',
            failureCode: 'PROVIDER_UNAVAILABLE',
        })
    })

    it('keeps an ambiguous after-send provider outcome nonterminal and forbids retry', async () => {
        mocks.dispatchControlledRealAiCall.mockRejectedValue(
            new ControlledRealAiCallDispatchError('outcome_unknown'),
        )
        const response = await startCall(request('/api/ai-calls/start', { contactId: 'contact-1' }))
        expect(response.status).toBe(504)
        await expect(response.json()).resolves.toMatchObject({
            error: 'provider_outcome_unknown',
            callId: 'controlled_live_call_1',
            retryForbidden: true,
        })
        expect(mocks.recordDispatchUnknown).toHaveBeenCalledTimes(1)
        expect(mocks.recordDispatchRejected).not.toHaveBeenCalled()
    })

    it('never reclassifies a provider-accepted call when observation persistence fails', async () => {
        mocks.recordDispatchAccepted.mockRejectedValue(new Error('database unavailable'))
        const response = await startCall(request('/api/ai-calls/start', { contactId: 'contact-1' }))
        expect(response.status).toBe(202)
        await expect(response.json()).resolves.toMatchObject({
            ok: true,
            dispatched: true,
            observationPending: true,
            retryForbidden: true,
            callId: 'controlled_live_call_1',
        })
        expect(mocks.recordDispatchRejected).not.toHaveBeenCalled()
        expect(mocks.recordDispatchUnknown).not.toHaveBeenCalled()
    })

    it('requires the dedicated strong control token in addition to CRM identity', async () => {
        mocks.isControlledOperatorAuthenticated.mockReturnValue(false)
        const response = await startCall(request('/api/ai-calls/start', { contactId: 'contact-1' }))
        expect(response.status).toBe(403)
        expect(mocks.readControlledRealCallReadiness).not.toHaveBeenCalled()
        expect(mocks.claimControlledRealAiCall).not.toHaveBeenCalled()
    })

    it('denies a disabled privileged CRM identity', async () => {
        mocks.getCurrentUser.mockResolvedValue({
            id: 'user-1', role: 'Администратор', status: 'Отключен',
        })
        const response = await startCall(request('/api/ai-calls/start', { contactId: 'contact-1' }))
        expect(response.status).toBe(403)
        expect(mocks.isControlledOperatorAuthenticated).not.toHaveBeenCalled()
    })

    it('rejects every fresh request identity not pre-approved in configuration', async () => {
        const response = await startCall(request('/api/ai-calls/start', {
            requestId: 'operator-proof-0002',
            contactId: 'contact-1',
        }))
        expect(response.status).toBe(400)
        await expect(response.json()).resolves.toEqual({ error: 'request_not_approved' })
        expect(mocks.resolveContactRecipient).not.toHaveBeenCalled()
        expect(mocks.claimControlledRealAiCall).not.toHaveBeenCalled()
    })

    it('rejects an inactive or missing scenario before canonical admission', async () => {
        mocks.getActiveScenario.mockResolvedValue(null)
        const response = await startCall(request('/api/ai-calls/start', { contactId: 'contact-1' }))
        expect(response.status).toBe(400)
        await expect(response.json()).resolves.toEqual({ error: 'scenario_not_active' })
        expect(mocks.claimControlledRealAiCall).not.toHaveBeenCalled()
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

    it('keeps canonical Call persistence behind the Calling owner operation', () => {
        const source = readSource('src/app/api/ai-calls/start/route.ts')
        expect(source).not.toMatch(/@\/lib\/prisma|prisma\.call/)
        expect(source).toContain('claimControlledRealAiCall(')
    })

    it('keeps simulations out of collections while preserving direct result inspection', () => {
        expect(readSource('src/app/calls/[id]/page.tsx')).toContain('findUnique({')
        expect(readSource('src/app/api/calls/[id]/route.ts')).toContain('findUnique({')
        expect(readSource('src/app/api/calls/route.ts')).toContain('isSimulation: false')
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
