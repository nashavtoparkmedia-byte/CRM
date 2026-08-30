import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '@/lib/prisma'
import {
    createAiCallCampaignWorkerRuntime,
    type AiCallCampaignDialPort,
    type AiCallCampaignDialRequest,
    type AiCallCampaignDialResult,
} from '../../application/ai-call-campaign-runtime'
import { aiCallCampaignPrismaPort } from './ai-call-campaign-prisma-adapter'

const postgresProof = process.env.YOKO_AI_CALL_CAMPAIGN_POSTGRES_PROOF === '1' ? describe : describe.skip
const BASE = new Date('2026-08-29T16:00:00.000Z')
const PREFIX = 'ai-call-campaign-proof-v1'

interface RawDatabase {
    $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>
    $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>
    $transaction<T>(operation: (tx: RawDatabase) => Promise<T>): Promise<T>
}

const database = prisma as unknown as RawDatabase

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
}

async function cleanup() {
    await database.$executeRawUnsafe('DELETE FROM "AiCallAdmissionLease"')
    await database.$executeRawUnsafe('UPDATE "AiCallCampaignMember" SET "activeAttemptId"=NULL')
    await database.$executeRawUnsafe('DELETE FROM "AiCallCampaignAttempt"')
    await database.$executeRawUnsafe('DELETE FROM "AiCallCampaignMember"')
    await database.$executeRawUnsafe('DELETE FROM "AiCallCampaign"')
    await database.$executeRawUnsafe('DELETE FROM "AiCallAdmissionControl"')
}

function audience(targets: readonly string[]) {
    return {
        sourceKind: 'controlled_fixture',
        sourceRef: `${PREFIX}:fixture`,
        sourceVersion: 'immutable-v1',
        members: targets.map((targetRef, index) => ({
            targetType: 'external' as const,
            targetRef,
            phoneE164: `+7000000${String(index + 1).padStart(4, '0')}`,
            provenance: { fixture: PREFIX, ordinal: index + 1 },
        })),
    }
}

async function prepareCampaign(input: {
    id: string
    targets: readonly string[]
    scheduledAt?: Date
    concurrentLimit?: number
    ratePerMinute?: number
    maxAttempts?: number
    retryBaseMs?: number
}) {
    const scheduledAt = input.scheduledAt ?? BASE
    await aiCallCampaignPrismaPort.createDraft({
        campaignId: input.id,
        identityKey: `${input.id}:identity`,
        name: `Campaign ${input.id}`,
        scenarioRef: `${PREFIX}:scenario`,
        concurrentLimit: input.concurrentLimit ?? 2,
        ratePerMinute: input.ratePerMinute ?? 60,
        maxAttempts: input.maxAttempts ?? 3,
        retryBaseMs: input.retryBaseMs ?? 1_000,
        retryMaxMs: 8_000,
    }, new Date(BASE.getTime() - 2_000))
    await aiCallCampaignPrismaPort.freezeAudience(
        input.id,
        audience(input.targets),
        new Date(BASE.getTime() - 1_000),
    )
    await aiCallCampaignPrismaPort.schedule(input.id, scheduledAt, new Date(BASE.getTime() - 500))
}

class DeterministicFakeDial implements AiCallCampaignDialPort {
    readonly effects = new Map<string, AiCallCampaignDialResult>()
    readonly invocations = new Map<string, number>()
    readonly crashedLaunches = new Set<string>()

    async dial(request: AiCallCampaignDialRequest): Promise<AiCallCampaignDialResult> {
        this.invocations.set(request.launchId, (this.invocations.get(request.launchId) ?? 0) + 1)
        const existing = this.effects.get(request.launchId)
        if (existing) return structuredClone(existing)

        const terminal: AiCallCampaignDialResult['terminal'] = request.targetRef === 'permanent'
            ? { eventId: `result:${request.launchId}`, kind: 'permanent_failure', failureCode: 'DO_NOT_CALL' }
            : request.targetRef === 'retry' && request.attemptNumber === 1
                ? { eventId: `result:${request.launchId}`, kind: 'retryable_failure', failureCode: 'TEMPORARY_PROVIDER_FAILURE' }
                : { eventId: `result:${request.launchId}`, kind: 'success', outcomeCode: 'qualified' }
        const result = { effectRef: `effect:${request.launchId}`, terminal }
        this.effects.set(request.launchId, result)
        if (request.targetRef === 'crash' && !this.crashedLaunches.has(request.launchId)) {
            this.crashedLaunches.add(request.launchId)
            throw new Error('SIMULATED_WORKER_EXIT_AFTER_PROVIDER_ACCEPTANCE')
        }
        return structuredClone(result)
    }
}

