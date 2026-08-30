import { NextRequest } from 'next/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
    CONTROL_AI_CALL_CAMPAIGN_COMMAND_V1,
    CREATE_AI_CALL_CAMPAIGN_COMMAND_V1,
} from '@/contracts/calling/v1'
import { prisma } from '@/lib/prisma'

const mocks = vi.hoisted(() => ({
    currentUser: vi.fn(),
}))

vi.mock('@/modules/identity-access/public/v1/user-directory', () => ({
    getCurrentUserIdentityV1: mocks.currentUser,
}))

import { GET as listCampaigns, POST as createCampaign } from '@/app/api/ai-calls/campaigns/route'
import { GET as getCampaign, PATCH as controlCampaign } from '@/app/api/ai-calls/campaigns/[id]/route'
import { prepareAiCallCampaignCreateV1 } from '../../application/ai-call-campaign-product-operations'
import { runAiCallCampaignRuntimeCycleV1 } from '../../application/ai-call-campaign-runtime-startup'
import { aiCallCampaignPrismaPort } from './ai-call-campaign-prisma-adapter'

const productProof = process.env.YOKO_AI_CALL_CAMPAIGN_PRODUCT_POSTGRES_PROOF === '1'
    ? describe
    : describe.skip
const PREFIX = 'ai-call-campaign-product-proof-v1'
const projectId = `${PREFIX}:project`
const scenarioId = `${PREFIX}:scenario`

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
        mocks.currentUser.mockResolvedValue({ id: `${PREFIX}:admin`, role: 'Администратор' })
        vi.stubEnv('AI_CALL_CAMPAIGN_RUNTIME_MODE', 'simulated')
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
            },
        })
    })

    afterAll(async () => {
        await cleanup()
        vi.unstubAllEnvs()
    })

    it('runs actual routes and the simulated callback/finalization stack without duplicate logical effects', async () => {
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
        })
        const attempts = detail.members.flatMap((member: any) => member.attempts)
        expect(attempts).toHaveLength(5)
        expect(new Set(attempts.map((attempt: any) => attempt.launchId)).size).toBe(5)
        expect(new Set(attempts.map((attempt: any) => attempt.call?.id)).size).toBe(5)
        expect(attempts.every((attempt: any) => attempt.providerEffectRef?.startsWith('simulated:'))).toBe(true)
        expect(attempts.every((attempt: any) => attempt.call?.transcript?.includes('Controlled simulated'))).toBe(true)
        expect(attempts.every((attempt: any) => attempt.call?.followUpState === 'not_required')).toBe(true)
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
        })

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

    it('recovers a partial create and fences delayed or colliding control-command replays', async () => {
        const actor = { id: `${PREFIX}:admin` }
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
        await aiCallCampaignPrismaPort.createDraft({
            campaignId: prepared.campaignId,
            identityKey: prepared.identityKey,
            commandFingerprint: prepared.commandFingerprint,
            name: partialCommand.name,
            scenarioRef: partialCommand.scenarioId,
            concurrentLimit: partialCommand.concurrentLimit,
            ratePerMinute: partialCommand.ratePerMinute,
            maxAttempts: partialCommand.maxAttempts,
            retryBaseMs: partialCommand.retryBaseMs,
            retryMaxMs: partialCommand.retryMaxMs,
        })
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
