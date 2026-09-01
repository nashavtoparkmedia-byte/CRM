import { NextRequest } from 'next/server'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
    CONTROL_AI_CALL_CAMPAIGN_COMMAND_V1,
    CREATE_AI_CALL_CAMPAIGN_COMMAND_V1,
} from '@/contracts/calling/v1'
import { prisma } from '@/lib/prisma'

const mocks = vi.hoisted(() => ({
    integrationAdminPrincipal: vi.fn(),
    currentUser: vi.fn(),
    users: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/modules/identity-access/public/v1', () => ({
    getIntegrationAdminPrincipal: mocks.integrationAdminPrincipal,
}))

vi.mock('@/modules/identity-access/public/v1/user-directory', () => ({
    getCurrentUserIdentityV1: mocks.currentUser,
    listUserIdentitiesV1: mocks.users,
}))

import { GET as listCampaigns, POST as createCampaign } from '@/app/api/ai-calls/campaigns/route'
import { GET as getCampaign, PATCH as controlCampaign } from '@/app/api/ai-calls/campaigns/[id]/route'
import { GET as listCampaignScenarioOptions } from '@/app/api/ai-calls/campaigns/scenario-options/route'
import { GET as listOrdinaryCalls } from '@/app/api/calls/route'
import { GET as getOrdinaryCallStats } from '@/app/api/calls/stats/route'
import { buildCallChunks } from '@/lib/ai/knowledge/callTranscriptBuilder'
import {
    prepareAiCallCampaignCreateV1,
    prepareAiCallCampaignScenarioSnapshotV1,
} from '../../application/ai-call-campaign-product-operations'
import { runAiCallCampaignRuntimeCycleV1 } from '../../application/ai-call-campaign-runtime-startup'
import { aiCallCampaignPrismaPort } from './ai-call-campaign-prisma-adapter'

const productProof = process.env.YOKO_AI_CALL_CAMPAIGN_PRODUCT_POSTGRES_PROOF === '1'
    ? describe
    : describe.skip
const PREFIX = 'ai-call-campaign-product-proof-v1'
const projectId = `${PREFIX}:project`
const scenarioId = `${PREFIX}:scenario`
const frozenOutcomeSchema = {
    fields: [
        { key: 'simulation', type: 'boolean', required: true },
        { key: 'terminalKind', type: 'string', required: true, maxLength: 64 },
    ],
}
const mutatedOutcomeSchema = {
    fields: [{ key: 'mutableOnly', type: 'string', required: true, maxLength: 64 }],
}

interface RawDatabase {
    $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>
    $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>
}

const database = prisma as unknown as RawDatabase

function request(path: string, method = 'GET', body?: unknown): NextRequest {
    return new NextRequest(`https://crm.example${path}`, {
        method,
        headers: {
            host: 'crm.example',
            origin: 'https://crm.example',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : {
            body: JSON.stringify(body),
        }),
    })
}

async function cleanup() {
    const campaigns = await database.$queryRawUnsafe<Array<{ id: string }>>(`
        SELECT "id" FROM "AiCallCampaign" WHERE "name" LIKE $1
    `, `${PREFIX}%`)
    for (const campaign of campaigns) {
        await database.$executeRawUnsafe('DELETE FROM "AiCallCampaignAuditEvent" WHERE "campaignId"=$1', campaign.id)
        await database.$executeRawUnsafe('DELETE FROM "AiCallAdmissionLease" WHERE "campaignId"=$1', campaign.id)
        await database.$executeRawUnsafe('UPDATE "AiCallCampaignMember" SET "activeAttemptId"=NULL WHERE "campaignId"=$1', campaign.id)
        await database.$executeRawUnsafe('DELETE FROM "AiCallCampaignAttempt" WHERE "campaignId"=$1', campaign.id)
        await database.$executeRawUnsafe('DELETE FROM "AiCallCampaignMember" WHERE "campaignId"=$1', campaign.id)
        await database.$executeRawUnsafe('DELETE FROM "AiCallCampaign" WHERE "id"=$1', campaign.id)
    }
    await database.$executeRawUnsafe('DELETE FROM "Call" WHERE "id" LIKE $1', 'aicsim_%')
    await database.$executeRawUnsafe('DELETE FROM "AiCallScenario" WHERE "id"=$1', scenarioId)
    await database.$executeRawUnsafe('DELETE FROM "AiCallProject" WHERE "id"=$1', projectId)
    await database.$executeRawUnsafe('DELETE FROM "AiCallAdmissionControl" WHERE "id"=\'global\'')
}

const command = {
    contract: CREATE_AI_CALL_CAMPAIGN_COMMAND_V1,
    requestId: `${PREFIX}:request`,
    name: `${PREFIX}:campaign`,
    scenarioId,
    scheduledAt: null,
    concurrentLimit: 2,
    ratePerMinute: 10_000,
    maxAttempts: 2,
    retryBaseMs: 1,
    retryMaxMs: 4,
    audience: {
        sourceRef: `${PREFIX}:explicit-fixture`,
        sourceVersion: 'immutable-v1',
        members: [
            { targetRef: 'success', phoneE164: '+79990000101', label: 'Success' },
            { targetRef: 'retry', phoneE164: '+79990000102', label: 'Retry then success' },
            { targetRef: 'permanent', phoneE164: '+79990000103', label: 'Permanent failure' },
            { targetRef: 'crash', phoneE164: '+79990000104', label: 'Restart replay' },
        ],
    },
}

