import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '@/lib/prisma'
import {
    createAiCallCampaignWorkerRuntime,
    type AiCallCampaignDialPort,
    type AiCallCampaignDialRequest,
    type AiCallCampaignDialResult,
} from '../../application/ai-call-campaign-runtime'
import { freezeAiCallCampaignScenarioSnapshot } from '../../application/ai-call-campaign'
import { aiCallCampaignPrismaPort } from './ai-call-campaign-prisma-adapter'
import { aiCallCampaignProductPrismaPort } from './ai-call-campaign-product-prisma-adapter'

const postgresProof = process.env.YOKO_AI_CALL_CAMPAIGN_POSTGRES_PROOF === '1' ? describe : describe.skip
const BASE = new Date('2026-08-29T16:00:00.000Z')
const PREFIX = 'ai-call-campaign-proof-v1'
const FROZEN_SCENARIO = freezeAiCallCampaignScenarioSnapshot(`${PREFIX}:scenario`, {
    version: 1,
    scenarioId: `${PREFIX}:scenario`,
    name: 'Controlled PostgreSQL proof scenario',
    description: null,
    systemPrompt: 'Controlled proof only.',
    questions: [],
    targetDurationSec: null,
    outcomeSchema: null,
    greetingVariants: null,
    fragments: null,
    projectId: null,
    projectName: null,
})

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

async function waitForActiveSql(fragment: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const rows = await database.$queryRawUnsafe<Array<{ count: number }>>(`
            SELECT COUNT(*)::int AS "count"
            FROM pg_stat_activity
            WHERE pid <> pg_backend_pid()
              AND datname = current_database()
              AND state = 'active'
              AND query LIKE $1
        `, `%${fragment}%`)
        if ((rows[0]?.count ?? 0) > 0) return
        await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error(`timed out waiting for active PostgreSQL statement: ${fragment}`)
}

function settledFailures(results: readonly PromiseSettledResult<unknown>[]): string[] {
    return results.flatMap((result) => result.status === 'rejected'
        ? [String(result.reason instanceof Error ? result.reason.stack ?? result.reason.message : result.reason)]
        : [])
}