postgresProof.sequential('Calling mass-campaign isolated PostgreSQL runtime', () => {
    beforeAll(async () => {
        const tables = await database.$queryRawUnsafe<Array<{ table_name: string }>>(`
            SELECT table_name FROM information_schema.tables
            WHERE table_schema='public' AND table_name LIKE 'AiCall%'
        `)
        const names = tables.map((row) => row.table_name)
        expect(names).toEqual(expect.arrayContaining([
            'AiCallCampaign',
            'AiCallCampaignMember',
            'AiCallCampaignAttempt',
            'AiCallAdmissionControl',
            'AiCallAdmissionLease',
        ]))
    })

    beforeEach(async () => {
        await cleanup()
    })

    it('freezes audience data, fences identity replay and uses bounded selection indexes', async () => {
        const campaignId = `${PREFIX}:immutability`
        const created = await aiCallCampaignPrismaPort.createDraft({
            campaignId,
            identityKey: `${campaignId}:identity`,
            name: 'Immutable audience',
            scenarioRef: `${PREFIX}:scenario`,
            concurrentLimit: 2,
            ratePerMinute: 60,
            maxAttempts: 3,
            retryBaseMs: 1_000,
            retryMaxMs: 8_000,
        }, BASE)
        expect(created.status).toBe('created')
        await expect(aiCallCampaignPrismaPort.createDraft({
            campaignId,
            identityKey: `${campaignId}:identity`,
            name: 'Immutable audience',
            scenarioRef: `${PREFIX}:scenario`,
            concurrentLimit: 2,
            ratePerMinute: 60,
            maxAttempts: 3,
            retryBaseMs: 1_000,
            retryMaxMs: 8_000,
        }, new Date(BASE.getTime() + 1))).resolves.toMatchObject({ status: 'duplicate' })

        const source = audience(['immutable-a', 'immutable-b'])
        const frozen = await aiCallCampaignPrismaPort.freezeAudience(campaignId, source, BASE)
        source.members[0].phoneE164 = '+79999999999'
        await expect(aiCallCampaignPrismaPort.freezeAudience(campaignId, source, BASE))
            .rejects.toMatchObject({ code: 'audience_frozen' })
        const view = await aiCallCampaignPrismaPort.getCampaign(campaignId)
        expect(view?.campaign.audienceFingerprint).toBe(frozen.snapshot.fingerprint)
        expect(view?.members.map((member) => member.phoneE164)).toContain('+70000000001')
        expect(view?.members.map((member) => member.phoneE164)).not.toContain('+79999999999')

        const indexes = await database.$queryRawUnsafe<Array<{ indexname: string }>>(`
            SELECT indexname FROM pg_indexes
            WHERE schemaname='public' AND tablename IN (
                'AiCallCampaign','AiCallCampaignMember','AiCallCampaignAttempt','AiCallAdmissionLease'
            )
        `)
        expect(indexes.map((row) => row.indexname)).toEqual(expect.arrayContaining([
            'AiCallCampaign_state_scheduledAt_createdAt_idx',
            'AiCallCampaignMember_state_nextEligibleAt_id_idx',
            'AiCallCampaignAttempt_state_claimUntil_createdAt_idx',
            'AiCallAdmissionLease_releasedAt_leaseUntil_idx',
        ]))
        const plans = await database.$transaction(async (tx) => {
            await tx.$executeRawUnsafe('SET LOCAL enable_seqscan=off')
            const scheduler = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(`
                EXPLAIN (FORMAT JSON)
                SELECT "id" FROM "AiCallCampaign"
                WHERE "state"='scheduled' AND "scheduledAt" <= TIMESTAMPTZ '2026-08-29 16:00:00+00'
                ORDER BY "scheduledAt", "createdAt", "id" LIMIT 25
            `)
            const freshMember = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(`
                EXPLAIN (FORMAT JSON)
                SELECT m."id"
                FROM "AiCallCampaignMember" m
                JOIN "AiCallCampaign" c ON c."id"=m."campaignId"
                WHERE c."state"='running'
                  AND m."state" IN ('pending','retry_wait')
                  AND (m."nextEligibleAt" IS NULL OR m."nextEligibleAt" <= TIMESTAMPTZ '2026-08-29 16:00:00+00')
                  AND m."attemptCount" < c."maxAttempts"
                ORDER BY COALESCE(m."nextEligibleAt",m."createdAt"),m."id" LIMIT 1
            `)
            const recovery = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(`
                EXPLAIN (FORMAT JSON)
                SELECT a."id"
                FROM "AiCallCampaignAttempt" a
                JOIN "AiCallCampaignMember" m ON m."id"=a."memberId"
                JOIN "AiCallCampaign" c ON c."id"=a."campaignId"
                WHERE c."state"='running'
                  AND (
                    (a."state"='waiting' AND m."state"='waiting' AND m."nextEligibleAt" <= TIMESTAMPTZ '2026-08-29 16:00:00+00')
                    OR (a."state"='claimed' AND m."state"='claimed' AND a."claimUntil" <= TIMESTAMPTZ '2026-08-29 16:00:00+00')
                  )
                ORDER BY COALESCE(m."nextEligibleAt",a."claimUntil"),a."createdAt",a."id" LIMIT 1
            `)
            return { scheduler, freshMember, recovery }
        })
        expect(JSON.stringify(plans.scheduler)).toContain('AiCallCampaign_state_scheduledAt_createdAt_idx')
        expect(JSON.stringify(plans.freshMember)).toContain('AiCallCampaignMember_campaign_state_nextEligibleAt_id_idx')
        expect(JSON.stringify(plans.recovery)).toMatch(
            /AiCallCampaignAttempt_(?:campaign_state_createdAt_idx|member_attempt_key)/,
        )
    })

    it('starts and claims once under genuine scheduler and member races, then fences pause/cancel', async () => {
        const campaignId = `${PREFIX}:claim-race`
        await prepareCampaign({ id: campaignId, targets: ['only-member'] })
        const [leftStart, rightStart] = await Promise.all([
            aiCallCampaignPrismaPort.startDueCampaigns(BASE),
            aiCallCampaignPrismaPort.startDueCampaigns(BASE),
        ])
        expect(leftStart.length + rightStart.length).toBe(1)

        await aiCallCampaignPrismaPort.pause(campaignId, BASE)
        await expect(aiCallCampaignPrismaPort.claimNextLaunch({ workerId: 'paused-worker', now: BASE, leaseMs: 1_000 }))
            .resolves.toBeNull()
        await aiCallCampaignPrismaPort.resume(campaignId, BASE)
        const [left, right] = await Promise.all([
            aiCallCampaignPrismaPort.claimNextLaunch({ workerId: 'worker-a', now: BASE, leaseMs: 1_000 }),
            aiCallCampaignPrismaPort.claimNextLaunch({ workerId: 'worker-b', now: BASE, leaseMs: 1_000 }),
        ])
        expect([left, right].filter(Boolean)).toHaveLength(1)
        const claim = left ?? right
        await aiCallCampaignPrismaPort.deferClaim({
            attemptId: claim!.attemptId,
            claimFence: claim!.claimFence,
            retryAt: new Date(BASE.getTime() + 60_000),
            now: BASE,
        })
        await expect(aiCallCampaignPrismaPort.cancel(campaignId, BASE)).resolves.toMatchObject({ status: 'cancelled' })
        const view = await aiCallCampaignPrismaPort.getCampaign(campaignId)
        expect(view?.campaign.state).toBe('cancelled')
        expect(view?.members[0].state).toBe('cancelled')
        expect(view?.attempts[0].state).toBe('cancelled')
    })

    it('atomically grants only the final global slot to one of two workers', async () => {
        const campaignId = `${PREFIX}:concurrency`
        await prepareCampaign({
            id: campaignId,
            targets: ['concurrency-a', 'concurrency-b'],
            concurrentLimit: 2,
            ratePerMinute: 60_000,
        })
        await aiCallCampaignPrismaPort.configureGlobalAdmission({ concurrentLimit: 1, ratePerMinute: 60_000, now: BASE })

        const entered = deferred()
        const release = deferred()
        let dialCount = 0
        const holdingDial: AiCallCampaignDialPort = {
            async dial(request) {
                dialCount += 1
                entered.resolve()
                await release.promise
                return {
                    effectRef: `effect:${request.launchId}`,
                    terminal: { eventId: `result:${request.launchId}`, kind: 'success', outcomeCode: 'qualified' },
                }
            },
        }
        let nowMs = BASE.getTime()
        const clock = () => new Date(nowMs)
        const workerA = createAiCallCampaignWorkerRuntime({
            dial: holdingDial, workerId: 'slot-worker-a', clock, claimLeaseMs: 5_000, admissionLeaseMs: 5_000,
        })
        const workerB = createAiCallCampaignWorkerRuntime({
            dial: holdingDial, workerId: 'slot-worker-b', clock, claimLeaseMs: 5_000, admissionLeaseMs: 5_000,
        })
        const active = workerA()
        await entered.promise
        const blocked = await workerB()
        expect(blocked).toMatchObject({ kind: 'blocked', reason: 'global_concurrency' })
        expect(dialCount).toBe(1)
        release.resolve()
        await expect(active).resolves.toMatchObject({ kind: 'completed' })
        nowMs += 5_001
        await expect(workerB()).resolves.toMatchObject({ kind: 'completed' })
        const view = await aiCallCampaignPrismaPort.getCampaign(campaignId)
        expect(view?.progress.succeeded).toBe(2)
        expect(view?.campaign.state).toBe('completed')
    })

    it('serializes two workers racing for the final campaign-local slot', async () => {
        const campaignId = `${PREFIX}:campaign-concurrency`
        await prepareCampaign({
            id: campaignId,
            targets: ['campaign-slot-a', 'campaign-slot-b'],
            concurrentLimit: 1,
            ratePerMinute: 60_000,
        })
        await aiCallCampaignPrismaPort.configureGlobalAdmission({ concurrentLimit: 2, ratePerMinute: 60_000, now: BASE })
        await aiCallCampaignPrismaPort.startDueCampaigns(BASE)
        const claims = (await Promise.all([
            aiCallCampaignPrismaPort.claimNextLaunch({ workerId: 'campaign-worker-a', now: BASE, leaseMs: 5_000 }),
            aiCallCampaignPrismaPort.claimNextLaunch({ workerId: 'campaign-worker-b', now: BASE, leaseMs: 5_000 }),
        ])).filter((claim) => claim !== null)
        expect(claims).toHaveLength(2)
        const decisions = await Promise.all(claims.map((claim) => aiCallCampaignPrismaPort.acquireAdmission({
            claim,
            now: BASE,
            leaseMs: 5_000,
        })))
        expect(decisions.filter((decision) => decision.kind === 'acquired')).toHaveLength(1)
        expect(decisions.filter((decision) => decision.kind === 'blocked')).toEqual([
            expect.objectContaining({ reason: 'campaign_concurrency' }),
        ])
    })

    it('rolls back provider settlement, member state and capacity release as one unit', async () => {
        const campaignId = `${PREFIX}:settlement-rollback`
        await prepareCampaign({ id: campaignId, targets: ['rollback'] })
        await aiCallCampaignPrismaPort.configureGlobalAdmission({ concurrentLimit: 1, ratePerMinute: 60_000, now: BASE })
        await aiCallCampaignPrismaPort.startDueCampaigns(BASE)
        const claim = await aiCallCampaignPrismaPort.claimNextLaunch({
            workerId: 'rollback-worker', now: BASE, leaseMs: 5_000,
        })
        expect(claim).not.toBeNull()
        const admission = await aiCallCampaignPrismaPort.acquireAdmission({ claim: claim!, now: BASE, leaseMs: 5_000 })
        expect(admission.kind).toBe('acquired')
        if (admission.kind !== 'acquired') throw new Error('expected admission')

        await database.$executeRawUnsafe(`
            CREATE OR REPLACE FUNCTION pg_temp.fail_ai_call_campaign_member_settlement()
            RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                IF NEW."state" = 'succeeded' THEN
                    RAISE EXCEPTION 'INJECTED_CAMPAIGN_SETTLEMENT_FAILURE';
                END IF;
                RETURN NEW;
            END
            $$
        `)
        await database.$executeRawUnsafe(`
            CREATE TRIGGER "AiCallCampaignMember_settlement_failure_test"
            BEFORE UPDATE ON "AiCallCampaignMember"
            FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_ai_call_campaign_member_settlement()
        `)
        try {
            await expect(aiCallCampaignPrismaPort.recordAttemptResult({
                attemptId: claim!.attemptId,
                resultEventId: `result:${claim!.launchId}`,
                kind: 'success',
                outcomeCode: 'qualified',
                claimFence: claim!.claimFence,
                leaseFence: admission.grant.leaseFence,
                dialEffectRef: `effect:${claim!.launchId}`,
                now: BASE,
            })).rejects.toThrow('INJECTED_CAMPAIGN_SETTLEMENT_FAILURE')
        } finally {
            await database.$executeRawUnsafe('DROP TRIGGER IF EXISTS "AiCallCampaignMember_settlement_failure_test" ON "AiCallCampaignMember"')
        }

        const state = await database.$queryRawUnsafe<Array<{
            attemptState: string
            resultEventId: string | null
            dialEffectRef: string | null
            memberState: string
            releasedAt: Date | null
        }>>(`
            SELECT a."state" AS "attemptState", a."resultEventId", a."dialEffectRef",
                   m."state" AS "memberState", l."releasedAt"
            FROM "AiCallCampaignAttempt" a
            JOIN "AiCallCampaignMember" m ON m."id"=a."memberId"
            JOIN "AiCallAdmissionLease" l ON l."attemptId"=a."id"
            WHERE a."id"=$1
        `, claim!.attemptId)
        expect(state[0]).toMatchObject({
            attemptState: 'claimed',
            resultEventId: null,
            dialEffectRef: null,
            memberState: 'claimed',
            releasedAt: null,
        })
    })

    it('converges a multi-member campaign across rate waits, retry, replay and worker restart', async () => {
        const campaignId = `${PREFIX}:controlled-e2e`
        await prepareCampaign({
            id: campaignId,
            targets: ['success', 'retry', 'permanent', 'crash'],
            concurrentLimit: 2,
            ratePerMinute: 60,
            maxAttempts: 2,
            retryBaseMs: 1_000,
        })
        await aiCallCampaignPrismaPort.configureGlobalAdmission({ concurrentLimit: 2, ratePerMinute: 60, now: BASE })
        const dial = new DeterministicFakeDial()
        let nowMs = BASE.getTime()
        const clock = () => new Date(nowMs)
        const workers = [
            createAiCallCampaignWorkerRuntime({
                dial, workerId: 'e2e-worker-a', clock, claimLeaseMs: 500, admissionLeaseMs: 500,
            }),
            createAiCallCampaignWorkerRuntime({
                dial, workerId: 'e2e-worker-b', clock, claimLeaseMs: 500, admissionLeaseMs: 500,
            }),
            createAiCallCampaignWorkerRuntime({
                dial, workerId: 'e2e-worker-restarted', clock, claimLeaseMs: 500, admissionLeaseMs: 500,
            }),
        ]
        const blockReasons = new Set<string>()
        let observedCrash = false
        for (let tick = 0; tick < 30; tick += 1) {
            const activeWorkers = observedCrash ? [workers[1], workers[2]] : [workers[0], workers[1]]
            const results = await Promise.allSettled(activeWorkers.map((worker) => worker()))
            for (const result of results) {
                if (result.status === 'rejected') {
                    expect(String(result.reason)).toContain('SIMULATED_WORKER_EXIT_AFTER_PROVIDER_ACCEPTANCE')
                    observedCrash = true
                } else if (result.value.kind === 'blocked') blockReasons.add(result.value.reason)
            }
            const view = await aiCallCampaignPrismaPort.getCampaign(campaignId)
            if (view?.campaign.state === 'completed') break
            nowMs += 1_000
        }

        const view = await aiCallCampaignPrismaPort.getCampaign(campaignId)
        expect(observedCrash).toBe(true)
        expect(blockReasons).toContain('rate')
        expect(view?.campaign.state).toBe('completed')
        expect(view?.progress).toMatchObject({ total: 4, succeeded: 3, failed: 1 })
        expect(view?.attempts).toHaveLength(5)
        expect(view?.attempts.every((attempt) => (
            ['succeeded', 'retryable_failure', 'permanent_failure'].includes(attempt.state)
            && attempt.startedAt instanceof Date
            && attempt.completedAt instanceof Date
        ))).toBe(true)
        expect(view?.attempts.some((attempt) => attempt.claimRevision > 1)).toBe(true)
        expect(dial.effects.size).toBe(5)
        expect([...dial.invocations.values()].reduce((sum, count) => sum + count, 0)).toBe(6)
        expect([...dial.invocations.values()].filter((count) => count > 1)).toEqual([2])

        const succeeded = view!.attempts.find((attempt) => attempt.state === 'succeeded')!
        await expect(aiCallCampaignPrismaPort.recordAttemptResult({
            attemptId: succeeded.id,
            resultEventId: `result:${succeeded.launchId}`,
            kind: 'success',
            outcomeCode: 'qualified',
            now: new Date(nowMs + 1),
        })).resolves.toMatchObject({ status: 'duplicate' })
        await expect(aiCallCampaignPrismaPort.recordAttemptResult({
            attemptId: succeeded.id,
            resultEventId: `conflict:${succeeded.launchId}`,
            kind: 'success',
            outcomeCode: 'qualified',
            now: new Date(nowMs + 1),
        })).rejects.toMatchObject({ code: 'attempt_terminal_conflict' })
    })
})
