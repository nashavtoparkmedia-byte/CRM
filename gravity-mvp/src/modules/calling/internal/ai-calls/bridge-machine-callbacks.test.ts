import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    callFindUnique: vi.fn(),
    callUpdate: vi.fn(),
    createTaskV1: vi.fn(),
    enqueueAnalyze: vi.fn(),
    getAllPlaintext: vi.fn(),
    getScenario: vi.fn(),
    operationalLog: vi.fn(),
    persistEvents: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
    prisma: {
        call: {
            findUnique: mocks.callFindUnique,
            update: mocks.callUpdate,
        },
    },
}))
vi.mock('@/lib/ai-call/scenarios', () => ({ getScenario: mocks.getScenario }))
vi.mock('@/infrastructure/operations/operational-log', () => ({
    operationalLogV1: mocks.operationalLog,
}))
vi.mock('@/lib/queue/queues', () => ({ enqueueAnalyze: mocks.enqueueAnalyze }))
vi.mock('@/lib/ai-call/outcome-mapper', () => ({
    computeOutcome: () => ({ outcome: 'unclear_engaged', reason: 'test_reason' }),
    normalizeQualificationScore: () => null,
    tagWithValidationIssues: (reason: string) => reason,
}))
vi.mock('@/lib/ai-call/scenario-schema', () => ({
    validateLeadData: () => ({ data: {}, issues: [] }),
}))
vi.mock('@/lib/ai-call/event-emitter', () => ({
    _createPersistEvents: () => mocks.persistEvents,
}))
vi.mock('@/contracts/work-management/v1', () => ({
    CREATE_TASK_COMMAND_V1: 'create-task-command.v1',
}))
vi.mock('@/modules/work-management/public/v1', () => ({
    createTaskV1: mocks.createTaskV1,
}))
vi.mock('@/lib/ai-call/provider-settings', () => ({
    getAllPlaintext: mocks.getAllPlaintext,
}))

import { POST as finalizeCall } from '@/app/api/ai-calls/sessions/[id]/finalize/route'
import { POST as changeCallState } from '@/app/api/ai-calls/sessions/[id]/state/route'
import { POST as appendTranscriptItem } from '@/app/api/ai-calls/sessions/[id]/transcript-item/route'
import { GET as resolveCall } from '@/app/api/ai-calls/sessions/by-fs-uuid/[fsUuid]/route'
import { GET as getAiCallKeys } from '@/app/api/internal/ai-call-keys/route'

const VALID_TOKEN = 'A'.repeat(32)
const WRONG_TOKEN = 'B'.repeat(32)
const callContext = { params: Promise.resolve({ id: 'call-1' }) }
const resolveContext = { params: Promise.resolve({ fsUuid: 'fs-1' }) }