productProof.sequential('AI Call campaign current-CRM isolated product proof', () => {
    beforeAll(async () => {
        mocks.integrationAdminPrincipal.mockResolvedValue({
            id: 'identity-access:integration-admin-session',
            kind: 'integration_admin_session',
        })
        mocks.currentUser.mockResolvedValue({ id: `${PREFIX}:admin`, role: 'Администратор' })
        vi.stubEnv('AI_CALL_CAMPAIGN_RUNTIME_MODE', 'simulated')
        vi.stubEnv('YOKO_AI_CALL_CAMPAIGN_SIMULATION_PROOF', '1')
        vi.stubEnv('AI_CALL_CAMPAIGN_GLOBAL_CONCURRENCY', '2')
        vi.stubEnv('AI_CALL_CAMPAIGN_GLOBAL_RATE_PER_MINUTE', '10000')
        vi.stubEnv('AI_CALL_CAMPAIGN_CLAIM_LEASE_MS', '250')
        vi.stubEnv('AI_CALL_CAMPAIGN_ADMISSION_LEASE_MS', '250')
        await cleanup()
        await (prisma as any).aiCallProject.create({
            data: { id: projectId, name: `${PREFIX}:project`, slug: `${PREFIX}-project` },
        })
        await (prisma as any).aiCallScenario.create({
            data: {
                id: scenarioId,
                projectId,
                name: `${PREFIX}:scenario`,
                systemPrompt: 'Controlled isolated product proof only.',
                questions: [],
                outcomeSchema: frozenOutcomeSchema,
            },
        })
    })

    afterAll(async () => {
        await cleanup()
        vi.unstubAllEnvs()
    })

    afterEach(async () => {
        await (prisma as any).aiCallScenario.updateMany({
            where: { id: scenarioId },
            data: {
                systemPrompt: 'Controlled isolated product proof only.',
                outcomeSchema: frozenOutcomeSchema,
                isActive: true,
            },
        })
    })

    it('runs actual routes and the simulated callback/finalization stack without duplicate logical effects', async () => {
        const scenarioCountsBefore = await database.$queryRawUnsafe<Array<{ projects: number; scenarios: number }>>(`
            SELECT
              (SELECT COUNT(*)::int FROM "AiCallProject") AS "projects",
              (SELECT COUNT(*)::int FROM "AiCallScenario") AS "scenarios"
        `)
        mocks.currentUser.mockResolvedValueOnce({ id: `${PREFIX}:manager`, role: 'Менеджер' })
        const scenarioOptionsResponse = await listCampaignScenarioOptions()
        expect(scenarioOptionsResponse.status).toBe(200)
        await expect(scenarioOptionsResponse.json()).resolves.toMatchObject({
            scenarios: expect.arrayContaining([{ id: scenarioId, name: `${PREFIX}:scenario` }]),
        })
        await expect(database.$queryRawUnsafe<Array<{ projects: number; scenarios: number }>>(`
            SELECT
              (SELECT COUNT(*)::int FROM "AiCallProject") AS "projects",
              (SELECT COUNT(*)::int FROM "AiCallScenario") AS "scenarios"
        `)).resolves.toEqual(scenarioCountsBefore)

        const createdResponse = await createCampaign(request('/api/ai-calls/campaigns', 'POST', command))
        expect(createdResponse.status).toBe(201)
        const createdBody = await createdResponse.json()
        const campaignId = createdBody.campaign.id as string
        expect(createdBody.campaign).toMatchObject({
            name: command.name,
            state: 'scheduled',
            progress: { total: 4 },
            operations: { runtimeMode: 'simulated' },
        })
        expect(createdBody.campaign.scenarioFingerprint).toMatch(/^[0-9a-f]{64}$/)
        const frozenScenarioFingerprint = createdBody.campaign.scenarioFingerprint as string
        await (prisma as any).aiCallScenario.update({
            where: { id: scenarioId },
            data: {
                systemPrompt: 'Mutated only after the campaign snapshot was frozen.',
                outcomeSchema: mutatedOutcomeSchema,
                isActive: false,
            },
        })
        const replayAfterScenarioDeactivation = await createCampaign(
            request('/api/ai-calls/campaigns', 'POST', command),
        )
        expect(replayAfterScenarioDeactivation.status).toBe(201)
        await expect(replayAfterScenarioDeactivation.json()).resolves.toMatchObject({
            campaign: { id: campaignId, scenarioFingerprint: frozenScenarioFingerprint },
        })

        let sawControlledCrash = false
        let detail = createdBody.campaign
        for (let tick = 0; tick < 80 && detail.state !== 'completed'; tick += 1) {
            const cycles = await Promise.allSettled([
                runAiCallCampaignRuntimeCycleV1(),
                runAiCallCampaignRuntimeCycleV1(),
                runAiCallCampaignRuntimeCycleV1(),
            ])
            for (const cycle of cycles) {
                if (cycle.status === 'rejected') {
                    const reason = String(cycle.reason)
                    if (reason.includes('SIMULATED_CAMPAIGN_WORKER_EXIT_AFTER_CALLBACKS')) {
                        sawControlledCrash = true
                    } else {
                        expect(reason).toContain('admission lease is stale')
                    }
                }
            }
            await new Promise((resolve) => setTimeout(resolve, sawControlledCrash ? 20 : 8))
            const response = await getCampaign(
                request(`/api/ai-calls/campaigns/${campaignId}?memberLimit=200`),
                { params: Promise.resolve({ id: campaignId }) },
            )
            expect(response.status).toBe(200)
            detail = (await response.json()).campaign
        }

        expect(sawControlledCrash).toBe(true)
        expect(detail.state).toBe('completed')
        expect(detail.progress).toMatchObject({ total: 4, succeeded: 3, failed: 1, completed: 4 })
        expect(detail.cost).toMatchObject({
            status: 'provider_billing_not_ingested', currency: null, amount: null, completedCalls: 5,
            simulatedCalls: 5, hasSimulatedResults: true,
        })
        const attempts = detail.members.flatMap((member: any) => member.attempts)
        expect(attempts).toHaveLength(5)
        expect(new Set(attempts.map((attempt: any) => attempt.launchId)).size).toBe(5)
        expect(new Set(attempts.map((attempt: any) => attempt.call?.id)).size).toBe(5)
        expect(attempts.every((attempt: any) => attempt.logicalEffectRef?.startsWith('simulated:'))).toBe(true)
        expect(attempts.every((attempt: any) => attempt.call?.transcript?.includes('Controlled simulated'))).toBe(true)
        expect(attempts.every((attempt: any) => attempt.call?.followUpState === 'not_required')).toBe(true)
        expect(detail.recentOutcomes).toHaveLength(5)
        expect(detail.recentOutcomes.map((outcome: { completedAt: string }) => outcome.completedAt))
            .toEqual([...detail.recentOutcomes]
                .map((outcome: { completedAt: string }) => outcome.completedAt)
                .sort((left: string, right: string) => right.localeCompare(left)))
        expect(detail.recentOutcomes.map((outcome: { label: string }) => outcome.label))
            .toEqual(expect.arrayContaining(['Success', 'Retry then success', 'Permanent failure', 'Restart replay']))
        const crashCallId = detail.members.find((member: { targetRef: string }) => member.targetRef === 'crash')
            ?.attempts[0]?.call?.id
        await expect(database.$queryRawUnsafe<Array<{ durableCrashReceipt: boolean }>>(`
            SELECT COALESCE(("metadata"->>'campaignSimulatedCrashInjected')::boolean,false)
              AS "durableCrashReceipt"
            FROM "Call" WHERE "id"=$1
        `, crashCallId)).resolves.toEqual([{ durableCrashReceipt: true }])
        expect(detail.audit.map((event: any) => event.action)).toEqual(expect.arrayContaining([
            'created', 'audience_frozen', 'scheduled', 'started', 'completed',
        ]))
        expect(detail.operations).toMatchObject({
            runtimeMode: 'simulated', activeLeases: 0, staleClaims: 0, permanentFailures: 1,
            simulatedCalls: 5, hasSimulatedResults: true,
        })
        expect(detail.scenarioFingerprint).toBe(frozenScenarioFingerprint)
        await expect(database.$queryRawUnsafe<Array<{ fingerprints: string[] }>>(`
            SELECT ARRAY_AGG(DISTINCT "metadata"->>'scenarioFingerprint') AS fingerprints
            FROM "Call" WHERE "id" IN (
              SELECT "callId" FROM "AiCallCampaignAttempt" WHERE "campaignId"=$1
            )
        `, campaignId)).resolves.toEqual([{ fingerprints: [frozenScenarioFingerprint] }])
        const frozenFinalization = await database.$queryRawUnsafe<Array<{
            leadData: { simulation: boolean; terminalKind: string }
            outcomeReason: string
        }>>(`
            SELECT "leadDataStructured" AS "leadData", "aiOutcomeReason" AS "outcomeReason"
            FROM "Call" WHERE "id" IN (
              SELECT "callId" FROM "AiCallCampaignAttempt" WHERE "campaignId"=$1
            ) ORDER BY "id"
        `, campaignId)
        expect(frozenFinalization).toHaveLength(5)
        expect(frozenFinalization.every((call) => (
            call.leadData?.simulation === true
            && typeof call.leadData?.terminalKind === 'string'
            && !call.outcomeReason.includes('validation_issues=')
        ))).toBe(true)
        await (prisma as any).aiCallScenario.update({
            where: { id: scenarioId },
            data: {
                systemPrompt: 'Controlled isolated product proof only.',
                outcomeSchema: frozenOutcomeSchema,
                isActive: true,
            },
        })

        const ordinaryHistory = await listOrdinaryCalls(request('/api/calls?limit=200'))
        expect(ordinaryHistory.status).toBe(200)
        expect((await ordinaryHistory.json()).calls.some((call: { id: string }) => call.id.startsWith('aicsim_')))
            .toBe(false)
        const ordinaryCount = await database.$queryRawUnsafe<Array<{ count: number }>>(`
            SELECT COUNT(*)::int AS count FROM "Call"
            WHERE "isSimulation"=false AND "startedAt">='2020-01-01' AND "startedAt"<'2100-01-02'
        `)
        const ordinaryStats = await getOrdinaryCallStats(request(
            '/api/calls/stats?from=2020-01-01&to=2100-01-01',
        ))
        const ordinaryStatsBody = await ordinaryStats.json()
        expect(ordinaryStats.status, JSON.stringify(ordinaryStatsBody)).toBe(200)
        expect(ordinaryStatsBody).toMatchObject({
            totals: { total: ordinaryCount[0]?.count ?? 0 },
        })
        const knowledge = await buildCallChunks({ mode: 'all', channels: ['phone'], maxPairs: 100 })
        expect(knowledge.pairs.some((pair) => pair.managerMessageId.startsWith('aicsim_'))).toBe(false)

        const replay = await createCampaign(request('/api/ai-calls/campaigns', 'POST', command))
        expect(replay.status).toBe(201)
        await expect(replay.json()).resolves.toMatchObject({ campaign: { id: campaignId, state: 'completed' } })
        for (const changed of [
            { ...command, scheduledAt: '2099-01-01T00:00:00.000Z' },
            {
                ...command,
                audience: {
                    ...command.audience,
                    members: command.audience.members.map((member, index) => index === 0
                        ? { ...member, phoneE164: '+79990000999' }
                        : member),
                },
            },
        ]) {
            const conflict = await createCampaign(request('/api/ai-calls/campaigns', 'POST', changed))
            expect(conflict.status).toBe(409)
            await expect(conflict.json()).resolves.toMatchObject({ code: 'campaign_identity_collision' })
        }
        const counts = await database.$queryRawUnsafe<Array<{
            campaigns: number
            members: number
            attempts: number
            calls: number
        }>>(`
            SELECT
              (SELECT COUNT(*)::int FROM "AiCallCampaign" WHERE "id"=$1) AS "campaigns",
              (SELECT COUNT(*)::int FROM "AiCallCampaignMember" WHERE "campaignId"=$1) AS "members",
              (SELECT COUNT(*)::int FROM "AiCallCampaignAttempt" WHERE "campaignId"=$1) AS "attempts",
              (SELECT COUNT(*)::int FROM "Call" WHERE "id" IN (SELECT "callId" FROM "AiCallCampaignAttempt" WHERE "campaignId"=$1)) AS "calls"
        `, campaignId)
        expect(counts[0]).toEqual({ campaigns: 1, members: 4, attempts: 5, calls: 5 })

        const list = await listCampaigns(request('/api/ai-calls/campaigns?limit=10'))
        expect(list.status).toBe(200)
        expect((await list.json()).campaigns).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: campaignId, state: 'completed' }),
        ]))
    }, 30_000)

    it('resumes an unfinished linked simulated Call after a process exit and exposes it operationally', async () => {
        const linkCrashCommand = {
            ...command,
            requestId: `${PREFIX}:link-crash-request`,
            name: `${PREFIX}:link-crash-campaign`,
            audience: {
                sourceRef: `${PREFIX}:link-crash-explicit-fixture`,
                sourceVersion: 'immutable-v1',
                members: [{
                    targetRef: 'link-crash',
                    phoneE164: '+79990000111',
                    label: 'Exit after durable Call link',
                }],
            },
        }
        await database.$executeRawUnsafe(`
            UPDATE "AiCallAdmissionControl" SET "nextAdmitAt"=NULL WHERE "id"='global'
        `)
        const created = await createCampaign(request('/api/ai-calls/campaigns', 'POST', linkCrashCommand))
        expect(created.status).toBe(201)
        const campaignId = (await created.json()).campaign.id as string

        await expect(runAiCallCampaignRuntimeCycleV1())
            .rejects.toThrow('SIMULATED_CAMPAIGN_WORKER_EXIT_AFTER_CALL_LINK')

        const interruptedResponse = await getCampaign(
            request(`/api/ai-calls/campaigns/${campaignId}?memberLimit=10`),
            { params: Promise.resolve({ id: campaignId }) },
        )
        expect(interruptedResponse.status).toBe(200)
        const interrupted = (await interruptedResponse.json()).campaign
        expect(interrupted).toMatchObject({
            state: 'running',
            operations: { unfinalizedLinkedCalls: 1, staleUnfinalizedCalls: [] },
            progress: { running: 1, completed: 0 },
        })
        expect(interrupted.members[0].attempts[0]).toMatchObject({
            state: 'running',
            dispatchState: 'acceptance_unknown',
            call: { endedAt: null, sessionStatus: 'active' },
        })

        const pauseResponse = await controlCampaign(
            request(`/api/ai-calls/campaigns/${campaignId}`, 'PATCH', {
                contract: CONTROL_AI_CALL_CAMPAIGN_COMMAND_V1,
                requestId: `${PREFIX}:link-crash-pause`,
                campaignId,
                action: 'pause',
            }),
            { params: Promise.resolve({ id: campaignId }) },
        )
        expect(pauseResponse.status).toBe(200)
        await expect(pauseResponse.json()).resolves.toMatchObject({ campaign: { state: 'paused' } })

        await new Promise((resolve) => setTimeout(resolve, 300))
        const staleResponse = await getCampaign(
            request(`/api/ai-calls/campaigns/${campaignId}?memberLimit=10`),
            { params: Promise.resolve({ id: campaignId }) },
        )
        const stale = (await staleResponse.json()).campaign
        expect(stale).toMatchObject({
            state: 'paused',
            operations: {
                unfinalizedLinkedCalls: 1,
                staleUnfinalizedCalls: [{
                    callId: interrupted.members[0].attempts[0].call.id,
                    targetRef: 'link-crash',
                    label: 'Exit after durable Call link',
                    sessionStatus: 'active',
                }],
            },
        })
        await expect(runAiCallCampaignRuntimeCycleV1()).resolves.toMatchObject({
            kind: 'completed', memberState: 'succeeded', campaignState: 'completed',
        })

        const recoveredResponse = await getCampaign(
            request(`/api/ai-calls/campaigns/${campaignId}?memberLimit=10`),
            { params: Promise.resolve({ id: campaignId }) },
        )
        expect(recoveredResponse.status).toBe(200)
        const recovered = (await recoveredResponse.json()).campaign
        expect(recovered).toMatchObject({
            state: 'completed',
            operations: {
                activeLeases: 0,
                staleClaims: 0,
                unfinalizedLinkedCalls: 0,
                staleUnfinalizedCalls: [],
            },
            progress: { succeeded: 1, completed: 1 },
        })
        expect(recovered.members[0].attempts).toHaveLength(1)
        expect(recovered.members[0].attempts[0]).toMatchObject({
            state: 'succeeded',
            claimRevision: 2,
            dispatchState: 'accepted',
            call: { endedAt: expect.any(String), sessionStatus: 'ended' },
        })
        const durable = await database.$queryRawUnsafe<Array<{
            calls: number
            transcriptMessages: number
            dialExecutionCount: number
            linkCrashReceipt: boolean
        }>>(`
            SELECT COUNT(DISTINCT phone_call."id")::int AS "calls",
                   COUNT(message."id")::int AS "transcriptMessages",
                   MAX(attempt."dialExecutionCount")::int AS "dialExecutionCount",
                   BOOL_AND(COALESCE((phone_call."metadata"->>'campaignSimulatedLinkCrashInjected')::boolean,false))
                     AS "linkCrashReceipt"
            FROM "AiCallCampaignAttempt" attempt
            JOIN "Call" phone_call ON phone_call."id"=attempt."callId"
            LEFT JOIN "AiCallMessage" message ON message."callId"=phone_call."id"
            WHERE attempt."campaignId"=$1
        `, campaignId)
        expect(durable).toEqual([{
            calls: 1,
            transcriptMessages: 2,
            dialExecutionCount: 2,
            linkCrashReceipt: true,
        }])
    }, 30_000)

    it('keeps a repeatedly failing linked Call recoverable instead of terminalizing an active orphan', async () => {
        const poisonCommand = {
            ...command,
            requestId: `${PREFIX}:link-reconcile-flaky-request`,
            name: `${PREFIX}:link-reconcile-flaky-campaign`,
            audience: {
                sourceRef: `${PREFIX}:link-reconcile-flaky-fixture`,
                sourceVersion: 'immutable-v1',
                members: [{
                    targetRef: 'link-reconcile-flaky',
                    phoneE164: '+79990000112',
                    label: 'Repeated linked Call reconciliation failure',
                }],
            },
        }
        await database.$executeRawUnsafe(`
            UPDATE "AiCallAdmissionControl" SET "nextAdmitAt"=NULL WHERE "id"='global'
        `)
        const created = await createCampaign(request('/api/ai-calls/campaigns', 'POST', poisonCommand))
        expect(created.status).toBe(201)
        const campaignId = (await created.json()).campaign.id as string

        await expect(runAiCallCampaignRuntimeCycleV1())
            .rejects.toThrow('SIMULATED_CAMPAIGN_WORKER_EXIT_BEFORE_LINKED_CALL_FINALIZATION')
        await new Promise((resolve) => setTimeout(resolve, 300))
        await expect(runAiCallCampaignRuntimeCycleV1())
            .rejects.toThrow('SIMULATED_CAMPAIGN_RECONCILIATION_FAILURE_AFTER_CALL_LINK')
        await new Promise((resolve) => setTimeout(resolve, 300))
        const deferred = await runAiCallCampaignRuntimeCycleV1()
        expect(deferred).toMatchObject({
            kind: 'blocked',
            reason: 'dial_reconciliation_deferred',
        })
        if (!('retryAt' in deferred)) throw new Error('expected linked Call reconciliation deferral')

        const immediatelyVisibleResponse = await getCampaign(
            request(`/api/ai-calls/campaigns/${campaignId}?memberLimit=10`),
            { params: Promise.resolve({ id: campaignId }) },
        )
        expect(immediatelyVisibleResponse.status).toBe(200)
        const immediatelyVisible = (await immediatelyVisibleResponse.json()).campaign
        expect(immediatelyVisible).toMatchObject({
            state: 'running',
            progress: { running: 1, completed: 0 },
            operations: {
                activeLeases: 0,
                unfinalizedLinkedCalls: 1,
                staleUnfinalizedCalls: [],
            },
        })
        expect(immediatelyVisible.members[0]).toMatchObject({
            state: 'running',
            failureCode: 'dial_reconciliation_error',
            attempts: [{
                state: 'running',
                dispatchState: 'acceptance_unknown',
                failureCode: 'dial_reconciliation_error',
                call: { endedAt: null, sessionStatus: 'active' },
            }],
        })
        expect(immediatelyVisible.audit).toEqual(expect.arrayContaining([
            expect.objectContaining({
                action: 'retry_scheduled',
                details: expect.objectContaining({
                    reason: 'adapter_error',
                    callId: immediatelyVisible.members[0].attempts[0].call.id,
                }),
            }),
        ]))

        await new Promise((resolve) => setTimeout(
            resolve,
            Math.max(0, deferred.retryAt.getTime() - Date.now()) + 50,
        ))
        const staleResponse = await getCampaign(
            request(`/api/ai-calls/campaigns/${campaignId}?memberLimit=10`),
            { params: Promise.resolve({ id: campaignId }) },
        )
        const stale = (await staleResponse.json()).campaign
        expect(stale).toMatchObject({
            state: 'running',
            operations: {
                unfinalizedLinkedCalls: 1,
                staleUnfinalizedCalls: [{
                    callId: immediatelyVisible.members[0].attempts[0].call.id,
                    targetRef: 'link-reconcile-flaky',
                    attemptState: 'running',
                    failureCode: 'dial_reconciliation_error',
                    recoveryReason: 'expired_claim',
                }],
            },
        })
        const durable = await database.$queryRawUnsafe<Array<{
            campaignsCompleted: number
            attemptsRunning: number
            dialExecutionCount: number
            calls: number
            activeCalls: number
            transcriptMessages: number
        }>>(`
            SELECT
              (SELECT COUNT(*)::int FROM "AiCallCampaign" WHERE "id"=$1 AND "state"='completed')
                AS "campaignsCompleted",
              (SELECT COUNT(*)::int FROM "AiCallCampaignAttempt" WHERE "campaignId"=$1 AND "state"='running')
                AS "attemptsRunning",
              (SELECT MAX("dialExecutionCount")::int FROM "AiCallCampaignAttempt" WHERE "campaignId"=$1)
                AS "dialExecutionCount",
              (SELECT COUNT(*)::int FROM "Call" phone_call JOIN "AiCallCampaignAttempt" attempt
                 ON attempt."callId"=phone_call."id" WHERE attempt."campaignId"=$1) AS "calls",
              (SELECT COUNT(*)::int FROM "Call" phone_call JOIN "AiCallCampaignAttempt" attempt
                 ON attempt."callId"=phone_call."id"
                WHERE attempt."campaignId"=$1 AND phone_call."endedAt" IS NULL) AS "activeCalls",
              (SELECT COUNT(*)::int FROM "AiCallMessage" message JOIN "AiCallCampaignAttempt" attempt
                 ON attempt."callId"=message."callId" WHERE attempt."campaignId"=$1) AS "transcriptMessages"
        `, campaignId)
        expect(durable).toEqual([{
            campaignsCompleted: 0,
            attemptsRunning: 1,
            dialExecutionCount: 3,
            calls: 1,
            activeCalls: 1,
            transcriptMessages: 0,
        }])

        await expect(runAiCallCampaignRuntimeCycleV1()).resolves.toMatchObject({
            kind: 'completed', memberState: 'succeeded', campaignState: 'completed',
        })
        const recoveredResponse = await getCampaign(
            request(`/api/ai-calls/campaigns/${campaignId}?memberLimit=10`),
            { params: Promise.resolve({ id: campaignId }) },
        )
        const recovered = (await recoveredResponse.json()).campaign
        expect(recovered).toMatchObject({
            state: 'completed',
            progress: { succeeded: 1, completed: 1 },
            operations: {
                activeLeases: 0,
                staleClaims: 0,
                unfinalizedLinkedCalls: 0,
                staleUnfinalizedCalls: [],
            },
        })
        expect(recovered.members[0]).toMatchObject({
            state: 'succeeded',
            failureCode: null,
            attempts: [{
                state: 'succeeded',
                dispatchState: 'accepted',
                failureCode: null,
                call: { endedAt: expect.any(String), sessionStatus: 'ended' },
            }],
        })
        await expect(database.$queryRawUnsafe<Array<{
            calls: number
            activeCalls: number
            transcriptMessages: number
            dialExecutionCount: number
        }>>(`
            SELECT COUNT(DISTINCT phone_call."id")::int AS "calls",
                   COUNT(DISTINCT phone_call."id") FILTER (WHERE phone_call."endedAt" IS NULL)::int AS "activeCalls",
                   COUNT(message."id")::int AS "transcriptMessages",
                   MAX(attempt."dialExecutionCount")::int AS "dialExecutionCount"
            FROM "AiCallCampaignAttempt" attempt
            JOIN "Call" phone_call ON phone_call."id"=attempt."callId"
            LEFT JOIN "AiCallMessage" message ON message."callId"=phone_call."id"
            WHERE attempt."campaignId"=$1
        `, campaignId)).resolves.toEqual([{
            calls: 1,
            activeCalls: 0,
            transcriptMessages: 2,
            dialExecutionCount: 4,
        }])

        const recoveredCallId = recovered.members[0].attempts[0].call.id as string
        const recoveredAttemptId = recovered.members[0].attempts[0].id as string
        await database.$executeRawUnsafe(`
            UPDATE "AiCallCampaignAttempt"
            SET "state"='permanent_failure', "failureCode"='legacy_terminal_link_orphan',
                "claimUntil"=NULL
            WHERE "id"=$1
        `, recoveredAttemptId)
        await database.$executeRawUnsafe(`
            UPDATE "Call"
            SET "status"='active', "aiSessionStatus"='active', "endedAt"=NULL
            WHERE "id"=$1
        `, recoveredCallId)
        const defensiveResponse = await getCampaign(
            request(`/api/ai-calls/campaigns/${campaignId}?memberLimit=10`),
            { params: Promise.resolve({ id: campaignId }) },
        )
        await expect(defensiveResponse.json()).resolves.toMatchObject({
            campaign: {
                operations: {
                    unfinalizedLinkedCalls: 1,
                    staleUnfinalizedCalls: [{
                        callId: recoveredCallId,
                        attemptState: 'permanent_failure',
                        failureCode: 'legacy_terminal_link_orphan',
                        recoveryReason: 'terminal_link_orphan',
                        claimUntil: null,
                    }],
                },
            },
        })
        await database.$executeRawUnsafe(`
            UPDATE "AiCallCampaignAttempt"
            SET "state"='succeeded', "failureCode"=NULL
            WHERE "id"=$1
        `, recoveredAttemptId)
        await database.$executeRawUnsafe(`
            UPDATE "Call"
            SET "status"='completed', "aiSessionStatus"='ended', "endedAt"=COALESCE("startedAt",now())
            WHERE "id"=$1
        `, recoveredCallId)
    }, 30_000)

    it('recovers a partial create and fences delayed or colliding control-command replays', async () => {
        const actor = { id: 'identity-access:integration-admin-session' }
        const partialCommand = {
            ...command,
            requestId: `${PREFIX}:partial-request`,
            name: `${PREFIX}:partial-campaign`,
            scheduledAt: '2099-01-01T00:00:00.000Z',
            audience: {
                sourceRef: `${PREFIX}:partial-explicit-fixture`,
                sourceVersion: 'immutable-v1',
                members: [{ targetRef: 'partial', phoneE164: '+79990000201', label: 'Partial create' }],
            },
        }
        const prepared = prepareAiCallCampaignCreateV1(partialCommand, actor)
        const scenario = await (prisma as any).aiCallScenario.findFirst({
            where: { id: partialCommand.scenarioId, isActive: true },
            include: { project: { select: { name: true } } },
        })
        const frozenScenario = prepareAiCallCampaignScenarioSnapshotV1({
            ...scenario,
            description: scenario.description ?? undefined,
            questions: scenario.questions ?? [],
            outcomeSchema: scenario.outcomeSchema ?? undefined,
            greetingVariants: scenario.greetingVariants ?? undefined,
            fragments: scenario.fragments ?? undefined,
            projectName: scenario.project?.name ?? null,
        })
        await aiCallCampaignPrismaPort.createDraft({
            campaignId: prepared.campaignId,
            identityKey: prepared.identityKey,
            commandFingerprint: prepared.commandFingerprint,
            name: partialCommand.name,
            ...frozenScenario,
            concurrentLimit: partialCommand.concurrentLimit,
            ratePerMinute: partialCommand.ratePerMinute,
            maxAttempts: partialCommand.maxAttempts,
            retryBaseMs: partialCommand.retryBaseMs,
            retryMaxMs: partialCommand.retryMaxMs,
        })
        await aiCallCampaignPrismaPort.freezeAudience(
            prepared.campaignId,
            prepared.audienceInput,
            new Date('2026-09-01T00:00:00.000Z'),
        )
        const recovered = await createCampaign(request('/api/ai-calls/campaigns', 'POST', partialCommand))
        expect(recovered.status).toBe(201)
        await expect(recovered.json()).resolves.toMatchObject({
            campaign: { id: prepared.campaignId, state: 'scheduled', progress: { total: 1 } },
        })
        const changedPartial = await createCampaign(request('/api/ai-calls/campaigns', 'POST', {
            ...partialCommand,
            audience: {
                ...partialCommand.audience,
                members: [{ ...partialCommand.audience.members[0], phoneE164: '+79990000202' }],
            },
        }))
        expect(changedPartial.status).toBe(409)

        await aiCallCampaignPrismaPort.startDueCampaigns(new Date('2100-01-01T00:00:00.000Z'))
        const context = { params: Promise.resolve({ id: prepared.campaignId }) }
        const control = (requestId: string, action: 'pause' | 'resume' | 'cancel') => ({
            contract: CONTROL_AI_CALL_CAMPAIGN_COMMAND_V1,
            campaignId: prepared.campaignId,
            requestId,
            action,
        })
        const pause = control(`${PREFIX}:control-pause`, 'pause')
        expect((await controlCampaign(
            request(`/api/ai-calls/campaigns/${prepared.campaignId}`, 'PATCH', pause), context,
        )).status).toBe(200)
        const resume = control(`${PREFIX}:control-resume`, 'resume')
        expect((await controlCampaign(
            request(`/api/ai-calls/campaigns/${prepared.campaignId}`, 'PATCH', resume), context,
        )).status).toBe(200)
        const delayedPause = await controlCampaign(
            request(`/api/ai-calls/campaigns/${prepared.campaignId}`, 'PATCH', pause), context,
        )
        expect(delayedPause.status).toBe(200)
        await expect(delayedPause.json()).resolves.toMatchObject({ campaign: { state: 'running' } })
        const collision = await controlCampaign(
            request(`/api/ai-calls/campaigns/${prepared.campaignId}`, 'PATCH', {
                ...pause, action: 'cancel',
            }),
            context,
        )
        expect(collision.status).toBe(409)
        await expect(collision.json()).resolves.toMatchObject({ code: 'campaign_command_identity_collision' })
        const detail = await getCampaign(
            request(`/api/ai-calls/campaigns/${prepared.campaignId}?memberLimit=10`), context,
        )
        const body = await detail.json()
        expect(body.campaign.state).toBe('running')
        expect(body.campaign.audit.filter((event: { action: string }) => event.action === 'paused')).toHaveLength(1)
        expect(body.campaign.audit.filter((event: { action: string }) => event.action === 'resumed')).toHaveLength(1)
        const cancel = control(`${PREFIX}:control-cancel`, 'cancel')
        expect((await controlCampaign(
            request(`/api/ai-calls/campaigns/${prepared.campaignId}`, 'PATCH', cancel), context,
        )).status).toBe(200)
    }, 30_000)

    it('reports expired running executions as stale operational work', async () => {
        const staleCommand = {
            ...command,
            requestId: `${PREFIX}:stale-request`,
            name: `${PREFIX}:stale-campaign`,
            scheduledAt: new Date(Date.now() - 1_000).toISOString(),
            audience: {
                sourceRef: `${PREFIX}:stale-explicit-fixture`,
                sourceVersion: 'immutable-v1',
                members: [{ targetRef: 'stale', phoneE164: '+79990000301', label: 'Stale execution' }],
            },
        }
        const created = await createCampaign(request('/api/ai-calls/campaigns', 'POST', staleCommand))
        expect(created.status).toBe(201)
        const campaignId = (await created.json()).campaign.id as string
        const cycleAt = new Date()
        await aiCallCampaignPrismaPort.configureGlobalAdmission({
            concurrentLimit: 1, ratePerMinute: 60_000, now: cycleAt,
        })
        await database.$executeRawUnsafe(`
            UPDATE "AiCallAdmissionControl" SET "nextAdmitAt"=NULL WHERE "id"='global'
        `)
        await aiCallCampaignPrismaPort.startDueCampaigns(cycleAt)
        const claim = await aiCallCampaignPrismaPort.claimNextLaunch({
            workerId: 'stale-monitor-worker', now: cycleAt, leaseMs: 1,
        })
        expect(claim).not.toBeNull()
        const admission = await aiCallCampaignPrismaPort.acquireAdmission({
            claim: claim!, now: cycleAt, leaseMs: 1,
        })
        expect(admission.kind).toBe('acquired')
        if (admission.kind !== 'acquired') throw new Error('expected stale proof admission')
        await aiCallCampaignPrismaPort.markAttemptRunning({
            attemptId: claim!.attemptId,
            claimFence: claim!.claimFence,
            leaseFence: admission.grant.leaseFence,
            now: cycleAt,
        })
        await new Promise((resolve) => setTimeout(resolve, 5))

        const detail = await getCampaign(
            request(`/api/ai-calls/campaigns/${campaignId}?memberLimit=10`),
            { params: Promise.resolve({ id: campaignId }) },
        )
        expect(detail.status).toBe(200)
        await expect(detail.json()).resolves.toMatchObject({
            campaign: { operations: { activeLeases: 0, staleClaims: 1 } },
        })
    }, 30_000)
})