async function cleanup() {
    await database.$executeRawUnsafe('DELETE FROM "AiCallCampaignAuditEvent"')
    await database.$executeRawUnsafe('DELETE FROM "AiCallAdmissionLease"')
    await database.$executeRawUnsafe('UPDATE "AiCallCampaignMember" SET "activeAttemptId"=NULL')
    await database.$executeRawUnsafe('DELETE FROM "AiCallCampaignAttempt"')
    await database.$executeRawUnsafe('DELETE FROM "Call" WHERE "id" LIKE $1', `${PREFIX}:%`)
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
        ...FROZEN_SCENARIO,
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

    async reconcile(request: AiCallCampaignDialRequest): Promise<AiCallCampaignDialResult | null> {
        this.invocations.set(request.launchId, (this.invocations.get(request.launchId) ?? 0) + 1)
        return structuredClone(this.effects.get(request.launchId) ?? null)
    }

    async dispatch(request: AiCallCampaignDialRequest): Promise<AiCallCampaignDialResult> {
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
            WHERE table_schema=current_schema() AND table_name LIKE 'AiCall%'
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
            ...FROZEN_SCENARIO,
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
            ...FROZEN_SCENARIO,
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
            WHERE schemaname=current_schema() AND tablename IN (
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
            // On an intentionally tiny proof dataset PostgreSQL may otherwise
            // choose a whole-index bitmap scan over the bounded composite
            // index. Disable bitmap plans here for the same reason seqscan is
            // disabled: prove that the production predicate is backed by the
            // expected ordered btree path, independent of proof-table size.
            await tx.$executeRawUnsafe('SET LOCAL enable_bitmapscan=off')
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
                WHERE a."campaignId"=$1
                  AND (
                    (c."state"='running'
                     AND a."state"='waiting' AND m."state"='waiting'
                     AND m."nextEligibleAt" <= TIMESTAMPTZ '2026-08-29 16:00:00+00')
                    OR
                    (c."state" IN ('running','paused','cancelling')
                     AND (c."state"='running' OR a."dispatchState" <> 'not_dispatched')
                     AND (
                       (a."state"='claimed' AND m."state"='claimed'
                        AND a."claimUntil" <= TIMESTAMPTZ '2026-08-29 16:00:00+00')
                       OR (a."state"='running' AND m."state"='running'
                           AND a."claimUntil" <= TIMESTAMPTZ '2026-08-29 16:00:00+00')
                     )
                     AND NOT EXISTS (
                       SELECT 1 FROM "AiCallAdmissionLease" lease
                       WHERE lease."attemptId"=a."id" AND lease."releasedAt" IS NULL
                         AND lease."leaseUntil">TIMESTAMPTZ '2026-08-29 16:00:00+00'
                     ))
                  )
                ORDER BY COALESCE(m."nextEligibleAt",a."claimUntil"),a."createdAt",a."id" LIMIT 1
            `, campaignId)
            return { scheduler, freshMember, recovery }
        })
        expect(JSON.stringify(plans.scheduler)).toContain('AiCallCampaign_state_scheduledAt_createdAt_idx')
        expect(JSON.stringify(plans.freshMember)).toMatch(
            /AiCallCampaignMember_(?:campaign_)?state_nextEligibleAt_id_idx/,
        )
        expect(JSON.stringify(plans.recovery)).toMatch(
            /AiCallCampaignAttempt_(?:campaign_state_createdAt_idx|member_attempt_key)/,
        )
    })

    it('freezes the accepted 10000-member boundary atomically with concurrent exact replay', async () => {
        const campaignId = `${PREFIX}:maximum-audience`
        await aiCallCampaignPrismaPort.createDraft({
            campaignId,
            identityKey: `${campaignId}:identity`,
            name: 'Maximum accepted audience',
            ...FROZEN_SCENARIO,
            concurrentLimit: 20,
            ratePerMinute: 600,
            maxAttempts: 3,
            retryBaseMs: 1_000,
            retryMaxMs: 8_000,
        }, BASE)
        const maximumAudience = {
            sourceKind: 'controlled_fixture',
            sourceRef: `${PREFIX}:maximum-audience`,
            sourceVersion: 'immutable-v1',
            members: Array.from({ length: 10_000 }, (_, index) => ({
                targetType: 'external' as const,
                targetRef: `bulk-${String(index).padStart(5, '0')}`,
                phoneE164: `+79${String(index + 1).padStart(9, '0')}`,
                provenance: { fixture: PREFIX, ordinal: index + 1 },
            })),
        }
        await database.$executeRawUnsafe(`
            CREATE OR REPLACE FUNCTION "ai_call_campaign_audience_failure_test_v1"()
            RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                IF NEW."targetRef" = 'bulk-09999' THEN
                    RAISE EXCEPTION 'INJECTED_MAXIMUM_AUDIENCE_FAILURE';
                END IF;
                RETURN NEW;
            END
            $$
        `)
        await database.$executeRawUnsafe(`
            CREATE TRIGGER "AiCallCampaignMember_maximum_audience_failure_test"
            BEFORE INSERT ON "AiCallCampaignMember"
            FOR EACH ROW EXECUTE FUNCTION "ai_call_campaign_audience_failure_test_v1"()
        `)
        try {
            await expect(aiCallCampaignPrismaPort.freezeAudience(campaignId, maximumAudience, BASE))
                .rejects.toThrow('INJECTED_MAXIMUM_AUDIENCE_FAILURE')
        } finally {
            await database.$executeRawUnsafe(`
                DROP TRIGGER IF EXISTS "AiCallCampaignMember_maximum_audience_failure_test"
                ON "AiCallCampaignMember"
            `)
            await database.$executeRawUnsafe(`
                DROP FUNCTION IF EXISTS "ai_call_campaign_audience_failure_test_v1"()
            `)
        }
        await expect(database.$queryRawUnsafe<Array<{ members: number; state: string }>>(`
            SELECT COUNT(m."id")::int AS members, c."state"
            FROM "AiCallCampaign" c
            LEFT JOIN "AiCallCampaignMember" m ON m."campaignId"=c."id"
            WHERE c."id"=$1 GROUP BY c."id"
        `, campaignId)).resolves.toEqual([{ members: 0, state: 'draft' }])

        const [left, right] = await Promise.all([
            aiCallCampaignPrismaPort.freezeAudience(campaignId, maximumAudience, BASE),
            aiCallCampaignPrismaPort.freezeAudience(campaignId, structuredClone(maximumAudience), BASE),
        ])
        expect([left.status, right.status].sort()).toEqual(['duplicate', 'frozen'])
        expect(left.snapshot.fingerprint).toBe(right.snapshot.fingerprint)
        await expect(database.$queryRawUnsafe<Array<{ members: number; distinctFingerprints: number }>>(`
            SELECT COUNT(*)::int AS members,
                   COUNT(DISTINCT "snapshotFingerprint")::int AS "distinctFingerprints"
            FROM "AiCallCampaignMember" WHERE "campaignId"=$1
        `, campaignId)).resolves.toEqual([{ members: 10_000, distinctFingerprints: 10_000 }])
        const campaign = await aiCallCampaignPrismaPort.getCampaign(campaignId)
        expect(campaign?.campaign.audienceFingerprint).toBe(left.snapshot.fingerprint)
    }, 60_000)

    it('rejects malformed frozen scenario identities at the PostgreSQL boundary', async () => {
        const invalidSnapshots: Array<{ label: string; snapshot: unknown; scenarioRef?: string; fingerprint?: string }> = [
            { label: 'empty', snapshot: {} },
            { label: 'missing-version', snapshot: { scenarioId: `${PREFIX}:scenario`, outcomeSchema: null } },
            { label: 'missing-id', snapshot: { version: 1, outcomeSchema: null } },
            { label: 'null-id', snapshot: { version: 1, scenarioId: null, outcomeSchema: null } },
            { label: 'string-version', snapshot: { version: '1', scenarioId: `${PREFIX}:scenario`, outcomeSchema: null } },
            { label: 'mismatched-id', snapshot: { version: 1, scenarioId: `${PREFIX}:other`, outcomeSchema: null } },
            { label: 'missing-outcome-schema', snapshot: { version: 1, scenarioId: `${PREFIX}:scenario` } },
            {
                label: 'malformed-fingerprint',
                snapshot: { version: 1, scenarioId: `${PREFIX}:scenario`, outcomeSchema: null },
                fingerprint: 'A'.repeat(64),
            },
        ]
        for (const [index, invalid] of invalidSnapshots.entries()) {
            await expect(database.$executeRawUnsafe(`
                INSERT INTO "AiCallCampaign" (
                    "id", "identityKey", "payloadFingerprint", "name", "scenarioRef",
                    "scenarioSnapshot", "scenarioFingerprint", "concurrentLimit", "ratePerMinute",
                    "maxAttempts", "retryBaseMs", "retryMaxMs"
                ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,1,1,1,1,1)
            `,
            `${PREFIX}:invalid-snapshot:${index}`,
            `${PREFIX}:invalid-snapshot-identity:${index}`,
            'b'.repeat(64),
            invalid.label,
            invalid.scenarioRef ?? `${PREFIX}:scenario`,
            JSON.stringify(invalid.snapshot),
            invalid.fingerprint ?? 'a'.repeat(64)))
                .rejects.toThrow('AiCallCampaign_scenarioSnapshot_identity_check')
        }
        await expect(database.$queryRawUnsafe<Array<{ count: number }>>(`
            SELECT COUNT(*)::int AS count FROM "AiCallCampaign" WHERE "id" LIKE $1
        `, `${PREFIX}:invalid-snapshot:%`)).resolves.toEqual([{ count: 0 }])
    })

    it('rejects cross-aggregate attempt, active-attempt and admission-lease links', async () => {
        const campaignA = `${PREFIX}:aggregate-a`
        const campaignB = `${PREFIX}:aggregate-b`
        await prepareCampaign({ id: campaignA, targets: ['member-a'] })
        await prepareCampaign({ id: campaignB, targets: ['member-b'] })
        const members = await database.$queryRawUnsafe<Array<{ id: string; campaignId: string }>>(`
            SELECT "id", "campaignId" FROM "AiCallCampaignMember"
            WHERE "campaignId" IN ($1,$2) ORDER BY "campaignId"
        `, campaignA, campaignB)
        const memberA = members.find((member) => member.campaignId === campaignA)!
        const memberB = members.find((member) => member.campaignId === campaignB)!

        await expect(database.$executeRawUnsafe(`
            INSERT INTO "AiCallCampaignAttempt" (
              "id", "campaignId", "memberId", "attemptNumber", "launchId"
            ) VALUES ($1,$2,$3,1,$4)
        `, `${PREFIX}:cross-attempt`, campaignA, memberB.id, `${PREFIX}:cross-launch`))
            .rejects.toThrow('AiCallCampaignAttempt_member_campaign_fkey')

        const attemptA = `${PREFIX}:attempt-a`
        await database.$executeRawUnsafe(`
            INSERT INTO "AiCallCampaignAttempt" (
              "id", "campaignId", "memberId", "attemptNumber", "launchId"
            ) VALUES ($1,$2,$3,1,$4)
        `, attemptA, campaignA, memberA.id, `${PREFIX}:launch-a`)
        await expect(database.$executeRawUnsafe(`
            UPDATE "AiCallCampaignMember" SET "activeAttemptId"=$1 WHERE "id"=$2
        `, attemptA, memberB.id))
            .rejects.toThrow('AiCallCampaignMember_activeAttempt_member_campaign_fkey')
        await expect(database.$executeRawUnsafe(`
            INSERT INTO "AiCallAdmissionLease" (
              "id", "attemptId", "campaignId", "memberId", "workerId", "leaseFence",
              "acquiredAt", "leaseUntil"
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        `, `${PREFIX}:cross-lease`, attemptA, campaignB, memberB.id, 'cross-worker',
        'f'.repeat(64), BASE, new Date(BASE.getTime() + 1_000)))
            .rejects.toThrow('AiCallAdmissionLease_attempt_member_campaign_fkey')
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

    it('keeps campaign-first lock order during a fresh claim racing cancellation', async () => {
        const campaignId = `${PREFIX}:fresh-claim-cancel-lock-order`
        await prepareCampaign({ id: campaignId, targets: ['fresh-race'] })
        await aiCallCampaignPrismaPort.startDueCampaigns(BASE)
        await database.$executeRawUnsafe(`
            CREATE OR REPLACE FUNCTION "ai_call_campaign_fresh_claim_pause_v1"()
            RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                PERFORM pg_sleep(0.4);
                RETURN NEW;
            END
            $$
        `)
        await database.$executeRawUnsafe(`
            CREATE TRIGGER "AiCallCampaignAttempt_fresh_claim_pause_test"
            BEFORE INSERT ON "AiCallCampaignAttempt"
            FOR EACH ROW EXECUTE FUNCTION "ai_call_campaign_fresh_claim_pause_v1"()
        `)
        try {
            const claim = aiCallCampaignPrismaPort.claimNextLaunch({
                workerId: 'fresh-lock-order-worker', now: BASE, leaseMs: 1_000,
            })
            await waitForActiveSql('INSERT INTO "AiCallCampaignAttempt"')
            const cancel = aiCallCampaignPrismaPort.cancel(campaignId, new Date(BASE.getTime() + 1))
            const results = await Promise.allSettled([claim, cancel])
            const failures = settledFailures(results)
            expect(failures.join('\n')).not.toContain('40P01')
            expect(failures.join('\n').toLowerCase()).not.toContain('deadlock detected')
            expect(failures).toEqual([])
            expect(results[0]).toMatchObject({ status: 'fulfilled', value: expect.objectContaining({ campaignId }) })
            expect(results[1]).toMatchObject({ status: 'fulfilled', value: { status: 'cancelled' } })
        } finally {
            await database.$executeRawUnsafe(`
                DROP TRIGGER IF EXISTS "AiCallCampaignAttempt_fresh_claim_pause_test"
                ON "AiCallCampaignAttempt"
            `)
            await database.$executeRawUnsafe(`
                DROP FUNCTION IF EXISTS "ai_call_campaign_fresh_claim_pause_v1"()
            `)
        }
    })

    it('keeps campaign-first lock order during recovered claim audit racing cancellation', async () => {
        const campaignId = `${PREFIX}:recovered-claim-cancel-lock-order`
        await prepareCampaign({ id: campaignId, targets: ['recovery-race'] })
        await aiCallCampaignPrismaPort.startDueCampaigns(BASE)
        const initial = await aiCallCampaignPrismaPort.claimNextLaunch({
            workerId: 'expired-lock-order-worker', now: BASE, leaseMs: 1,
        })
        expect(initial).not.toBeNull()
        await database.$executeRawUnsafe(`
            CREATE OR REPLACE FUNCTION "ai_call_campaign_recovered_claim_pause_v1"()
            RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                IF NEW."action" = 'claim_recovered' THEN
                    PERFORM pg_sleep(0.4);
                END IF;
                RETURN NEW;
            END
            $$
        `)
        await database.$executeRawUnsafe(`
            CREATE TRIGGER "AiCallCampaignAuditEvent_recovered_claim_pause_test"
            BEFORE INSERT ON "AiCallCampaignAuditEvent"
            FOR EACH ROW EXECUTE FUNCTION "ai_call_campaign_recovered_claim_pause_v1"()
        `)
        try {
            const recoveryAt = new Date(BASE.getTime() + 2)
            const recovery = aiCallCampaignPrismaPort.claimNextLaunch({
                workerId: 'recovered-lock-order-worker', now: recoveryAt, leaseMs: 1_000,
            })
            await waitForActiveSql('INSERT INTO "AiCallCampaignAuditEvent"')
            const cancel = aiCallCampaignPrismaPort.cancel(campaignId, new Date(recoveryAt.getTime() + 1))
            const results = await Promise.allSettled([recovery, cancel])
            const failures = settledFailures(results)
            expect(failures.join('\n')).not.toContain('40P01')
            expect(failures.join('\n').toLowerCase()).not.toContain('deadlock detected')
            expect(failures).toEqual([])
            expect(results[0]).toMatchObject({
                status: 'fulfilled',
                value: expect.objectContaining({ campaignId, claimRevision: 2 }),
            })
            expect(results[1]).toMatchObject({ status: 'fulfilled', value: { status: 'cancelled' } })
        } finally {
            await database.$executeRawUnsafe(`
                DROP TRIGGER IF EXISTS "AiCallCampaignAuditEvent_recovered_claim_pause_test"
                ON "AiCallCampaignAuditEvent"
            `)
            await database.$executeRawUnsafe(`
                DROP FUNCTION IF EXISTS "ai_call_campaign_recovered_claim_pause_v1"()
            `)
        }
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
            async reconcile() { return null },
            async dispatch(request) {
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

    it('keeps an admitted dial recoverable while cancellation waits for linked settlement', async () => {
        const campaignId = `${PREFIX}:cancel-during-dial`
        const callId = `${PREFIX}:cancel-during-dial:call`
        await prepareCampaign({ id: campaignId, targets: ['cancel-active'] })
        await aiCallCampaignPrismaPort.configureGlobalAdmission({
            concurrentLimit: 1, ratePerMinute: 60_000, now: BASE,
        })
        const entered = deferred()
        const release = deferred()
        const holdingDial: AiCallCampaignDialPort = {
            async reconcile() { return null },
            async dispatch(request) {
                await prisma.call.create({
                    data: {
                        id: callId,
                        direction: 'outbound',
                        status: 'active',
                        fromNumber: '+70000000000',
                        toNumber: request.phoneE164,
                        managerId: 'system:campaign-cancel-proof',
                        fsUuid: `${PREFIX}:cancel-fs`,
                        startedAt: BASE,
                    },
                })
                entered.resolve()
                await release.promise
                return {
                    callId,
                    effectRef: `effect:${request.launchId}`,
                    terminal: { eventId: `result:${request.launchId}`, kind: 'success' },
                }
            },
        }
        const worker = createAiCallCampaignWorkerRuntime({
            dial: holdingDial,
            workerId: 'cancel-active-worker',
            clock: () => BASE,
            claimLeaseMs: 5_000,
            admissionLeaseMs: 5_000,
        })
        const active = worker()
        await entered.promise
        expect(await aiCallCampaignPrismaPort.cancel(campaignId, BASE)).toMatchObject({ status: 'cancelling' })
        const cancelling = await aiCallCampaignPrismaPort.getCampaign(campaignId)
        expect(cancelling?.campaign.state).toBe('cancelling')
        expect(cancelling?.members[0].state).toBe('running')
        expect(cancelling?.attempts[0].state).toBe('running')
        release.resolve()
        await expect(active).resolves.toMatchObject({
            kind: 'completed', memberState: 'cancelled', campaignState: 'cancelled',
        })
        const settled = await aiCallCampaignPrismaPort.getCampaign(campaignId)
        expect(settled?.campaign.state).toBe('cancelled')
        expect(settled?.members[0].state).toBe('cancelled')
        expect(settled?.attempts[0]).toMatchObject({ state: 'succeeded', callId })
        await expect(database.$queryRawUnsafe<Array<{ count: number }>>(`
            SELECT COUNT(*)::int AS "count" FROM "Call" WHERE "id"=$1
        `, callId)).resolves.toEqual([{ count: 1 }])
    })

    // C3a: a linked effect already owns its capacity, so reconciling it is no longer
    // gated by the rate limiter it would otherwise have to wait behind. The recovery
    // path this proof exercises therefore settles on the first post-crash cycle; the
    // deferral half of the old expectation moved to the proof below it, which blocks a
    // NOT-yet-dispatched attempt on the same rate gate.
    it('reconciles a crashed linked effect without waiting on the rate gate, then settles cancellation', async () => {
        const campaignId = `${PREFIX}:cancel-recovery-blocked`
        const callId = `${PREFIX}:cancel-recovery-blocked:call`
        await prepareCampaign({ id: campaignId, targets: ['cancel-recovery'], ratePerMinute: 60_000 })
        await aiCallCampaignPrismaPort.configureGlobalAdmission({
            concurrentLimit: 1, ratePerMinute: 60_000, now: BASE,
        })
        let nowMs = BASE.getTime()
        let dialCount = 0
        const replayingDial: AiCallCampaignDialPort = {
            async reconcile(request) {
                dialCount += 1
                const stored = await prisma.call.findUnique({ where: { id: callId } })
                if (!stored) return null
                await prisma.call.update({
                    where: { id: callId },
                    data: { status: 'completed', endedAt: new Date(nowMs) },
                })
                return {
                    callId,
                    effectRef: `effect:${request.launchId}`,
                    terminal: { eventId: `result:${request.launchId}`, kind: 'success' as const },
                }
            },
            async dispatch(request) {
                dialCount += 1
                await prisma.$transaction(async (tx) => {
                    await tx.call.upsert({
                        where: { id: callId },
                        create: {
                            id: callId,
                            direction: 'outbound',
                            status: 'active',
                            fromNumber: '+70000000000',
                            toNumber: request.phoneE164,
                            managerId: 'system:campaign-cancel-recovery-proof',
                            fsUuid: `${PREFIX}:cancel-recovery-fs`,
                            startedAt: BASE,
                        },
                        update: {},
                    })
                    const linked = await tx.aiCallCampaignAttempt.updateMany({
                        where: { launchId: request.launchId, OR: [{ callId: null }, { callId }] },
                        data: { callId },
                    })
                    if (linked.count !== 1) throw new Error('CONTROLLED_LINKED_CALL_FENCE_FAILED')
                })
                throw new Error('CONTROLLED_EXIT_AFTER_DIAL_ACCEPTANCE')
            },
        }
        const worker = createAiCallCampaignWorkerRuntime({
            dial: replayingDial,
            workerId: 'cancel-recovery-worker',
            clock: () => new Date(nowMs),
            claimLeaseMs: 100,
            admissionLeaseMs: 100,
        })

        await expect(worker()).rejects.toThrow('CONTROLLED_EXIT_AFTER_DIAL_ACCEPTANCE')
        const retryAt = new Date(BASE.getTime() + 500)
        await database.$executeRawUnsafe(`
            UPDATE "AiCallAdmissionControl" SET "nextAdmitAt"=$1 WHERE "id"='global'
        `, retryAt)
        // The crashed attempt is linked and dispatched, so it already occupies its
        // slot: the rate gate below applies to NEW first effects and must not hold its
        // reconciliation. Cancellation lands first, and the running effect still settles.
        nowMs = BASE.getTime() + 101
        await expect(aiCallCampaignPrismaPort.pause(campaignId, new Date(nowMs)))
            .resolves.toMatchObject({ status: 'paused' })
        nowMs += 1
        await expect(aiCallCampaignPrismaPort.cancel(campaignId, new Date(nowMs)))
            .resolves.toMatchObject({ status: 'cancelling' })
        const cancelling = await aiCallCampaignPrismaPort.getCampaign(campaignId)
        expect(cancelling?.campaign.state).toBe('cancelling')
        expect(cancelling?.members[0].state).toBe('running')
        expect(cancelling?.attempts[0]).toMatchObject({ state: 'running', callId })

        nowMs += 1
        await expect(worker()).resolves.toMatchObject({
            kind: 'completed', memberState: 'cancelled', campaignState: 'cancelled',
        })
        expect(dialCount).toBe(2)
        // The rate gate the reconciliation walked past is untouched by it.
        await expect(database.$queryRawUnsafe<Array<{ nextAdmitAt: Date | null }>>(`
            SELECT "nextAdmitAt" FROM "AiCallAdmissionControl" WHERE "id"='global'
        `)).resolves.toEqual([{ nextAdmitAt: retryAt }])
        const settled = await aiCallCampaignPrismaPort.getCampaign(campaignId)
        expect(settled?.campaign.state).toBe('cancelled')
        expect(settled?.members[0].state).toBe('cancelled')
        expect(settled?.attempts[0]).toMatchObject({
            state: 'succeeded', callId, dialExecutionCount: 2, dispatchState: 'accepted',
        })
        await expect(database.$queryRawUnsafe<Array<{ count: number; active: number }>>(`
            SELECT COUNT(*)::int AS "count",
                   COUNT(*) FILTER (WHERE "endedAt" IS NULL)::int AS "active"
            FROM "Call" WHERE "id"=$1
        `, callId)).resolves.toEqual([{ count: 1, active: 0 }])
    })

    it('fences a not-yet-dispatched effect when cancellation follows a pre-adapter crash', async () => {
        const campaignId = `${PREFIX}:cancel-before-adapter`
        await prepareCampaign({ id: campaignId, targets: ['never-dispatched'], ratePerMinute: 60_000 })
        await aiCallCampaignPrismaPort.configureGlobalAdmission({
            concurrentLimit: 1, ratePerMinute: 60_000, now: BASE,
        })
        await aiCallCampaignPrismaPort.startDueCampaigns(BASE)
        const claim = await aiCallCampaignPrismaPort.claimNextLaunch({
            workerId: 'pre-adapter-crash-worker', now: BASE, leaseMs: 100,
        })
        expect(claim).not.toBeNull()
        const admission = await aiCallCampaignPrismaPort.acquireAdmission({
            claim: claim!, now: BASE, leaseMs: 100,
        })
        expect(admission.kind).toBe('acquired')
        if (admission.kind !== 'acquired') throw new Error('expected pre-adapter admission')
        await aiCallCampaignPrismaPort.markAttemptRunning({
            attemptId: claim!.attemptId,
            claimFence: claim!.claimFence,
            leaseFence: admission.grant.leaseFence,
            now: BASE,
        })
        await expect(aiCallCampaignPrismaPort.beginDialExecution({
            attemptId: claim!.attemptId,
            claimFence: claim!.claimFence,
            leaseFence: admission.grant.leaseFence,
            now: BASE,
        })).resolves.toMatchObject({ kind: 'initial_dispatch_authorized' })

        await expect(aiCallCampaignPrismaPort.cancel(campaignId, new Date(BASE.getTime() + 1)))
            .resolves.toMatchObject({ status: 'cancelling' })
        let dispatches = 0
        let reconciliations = 0
        const restart = createAiCallCampaignWorkerRuntime({
            dial: {
                async dispatch() {
                    dispatches += 1
                    throw new Error('FIRST_DISPATCH_MUST_REMAIN_FENCED')
                },
                async reconcile() {
                    reconciliations += 1
                    return null
                },
            },
            workerId: 'post-cancel-recovery-worker',
            clock: () => new Date(BASE.getTime() + 101),
            claimLeaseMs: 100,
            admissionLeaseMs: 100,
        })
        await expect(restart()).resolves.toMatchObject({
            kind: 'completed', memberState: 'cancelled', campaignState: 'cancelled',
        })
        expect(dispatches).toBe(0)
        expect(reconciliations).toBe(1)
        const settled = await aiCallCampaignPrismaPort.getCampaign(campaignId)
        expect(settled?.attempts[0]).toMatchObject({
            state: 'permanent_failure',
            dispatchState: 'acceptance_unknown',
            failureCode: 'dial_not_accepted_before_recovery',
        })
    })

    it('heartbeats slow admitted work and prevents concurrent redial after initial expiry', async () => {
        const campaignId = `${PREFIX}:slow-heartbeat`
        await prepareCampaign({ id: campaignId, targets: ['slow'] })
        const initial = new Date()
        await aiCallCampaignPrismaPort.configureGlobalAdmission({
            concurrentLimit: 1, ratePerMinute: 60_000, now: initial,
        })
        const entered = deferred()
        const release = deferred()
        let dialCount = 0
        const holdingDial: AiCallCampaignDialPort = {
            async reconcile() { return null },
            async dispatch(request) {
                dialCount += 1
                entered.resolve()
                await release.promise
                return {
                    effectRef: `effect:${request.launchId}`,
                    terminal: { eventId: `result:${request.launchId}`, kind: 'success' },
                }
            },
        }
        const workerA = createAiCallCampaignWorkerRuntime({
            dial: holdingDial, workerId: 'slow-worker-a', claimLeaseMs: 90, admissionLeaseMs: 90,
        })
        const workerB = createAiCallCampaignWorkerRuntime({
            dial: holdingDial, workerId: 'slow-worker-b', claimLeaseMs: 90, admissionLeaseMs: 90,
        })
        const active = workerA()
        await entered.promise
        await new Promise((resolve) => setTimeout(resolve, 220))
        await expect(workerB()).resolves.toMatchObject({ kind: 'idle' })
        expect(dialCount).toBe(1)
        const lease = await database.$queryRawUnsafe<Array<{ leaseUntil: Date }>>(`
            SELECT "leaseUntil" FROM "AiCallAdmissionLease"
            WHERE "campaignId"=$1 AND "releasedAt" IS NULL
        `, campaignId)
        expect(lease[0].leaseUntil.getTime()).toBeGreaterThan(initial.getTime() + 90)
        release.resolve()
        await expect(active).resolves.toMatchObject({ kind: 'completed' })
    })

    it('counts admitted dial executions independently from admission deferrals', async () => {
        const campaignId = `${PREFIX}:poison-adapter`
        await prepareCampaign({ id: campaignId, targets: ['poison'], ratePerMinute: 60_000 })
        await aiCallCampaignPrismaPort.configureGlobalAdmission({
            concurrentLimit: 1, ratePerMinute: 60_000, now: BASE,
        })
        let nowMs = BASE.getTime()
        let invocations = 0
        const worker = createAiCallCampaignWorkerRuntime({
            dial: {
                async dispatch() {
                    invocations += 1
                    throw new Error('CONTROLLED_POISON_ADAPTER')
                },
                async reconcile() {
                    invocations += 1
                    throw new Error('CONTROLLED_POISON_ADAPTER')
                },
            },
            workerId: 'poison-worker',
            clock: () => new Date(nowMs),
            claimLeaseMs: 100,
            admissionLeaseMs: 100,
        })
        await database.$executeRawUnsafe(`
            UPDATE "AiCallAdmissionControl" SET "nextAdmitAt"=$1 WHERE "id"='global'
        `, new Date(BASE.getTime() + 100))
        await expect(worker()).resolves.toMatchObject({ kind: 'blocked', reason: 'rate' })
        nowMs += 100
        await database.$executeRawUnsafe(`
            UPDATE "AiCallAdmissionControl" SET "nextAdmitAt"=$1 WHERE "id"='global'
        `, new Date(BASE.getTime() + 200))
        await expect(worker()).resolves.toMatchObject({ kind: 'blocked', reason: 'rate' })
        expect(invocations).toBe(0)
        nowMs += 100
        await database.$executeRawUnsafe(`
            UPDATE "AiCallAdmissionControl" SET "nextAdmitAt"=NULL WHERE "id"='global'
        `)
        await expect(worker()).rejects.toThrow('CONTROLLED_POISON_ADAPTER')
        nowMs += 101
        await expect(worker()).rejects.toThrow('CONTROLLED_POISON_ADAPTER')
        nowMs += 101
        await expect(worker()).resolves.toMatchObject({ kind: 'completed', memberState: 'failed' })
        expect(invocations).toBe(3)
        const view = await aiCallCampaignPrismaPort.getCampaign(campaignId)
        expect(view?.campaign.state).toBe('completed')
        expect(view?.members[0]).toMatchObject({
            state: 'failed', failureCode: 'dial_acceptance_unresolved',
        })
        expect(view?.attempts[0]).toMatchObject({
            state: 'permanent_failure', claimRevision: 5, dialExecutionCount: 3,
            failureCode: 'dial_acceptance_unresolved',
        })
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

    // ── C3a: durable live-effect occupancy ────────────────────────────────────
    //
    // A worker lease expires in tens of seconds; a telephone call runs for minutes.
    // Capacity therefore cannot be a lease — it is the attempt's own linked,
    // dispatched, unsettled state, and these proofs hold that against real
    // transactions, real lease expiry and two real workers.

    /** Drives one attempt to "linked live effect" and leaves it unsettled. */
    async function linkedLiveEffect(input: { campaignId: string; target: string; callId: string; nowMs: number }) {
        const port: AiCallCampaignDialPort = {
            async reconcile() { return null },
            async dispatch(request) {
                await prisma.$transaction(async (tx) => {
                    await tx.call.upsert({
                        where: { id: input.callId },
                        create: {
                            id: input.callId,
                            direction: 'outbound',
                            status: 'active',
                            fromNumber: '+70000000000',
                            toNumber: request.phoneE164,
                            managerId: null,
                            fsUuid: `${input.callId}:fs`,
                            startedAt: new Date(input.nowMs),
                        },
                        update: {},
                    })
                    const linked = await tx.aiCallCampaignAttempt.updateMany({
                        where: { launchId: request.launchId, OR: [{ callId: null }, { callId: input.callId }] },
                        data: { callId: input.callId },
                    })
                    if (linked.count !== 1) throw new Error('LINK_FENCE_FAILED')
                })
                // Linked pending: a real conversation settles later.
                return null
            },
        }
        const worker = createAiCallCampaignWorkerRuntime({
            dial: port,
            workerId: `occupancy-worker:${input.target}`,
            clock: () => new Date(input.nowMs),
            claimLeaseMs: 100,
            admissionLeaseMs: 100,
        })
        return { worker, port }
    }

    async function occupancyCount(): Promise<number> {
        const rows = await database.$queryRawUnsafe<Array<{ count: number }>>(`
            SELECT COUNT(*)::int AS "count" FROM (
                SELECT a."id" FROM "AiCallCampaignAttempt" a
                 WHERE a."callId" IS NOT NULL AND a."dispatchState" <> 'not_dispatched'
                   AND a."resultEventId" IS NULL
                   AND a."state" NOT IN ('succeeded','retryable_failure','permanent_failure','cancelled')
                UNION
                SELECT l."attemptId" FROM "AiCallAdmissionLease" l
                  JOIN "AiCallCampaignAttempt" a2 ON a2."id"=l."attemptId"
                 WHERE l."releasedAt" IS NULL AND a2."resultEventId" IS NULL
                   AND a2."state" NOT IN ('succeeded','retryable_failure','permanent_failure','cancelled')
            ) occupancy
        `)
        return rows[0]?.count ?? 0
    }

    it('keeps a linked live effect occupying capacity after its worker lease expires', async () => {
        const campaignId = `${PREFIX}:occupancy-survives-lease`
        const callId = `${campaignId}:call`
        await prepareCampaign({ id: campaignId, targets: ['live-effect'], ratePerMinute: 60_000 })
        await aiCallCampaignPrismaPort.configureGlobalAdmission({
            concurrentLimit: 1, ratePerMinute: 60_000, now: BASE,
        })
        const nowMs = BASE.getTime()
        const { worker } = await linkedLiveEffect({ campaignId, target: 'live-effect', callId, nowMs })

        await expect(worker()).resolves.toMatchObject({ kind: 'blocked', reason: 'dial_reconciliation_deferred' })

        const attempt = (await aiCallCampaignPrismaPort.getCampaign(campaignId))!.attempts[0]
        expect(attempt).toMatchObject({ state: 'running', callId, dispatchState: 'acceptance_unknown' })
        // The pending deferral released the worker lease and stamped no failure: a call
        // still in progress is not a broken one.
        await expect(database.$queryRawUnsafe<Array<{ count: number }>>(`
            SELECT COUNT(*)::int AS "count" FROM "AiCallAdmissionLease"
            WHERE "attemptId"=$1 AND "releasedAt" IS NULL
        `, attempt.id)).resolves.toEqual([{ count: 0 }])
        expect(attempt.failureCode ?? null).toBeNull()
        // And the effect is still counted, with no lease at all.
        await expect(occupancyCount()).resolves.toBe(1)
    })

    it('never admits more simultaneous live effects than the global limit, with two workers', async () => {
        const campaignId = `${PREFIX}:occupancy-global-race`
        const firstCall = `${campaignId}:call-1`
        await prepareCampaign({ id: campaignId, targets: ['first-live', 'second-live'], ratePerMinute: 60_000 })
        await aiCallCampaignPrismaPort.configureGlobalAdmission({
            concurrentLimit: 1, ratePerMinute: 60_000, now: BASE,
        })
        const nowMs = BASE.getTime()
        const { worker: first } = await linkedLiveEffect({ campaignId, target: 'first-live', callId: firstCall, nowMs })
        await expect(first()).resolves.toMatchObject({ kind: 'blocked', reason: 'dial_reconciliation_deferred' })
        await expect(occupancyCount()).resolves.toBe(1)

        // A second worker, with every lease released, must still see the live effect.
        // Kept inside the first attempt's own 250 ms recheck window so the claim on
        // offer is the next member's first dispatch, not this attempt's reconciliation.
        const laterMs = nowMs + 100
        const secondCall = `${campaignId}:call-2`
        const { worker: second } = await linkedLiveEffect({
            campaignId, target: 'second-live', callId: secondCall, nowMs: laterMs,
        })
        const outcome = await second()

        expect(outcome).toMatchObject({ kind: 'blocked' })
        expect(['global_concurrency', 'campaign_concurrency']).toContain(
            (outcome as { reason: string }).reason,
        )
        await expect(database.$queryRawUnsafe<Array<{ count: number }>>(`
            SELECT COUNT(*)::int AS "count" FROM "Call" WHERE "id"=$1
        `, secondCall)).resolves.toEqual([{ count: 0 }])
        await expect(occupancyCount()).resolves.toBe(1)
    })

    it('admits a linked attempt for reconciliation without a second slot or a rate advance', async () => {
        const campaignId = `${PREFIX}:occupancy-reconcile-admission`
        const callId = `${campaignId}:call`
        await prepareCampaign({ id: campaignId, targets: ['reconcile-me'], ratePerMinute: 60_000 })
        await aiCallCampaignPrismaPort.configureGlobalAdmission({
            concurrentLimit: 1, ratePerMinute: 60_000, now: BASE,
        })
        let nowMs = BASE.getTime()
        const { worker } = await linkedLiveEffect({ campaignId, target: 'reconcile-me', callId, nowMs })
        await expect(worker()).resolves.toMatchObject({ kind: 'blocked', reason: 'dial_reconciliation_deferred' })
        const attemptId = (await aiCallCampaignPrismaPort.getCampaign(campaignId))!.attempts[0].id

        // Pin both rate gates in the future: a first dispatch would be blocked by them.
        const gate = new Date(nowMs + 10_000)
        await database.$executeRawUnsafe(`
            UPDATE "AiCallAdmissionControl" SET "nextAdmitAt"=$1 WHERE "id"='global'
        `, gate)
        await database.$executeRawUnsafe(`
            UPDATE "AiCallCampaign" SET "nextAdmitAt"=$2 WHERE "id"=$1
        `, campaignId, gate)

        nowMs += 300
        const claim = await aiCallCampaignPrismaPort.claimNextLaunch({
            workerId: 'reconcile-admission-worker', now: new Date(nowMs), leaseMs: 100,
        })
        expect(claim).toMatchObject({ attemptId, launchId: expect.any(String) })
        const admission = await aiCallCampaignPrismaPort.acquireAdmission({
            claim: claim!, now: new Date(nowMs), leaseMs: 100,
        })

        // Admitted: it already owns its capacity, and the gates are untouched.
        expect(admission).toMatchObject({ kind: 'acquired' })
        expect((admission as { grant: { replayed: boolean } }).grant.replayed).toBe(true)
        await expect(database.$queryRawUnsafe<Array<{ nextAdmitAt: Date | null }>>(`
            SELECT "nextAdmitAt" FROM "AiCallAdmissionControl" WHERE "id"='global'
        `)).resolves.toEqual([{ nextAdmitAt: gate }])
        await expect(database.$queryRawUnsafe<Array<{ nextAdmitAt: Date | null }>>(`
            SELECT "nextAdmitAt" FROM "AiCallCampaign" WHERE "id"=$1
        `, campaignId)).resolves.toEqual([{ nextAdmitAt: gate }])
        // Exactly one lease row for the attempt: fencing, not a second slot.
        await expect(database.$queryRawUnsafe<Array<{ count: number }>>(`
            SELECT COUNT(*)::int AS "count" FROM "AiCallAdmissionLease" WHERE "attemptId"=$1
        `, attemptId)).resolves.toEqual([{ count: 1 }])
        await expect(occupancyCount()).resolves.toBe(1)
    })

    it('releases occupancy atomically with the terminal result', async () => {
        const campaignId = `${PREFIX}:occupancy-terminal-release`
        const callId = `${campaignId}:call`
        await prepareCampaign({ id: campaignId, targets: ['settle-me'], ratePerMinute: 60_000 })
        await aiCallCampaignPrismaPort.configureGlobalAdmission({
            concurrentLimit: 1, ratePerMinute: 60_000, now: BASE,
        })
        let nowMs = BASE.getTime()
        const settling: AiCallCampaignDialPort = {
            async dispatch() { return null },
            async reconcile(request) {
                return {
                    callId,
                    effectRef: `effect:${request.launchId}`,
                    terminal: { eventId: `terminal:${request.launchId}`, kind: 'success' as const },
                }
            },
        }
        const { worker: link } = await linkedLiveEffect({ campaignId, target: 'settle-me', callId, nowMs })
        await expect(link()).resolves.toMatchObject({ kind: 'blocked', reason: 'dial_reconciliation_deferred' })
        await expect(occupancyCount()).resolves.toBe(1)

        nowMs += 300
        const settlingWorker = createAiCallCampaignWorkerRuntime({
            dial: settling,
            workerId: 'settling-worker',
            clock: () => new Date(nowMs),
            claimLeaseMs: 100,
            admissionLeaseMs: 100,
        })
        await expect(settlingWorker()).resolves.toMatchObject({ kind: 'completed', memberState: 'succeeded' })

        await expect(occupancyCount()).resolves.toBe(0)
        await expect(database.$queryRawUnsafe<Array<{ count: number }>>(`
            SELECT COUNT(*)::int AS "count" FROM "AiCallAdmissionLease"
            WHERE "campaignId"=$1 AND "releasedAt" IS NULL
        `, campaignId)).resolves.toEqual([{ count: 0 }])
    })

    it('keeps a cancelled campaign occupying capacity until its live effect settles', async () => {
        const campaignId = `${PREFIX}:occupancy-cancel-settlement`
        const callId = `${campaignId}:call`
        await prepareCampaign({ id: campaignId, targets: ['cancel-live'], ratePerMinute: 60_000 })
        await aiCallCampaignPrismaPort.configureGlobalAdmission({
            concurrentLimit: 1, ratePerMinute: 60_000, now: BASE,
        })
        let nowMs = BASE.getTime()
        const { worker } = await linkedLiveEffect({ campaignId, target: 'cancel-live', callId, nowMs })
        await expect(worker()).resolves.toMatchObject({ kind: 'blocked', reason: 'dial_reconciliation_deferred' })

        nowMs += 10
        await expect(aiCallCampaignPrismaPort.cancel(campaignId, new Date(nowMs)))
            .resolves.toMatchObject({ status: 'cancelling' })
        // Cancellation stops future launches; the running conversation is not hung up
        // and keeps its slot.
        await expect(occupancyCount()).resolves.toBe(1)
        await expect(database.$queryRawUnsafe<Array<{ count: number; active: number }>>(`
            SELECT COUNT(*)::int AS "count",
                   COUNT(*) FILTER (WHERE "endedAt" IS NULL)::int AS "active"
            FROM "Call" WHERE "id"=$1
        `, callId)).resolves.toEqual([{ count: 1, active: 1 }])

        nowMs += 300
        const settling = createAiCallCampaignWorkerRuntime({
            dial: {
                async dispatch() { return null },
                async reconcile(request) {
                    await prisma.call.update({
                        where: { id: callId },
                        data: { status: 'completed', endedAt: new Date(nowMs) },
                    })
                    return {
                        callId,
                        effectRef: `effect:${request.launchId}`,
                        terminal: { eventId: `terminal:${request.launchId}`, kind: 'success' as const },
                    }
                },
            },
            workerId: 'cancel-settling-worker',
            clock: () => new Date(nowMs),
            claimLeaseMs: 100,
            admissionLeaseMs: 100,
        })
        await expect(settling()).resolves.toMatchObject({
            kind: 'completed', memberState: 'cancelled', campaignState: 'cancelled',
        })
        await expect(occupancyCount()).resolves.toBe(0)
    })
})
