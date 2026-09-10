import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AiCallFinalizationInputError } from '@/modules/calling/application/ai-call-finalization'
import { AiCallTranscriptConflictError } from '@/modules/calling/application/ai-call-transcript'

const mocks = vi.hoisted(() => ({
    callFindUnique: vi.fn(),
    callUpdate: vi.fn(),
    changeAiCallLifecycle: vi.fn(),
    appendAiCallTranscriptMessage: vi.fn(),
    createTaskV1: vi.fn(),
    finalizeAiCall: vi.fn(),
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
vi.mock('@/modules/calling/application/ai-call-finalization-runtime', () => ({
    finalizeAiCall: mocks.finalizeAiCall,
}))
vi.mock('@/modules/calling/application/ai-call-callback-runtime', () => ({
    changeAiCallLifecycle: mocks.changeAiCallLifecycle,
    appendAiCallTranscriptMessage: mocks.appendAiCallTranscriptMessage,
}))
vi.mock('@/lib/ai-call/provider-settings', () => ({
    getAllPlaintext: mocks.getAllPlaintext,
}))

import { POST as finalizeCall } from '@/app/api/ai-calls/sessions/[id]/finalize/route'
import { POST as changeCallState } from '@/app/api/ai-calls/sessions/[id]/state/route'
import { POST as appendTranscriptItem } from '@/app/api/ai-calls/sessions/[id]/transcript-item/route'
import { GET as resolveCall } from '@/app/api/ai-calls/sessions/by-fs-uuid/[fsUuid]/route'
import { GET as getAiCallKeys } from '@/app/api/internal/ai-call-keys/route'

const VALID_TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz012345'
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
                messageId: 'audio-bridge-transcript:v1:fs-1:1',
                ordinal: 1,
                final: true,
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
    mocks.finalizeAiCall.mockResolvedValue({
        kind: 'success',
        callId: 'call-1',
        sessionStatus: 'ended',
        createdTask: null,
        duplicate: false,
        followUpStatus: 'not_required',
    })
    mocks.changeAiCallLifecycle.mockResolvedValue({
        kind: 'applied',
        callId: 'call-1',
        journal: { state: 'greeting', revision: 1 },
        receipt: {
            eventId: 'audio-bridge-lifecycle:v1:call-1:greeting_started',
            previousState: 'starting',
        },
    })
    mocks.appendAiCallTranscriptMessage.mockResolvedValue({
        kind: 'applied',
        callId: 'call-1',
        journal: { revision: 1 },
        receipt: {
            messageId: 'audio-bridge-transcript:v1:fs-1:1',
            ordinal: 1,
            segmentRevision: 1,
            acceptedAfterTerminal: false,
        },
        legacyTranscript: '[Лид] hello\n',
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
        expect(mocks.finalizeAiCall).not.toHaveBeenCalled()
        expect(mocks.changeAiCallLifecycle).not.toHaveBeenCalled()
        expect(mocks.appendAiCallTranscriptMessage).not.toHaveBeenCalled()
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
        const response = await machineCallbacks[1].invoke(VALID_TOKEN)
        expect(response.status).toBe(200)
        await expect(response.json()).resolves.toEqual({
            ok: true,
            callId: 'call-1',
            state: 'greeting',
            revision: 1,
            skipped: false,
        })
        expect(mocks.changeAiCallLifecycle).toHaveBeenCalledWith('call-1', {
            eventId: 'audio-bridge-lifecycle:v1:call-1:greeting_started',
            source: 'audio_bridge',
            sourceSequence: 1,
            kind: 'greeting_started',
            target: 'greeting',
        })
    })

    it('accepts the exact token and preserves transcript append semantics', async () => {
        const response = await machineCallbacks[2].invoke(VALID_TOKEN)
        expect(response.status).toBe(200)
        await expect(response.json()).resolves.toEqual({
            ok: true,
            callId: 'call-1',
            messageId: 'audio-bridge-transcript:v1:fs-1:1',
            ordinal: 1,
            segmentRevision: 1,
            revision: 1,
            duplicate: false,
            stale: false,
            acceptedAfterTerminal: false,
        })
        expect(mocks.appendAiCallTranscriptMessage).toHaveBeenCalledWith('call-1', {
            messageId: 'audio-bridge-transcript:v1:fs-1:1',
            ordinal: 1,
            segmentRevision: 1,
            role: 'user',
            content: 'hello',
            final: true,
            source: 'audio_bridge',
        })
    })

    it('accepts the exact token and preserves finalization semantics', async () => {
        const response = await machineCallbacks[3].invoke(VALID_TOKEN)
        expect(response.status).toBe(200)
        await expect(response.json()).resolves.toEqual({
            ok: true,
            callId: 'call-1',
            sessionStatus: 'ended',
            createdTask: null,
            duplicate: false,
            followUpStatus: 'not_required',
        })
        expect(mocks.finalizeAiCall).toHaveBeenCalledWith('call-1', { reason: 'closed' })
        expect(mocks.callUpdate).not.toHaveBeenCalled()
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

describe('AI-call finalize HTTP result mapping', () => {
    it('maps malformed finalization payloads to a bounded 400 response', async () => {
        mocks.finalizeAiCall.mockRejectedValueOnce(new AiCallFinalizationInputError('reason is invalid'))
        const response = await machineCallbacks[3].invoke(VALID_TOKEN)
        expect(response.status).toBe(400)
        await expect(response.json()).resolves.toEqual({
            error: 'invalid_payload',
            message: 'reason is invalid',
        })
    })

    it.each([
        [{ kind: 'not_found' }, 404, { error: 'not_found' }],
        [
            { kind: 'conflict', reason: 'different_terminal_payload' },
            409,
            { error: 'finalization_conflict', reason: 'different_terminal_payload' },
        ],
        [
            { kind: 'retryable', callId: 'call-1', followUpStatus: 'retry_wait', retryAfterMs: 500 },
            503,
            { error: 'follow_up_retryable', callId: 'call-1', followUpStatus: 'retry_wait', retryAfterMs: 500 },
        ],
        [
            {
                kind: 'terminal_failure',
                callId: 'call-1',
                failure: { code: 'INVALID_CONTRACT', message: 'invalid', retryable: false },
            },
            422,
            {
                error: 'follow_up_terminal_failure',
                callId: 'call-1',
                failure: { code: 'INVALID_CONTRACT', message: 'invalid', retryable: false },
            },
        ],
    ] as const)('maps bounded application result %#', async (result, status, body) => {
        mocks.finalizeAiCall.mockResolvedValueOnce(result)
        const response = await machineCallbacks[3].invoke(VALID_TOKEN)
        expect(response.status).toBe(status)
        await expect(response.json()).resolves.toEqual(body)
    })

    it('maps transcript reconciliation collision before terminal acceptance to bounded 409', async () => {
        mocks.finalizeAiCall.mockRejectedValueOnce(
            new AiCallTranscriptConflictError('identity_collision', 'changed'),
        )
        const response = await machineCallbacks[3].invoke(VALID_TOKEN)
        expect(response.status).toBe(409)
        await expect(response.json()).resolves.toEqual({
            error: 'transcript_conflict', reason: 'identity_collision',
        })
    })
})

describe('AI-call lifecycle/transcript HTTP fencing', () => {
    it('returns a bounded stale lifecycle rejection without a direct Call write', async () => {
        mocks.changeAiCallLifecycle.mockResolvedValueOnce({
            kind: 'stale',
            callId: 'call-1',
            journal: { state: 'active', revision: 1 },
            receipt: { eventId: 'late-greeting' },
        })
        const response = await machineCallbacks[1].invoke(VALID_TOKEN)
        expect(response.status).toBe(409)
        await expect(response.json()).resolves.toEqual({
            error: 'stale_lifecycle_event', callId: 'call-1', state: 'active', revision: 1,
        })
        expect(mocks.callUpdate).not.toHaveBeenCalled()
    })

    it('reports exact transcript replay without duplicating the compatibility projection', async () => {
        mocks.appendAiCallTranscriptMessage.mockResolvedValueOnce({
            kind: 'duplicate',
            callId: 'call-1',
            journal: { revision: 1 },
            receipt: {
                messageId: 'audio-bridge-transcript:v1:fs-1:1',
                ordinal: 1,
                segmentRevision: 1,
                acceptedAfterTerminal: false,
            },
            legacyTranscript: '[Лид] hello\n',
        })
        const response = await machineCallbacks[2].invoke(VALID_TOKEN)
        expect(response.status).toBe(200)
        await expect(response.json()).resolves.toMatchObject({ duplicate: true, revision: 1 })
    })

    it('accepts an interim Bridge segment for a later correction revision', async () => {
        mocks.appendAiCallTranscriptMessage.mockResolvedValueOnce({
            kind: 'applied',
            callId: 'call-1',
            journal: { revision: 1 },
            receipt: { messageId: 'm1', ordinal: 1, segmentRevision: 1, acceptedAfterTerminal: false },
            legacyTranscript: '[Лид] partial\n',
        })
        const response = await appendTranscriptItem(request(
            '/api/ai-calls/sessions/call-1/transcript-item',
            'POST',
            { role: 'user', text: 'partial', messageId: 'm1', ordinal: 1, final: false },
            VALID_TOKEN,
        ), callContext)
        expect(response.status).toBe(200)
        await expect(response.json()).resolves.toMatchObject({ ok: true, segmentRevision: 1, stale: false })
        expect(mocks.appendAiCallTranscriptMessage).toHaveBeenCalledWith('call-1', {
            messageId: 'm1', ordinal: 1, segmentRevision: 1, role: 'user',
            content: 'partial', final: false, source: 'audio_bridge',
        })
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
        ['src/app/api/ai-calls/sessions/[id]/state/route.ts', 'POST', /await changeAiCallLifecycle/],
        ['src/app/api/ai-calls/sessions/[id]/transcript-item/route.ts', 'POST', /await appendAiCallTranscriptMessage/],
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