function request(
    path: string,
    method: 'GET' | 'POST',
    body?: unknown,
    token?: string,
): NextRequest {
    const headers = new Headers()
    if (token !== undefined) headers.set('x-bridge-token', token)
    if (body !== undefined) headers.set('content-type', 'application/json')
    return new NextRequest(`https://crm.example${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
}

const machineCallbacks = [
    {
        name: 'session resolver',
        invoke: (token?: string) => resolveCall(
            request('/api/ai-calls/sessions/by-fs-uuid/fs-1', 'GET', undefined, token),
            resolveContext,
        ),
    },
    {
        name: 'state mutation',
        invoke: (token?: string) => changeCallState(
            request('/api/ai-calls/sessions/call-1/state', 'POST', { state: 'greeting' }, token),
            callContext,
        ),
    },
    {
        name: 'transcript mutation',
        invoke: (token?: string) => appendTranscriptItem(
            request('/api/ai-calls/sessions/call-1/transcript-item', 'POST', {
                role: 'user',
                text: 'hello',
            }, token),
            callContext,
        ),
    },
    {
        name: 'finalization mutation',
        invoke: (token?: string) => finalizeCall(
            request('/api/ai-calls/sessions/call-1/finalize', 'POST', { reason: 'closed' }, token),
            callContext,
        ),
    },
    {
        name: 'provider-key machine read',
        invoke: (token?: string) => getAiCallKeys(
            request('/api/internal/ai-call-keys', 'GET', undefined, token),
        ),
    },
] as const

beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('BRIDGE_SHARED_TOKEN', VALID_TOKEN)
    mocks.callUpdate.mockResolvedValue({})
    mocks.persistEvents.mockResolvedValue({
        inserted: 1,
        skipped: 0,
        errored: false,
        issues: [],
    })
})

afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
})

describe('AudioBridge callback route authentication', () => {
    it.each(machineCallbacks)('rejects $name without a token before protected work', async ({ invoke }) => {
        const response = await invoke(undefined)
        expect(response.status).toBe(403)
        await expect(response.json()).resolves.toEqual({ error: 'forbidden' })
        expect(mocks.callFindUnique).not.toHaveBeenCalled()
        expect(mocks.callUpdate).not.toHaveBeenCalled()
        expect(mocks.getScenario).not.toHaveBeenCalled()
        expect(mocks.getAllPlaintext).not.toHaveBeenCalled()
        expect(mocks.operationalLog).not.toHaveBeenCalled()
    })

    it('fails closed when the configured secret is missing', async () => {
        vi.stubEnv('BRIDGE_SHARED_TOKEN', '')
        const response = await machineCallbacks[1].invoke(VALID_TOKEN)
        expect(response.status).toBe(403)
        await expect(response.json()).resolves.toEqual({ error: 'forbidden' })
        expect(mocks.callFindUnique).not.toHaveBeenCalled()
    })

    it('returns and logs no secret material for malformed or wrong credentials', async () => {
        const logSpies = [
            vi.spyOn(console, 'debug').mockImplementation(() => undefined),
            vi.spyOn(console, 'info').mockImplementation(() => undefined),
            vi.spyOn(console, 'warn').mockImplementation(() => undefined),
            vi.spyOn(console, 'error').mockImplementation(() => undefined),
            vi.spyOn(console, 'log').mockImplementation(() => undefined),
        ]

        for (const token of ['short', WRONG_TOKEN]) {
            const response = await machineCallbacks[4].invoke(token)
            expect(response.status).toBe(403)
            const responseText = await response.text()
            expect(responseText).toBe('{"error":"forbidden"}')
            expect(responseText).not.toContain(VALID_TOKEN)
            expect(responseText).not.toContain(token)
        }
        expect(mocks.operationalLog).not.toHaveBeenCalled()
        for (const spy of logSpies) expect(spy).not.toHaveBeenCalled()
    })

    it('accepts the exact token and preserves resolver semantics', async () => {
        mocks.callFindUnique.mockResolvedValue({
            id: 'call-1',
            isAi: true,
            aiScenarioId: 'scenario-1',
            driverId: 'driver-1',
            contactId: 'contact-1',
            managerId: 'manager-1',
        })
        mocks.getScenario.mockResolvedValue({
            id: 'scenario-1',
            name: 'Qualification',
            systemPrompt: 'Prompt',
            questions: ['Question'],
            targetDurationSec: 90,
        })

        const response = await machineCallbacks[0].invoke(VALID_TOKEN)
        expect(response.status).toBe(200)
        await expect(response.json()).resolves.toEqual({
            callId: 'call-1',
            driverId: 'driver-1',
            contactId: 'contact-1',
            managerId: 'manager-1',
            scenario: {
                id: 'scenario-1',
                name: 'Qualification',
                systemPrompt: 'Prompt',
                questions: ['Question'],
                targetDurationSec: 90,
            },
        })
    })

    it('accepts the exact token and preserves state mutation semantics', async () => {
        mocks.callFindUnique.mockResolvedValue({ id: 'call-1', aiSessionStatus: 'starting' })

        const response = await machineCallbacks[1].invoke(VALID_TOKEN)
        expect(response.status).toBe(200)
        await expect(response.json()).resolves.toEqual({
            ok: true,
            callId: 'call-1',
            state: 'greeting',
            skipped: false,
        })
        expect(mocks.callUpdate).toHaveBeenCalledWith({
            where: { id: 'call-1' },
            data: { aiSessionStatus: 'greeting' },
        })
    })

    it('accepts the exact token and preserves transcript append semantics', async () => {
        mocks.callFindUnique.mockResolvedValue({ transcript: '[AI] Welcome\n' })

        const response = await machineCallbacks[2].invoke(VALID_TOKEN)
        expect(response.status).toBe(200)
        await expect(response.json()).resolves.toEqual({ ok: true })
        expect(mocks.callUpdate).toHaveBeenCalledWith({
            where: { id: 'call-1' },
            data: { transcript: '[AI] Welcome\n[Лид] hello\n' },
        })
    })

    it('accepts the exact token and preserves finalization semantics', async () => {
        mocks.callFindUnique.mockResolvedValue({
            id: 'call-1',
            startedAt: new Date(Date.now() - 1000),
            driverId: null,
            contactId: null,
            managerId: null,
            aiScenarioId: null,
            aiScenario: null,
            transcript: null,
        })

        const response = await machineCallbacks[3].invoke(VALID_TOKEN)
        expect(response.status).toBe(200)
        await expect(response.json()).resolves.toEqual({
            ok: true,
            callId: 'call-1',
            sessionStatus: 'ended',
            createdTask: null,
        })
        expect(mocks.callUpdate).toHaveBeenCalledTimes(1)
        expect(mocks.persistEvents).toHaveBeenCalledTimes(1)
        expect(mocks.enqueueAnalyze).not.toHaveBeenCalled()
    })

    it('accepts the exact token and preserves the internal key response semantics', async () => {
        const providerData = {
            openaiApiKey: 'provider-secret-for-bridge',
            yandexApiKey: null,
            yandexFolderId: null,
            mockMode: false,
        }
        mocks.getAllPlaintext.mockResolvedValue(providerData)

        const response = await machineCallbacks[4].invoke(VALID_TOKEN)
        expect(response.status).toBe(200)
        expect(response.headers.get('cache-control')).toContain('no-store')
        await expect(response.json()).resolves.toEqual(providerData)
    })
})

function readSource(path: string): string {
    return readFileSync(join(process.cwd(), path), 'utf8')
}

function exportedHandler(source: string, method: 'GET' | 'POST'): string {
    const start = source.indexOf(`export async function ${method}`)
    expect(start, `${method} handler must remain exported`).toBeGreaterThanOrEqual(0)
    return source.slice(start)
}

describe('AudioBridge callback source boundary', () => {
    const guardedRoutes: Array<[string, 'GET' | 'POST', RegExp]> = [
        ['src/app/api/ai-calls/sessions/by-fs-uuid/[fsUuid]/route.ts', 'GET', /await ctx\.params/],
        ['src/app/api/ai-calls/sessions/[id]/state/route.ts', 'POST', /await ctx\.params/],
        ['src/app/api/ai-calls/sessions/[id]/transcript-item/route.ts', 'POST', /await ctx\.params/],
        ['src/app/api/ai-calls/sessions/[id]/finalize/route.ts', 'POST', /await ctx\.params/],
        ['src/app/api/internal/ai-call-keys/route.ts', 'GET', /await getAllPlaintext/],
    ]

    it.each(guardedRoutes)('guards %s before request or protected-resource access', (path, method, operation) => {
        const handler = exportedHandler(readSource(path), method)
        const guardAt = handler.indexOf('isBridgeMachineRequestAuthenticated(req.headers)')
        const operationAt = handler.search(operation)
        expect(guardAt, `${path} must authenticate the bridge`).toBeGreaterThanOrEqual(0)
        expect(operationAt, `${path} protected operation anchor missing`).toBeGreaterThanOrEqual(0)
        expect(guardAt, `${path} must authenticate first`).toBeLessThan(operationAt)
    })

    it('keeps the shared-token header wired into all five Bridge requests', () => {
        const bridgeClient = readSource('../tools/audio-bridge-day1/crm-client.js')
        expect(bridgeClient).toContain("return BRIDGE_SHARED_TOKEN ? { 'X-Bridge-Token': BRIDGE_SHARED_TOKEN } : {}")
        expect(bridgeClient.match(/\.\.\.authHeaders\(\)/g)).toHaveLength(5)
    })

    it('does not mix machine authentication into human AI-call routes', () => {
        const humanRoutes = [
            'src/app/api/ai-calls/start/route.ts',
            'src/app/api/ai-calls/mock/route.ts',
            'src/app/api/ai-calls/dev-simulate/route.ts',
            'src/app/api/settings/ai-call-projects/route.ts',
            'src/app/api/settings/ai-call-scenarios/route.ts',
            'src/app/api/settings/ai-call-scenarios/[id]/route.ts',
            'src/app/api/settings/ai-call-keys/route.ts',
            'src/app/api/settings/ai-call-keys/test/route.ts',
        ]
        for (const path of humanRoutes) {
            expect(readSource(path), path).not.toContain('bridge-machine-auth')
        }
        for (const path of humanRoutes.slice(0, 3)) {
            expect(readSource(path), path).toContain('getCurrentUser')
        }
    })
})
