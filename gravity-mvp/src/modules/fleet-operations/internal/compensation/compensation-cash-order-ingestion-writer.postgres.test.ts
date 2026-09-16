/**
 * Isolated-PostgreSQL proof for the canonical cash-order page writer and the
 * park lease that fences it.
 *
 * Runs the production adapter unchanged against real PostgreSQL: the upsert
 * guard, booked_at retention, connection provenance, positive removals, the
 * lease fence, compare-and-set progress and the atomic rollback of a failed
 * page. C1 evidence is checked byte for byte around a removal.
 *
 * Gated behind YOKO_COMPENSATION_MONETARY_POSTGRES_PROOF=1 and an isolated
 * DATABASE_URL.
 */

import { createHash, randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { SUBMIT_COMPENSATION_APPLICATION_COMMAND_V1 } from '../../../../contracts/fleet-operations/v1'
import {
    compensationMonthEndInstantV1,
    compensationMonthStartInstantV1,
} from './compensation-calendar'
import { cashOrderRowIdV1 } from './compensation-cash-order-ingestion'
import { submitCompensationApplicationV1 } from './compensation-prisma-adapter'
import { compensationPeriodSubmissionClosesAtV1 } from './compensation-submission-window'
import {
    CASH_ORDER_PROVIDER_V1,
    CashOrderLeaseLostError,
    CashOrderProgressConflictError,
    type CashOrderAcceptedRowV1,
    type CashOrderIngestionProgressV1,
    type CashOrderPageWriteV1,
} from './cash-order-ingestion-store'
import { legacyPrismaCashOrderIngestionStoreV1 as store } from './legacy-prisma-cash-order-ingestion-adapter'

const proof = process.env.YOKO_COMPENSATION_MONETARY_POSTGRES_PROOF === '1' ? describe : describe.skip

const PARK = 'ext-yoko-proof'
const PROFILE = 'b'.repeat(32)
const NO_PROGRESS: CashOrderIngestionProgressV1 = {
    lastHotSuccessAt: null,
    reconciliationPassStartedAt: null,
    reconciliationFloorBookedAt: null,
    reconciliationCursorBookedAt: null,
    lastReconciliationCompletedAt: null,
}

let database: PrismaClient

function accepted(orderId: string, overrides: Partial<CashOrderAcceptedRowV1> = {}): CashOrderAcceptedRowV1 {
    return {
        id: cashOrderRowIdV1({ provider: CASH_ORDER_PROVIDER_V1, externalParkId: PARK, externalOrderId: orderId }),
        externalOrderId: orderId,
        shortOrderIdDisplay: '3982091',
        externalDriverProfileId: PROFILE,
        rawPrice: '335.0000',
        amountKopecks: 33_500,
        endedAt: new Date('2026-09-16T08:24:59.982Z'),
        providerBookedAt: new Date('2026-09-16T08:25:48.753Z'),
        ...overrides,
    }
}

async function lease(): Promise<{ checkpointId: string; token: string }> {
    const token = randomUUID()
    const acquisition = await store.acquireLease({ provider: CASH_ORDER_PROVIDER_V1, externalParkId: PARK, token })
    if (!acquisition.acquired) throw new Error('lease not acquired')
    return { checkpointId: acquisition.checkpoint.id, token }
}

function page(held: { checkpointId: string; token: string }, overrides: Partial<CashOrderPageWriteV1> = {}): CashOrderPageWriteV1 {
    return {
        checkpointId: held.checkpointId,
        leaseToken: held.token,
        provider: CASH_ORDER_PROVIDER_V1,
        externalParkId: PARK,
        sourceConnectionId: 'conn-yoko',
        accepted: [],
        removedOrderIds: [],
        progress: null,
        ...overrides,
    }
}

async function row(orderId: string) {
    const rows = await database.$queryRawUnsafe<Array<{
        id: string; externalDriverProfileId: string; amountKopecks: number; observedAt: Date; updatedAt: Date
        sourceConnectionId: string | null; providerBookedAt: Date | null; rawPrice: string
    }>>(
        `SELECT "id","externalDriverProfileId","amountKopecks","observedAt","updatedAt","sourceConnectionId",
                "providerBookedAt","rawPrice"
         FROM "CompensationCashOrder" WHERE "externalParkId" = $1 AND "externalOrderId" = $2`,
        PARK, orderId,
    )
    return rows[0] ?? null
}

async function orderCount(): Promise<number> {
    const rows = await database.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT count(*) AS count FROM "CompensationCashOrder"`)
    return Number(rows[0].count)
}

async function checkpoint() {
    const read = await store.readCheckpoints(CASH_ORDER_PROVIDER_V1, [PARK])
    return read.checkpoints[0]
}

/** Every C1 and pilot evidence table, digested row by row. */
async function monetaryEvidenceDigest(): Promise<Record<string, string>> {
    const rows = await database.$queryRawUnsafe<Array<Record<string, string>>>(
        `SELECT
           (SELECT md5(COALESCE(string_agg(t::text, '|' ORDER BY t::text), '')) FROM "CompensationApplication" t) AS "application",
           (SELECT md5(COALESCE(string_agg(t::text, '|' ORDER BY t::text), '')) FROM "CompensationVerifiedOrder" t) AS "verifiedOrder",
           (SELECT md5(COALESCE(string_agg(t::text, '|' ORDER BY t::text), '')) FROM "CompensationOrderClaim" t) AS "orderClaim",
           (SELECT md5(COALESCE(string_agg(t::text, '|' ORDER BY t::text), '')) FROM "CompensationBudgetPeriod" t) AS "budgetPeriod",
           (SELECT md5(COALESCE(string_agg(t::text, '|' ORDER BY t::text), '')) FROM "CompensationAuditEvent" t) AS "auditEvent",
           (SELECT md5(COALESCE(string_agg(t::text, '|' ORDER BY t::text), '')) FROM "CompensationPerson" t) AS "person",
           (SELECT md5(COALESCE(string_agg(t::text, '|' ORDER BY t::text), '')) FROM "CompensationPersonBinding" t) AS "personBinding",
           (SELECT md5(COALESCE(string_agg(t::text, '|' ORDER BY t::text), '')) FROM "CompensationPayoutAuthorization" t) AS "payoutAuthorization",
           (SELECT md5(COALESCE(string_agg(t::text, '|' ORDER BY t::text), '')) FROM "CompensationSettlement" t) AS "settlement",
           (SELECT md5(COALESCE(string_agg(t::text, '|' ORDER BY t::text), '')) FROM "CompensationReconciliationTask" t) AS "reconciliationTask",
           (SELECT md5(COALESCE(string_agg(t::text, '|' ORDER BY t::text), '')) FROM "CompensationPilotSubmission" t) AS "pilotSubmission"`,
    )
    return rows[0]
}

async function truncateAll(): Promise<void> {
    await database.$executeRawUnsafe(`TRUNCATE TABLE
        "CompensationAuditEvent","CompensationReconciliationTask","CompensationSettlement",
        "CompensationPayoutAuthorization","CompensationApplication","CompensationOrderClaim",
        "CompensationVerifiedOrder","CompensationPersonBinding","CompensationPerson",
        "CompensationBudgetPeriod","CompensationPilotSubmission","CompensationCashOrder",
        "CompensationCashOrderIngestionCheckpoint" RESTART IDENTITY CASCADE`)
}

proof('canonical cash-order page writer on real PostgreSQL', () => {
    beforeAll(async () => {
        database = new PrismaClient()
        await database.$connect()
    })
    beforeEach(truncateAll)
    afterAll(async () => {
        await truncateAll()
        await database.$disconnect()
    })

    it('inserts an accepted order with its connection, booking time and the transaction time', async () => {
        const held = await lease()
        const result = await store.writePage(page(held, { accepted: [accepted('o1')] }))
        expect(result).toMatchObject({ inserted: 1, updated: 0, guardedNoops: 0, removed: 0 })
        const stored = await row('o1')
        expect(stored).toMatchObject({ sourceConnectionId: 'conn-yoko', amountKopecks: 33_500, rawPrice: '335.0000' })
        expect(stored?.providerBookedAt?.toISOString()).toBe('2026-09-16T08:25:48.753Z')
        expect(stored?.observedAt.getTime()).toBe(result.observedAt.getTime())
    })

    it('rewrites observedAt on an identical replay and keeps one row', async () => {
        const held = await lease()
        const first = await store.writePage(page(held, { accepted: [accepted('o1')] }))
        const second = await store.writePage(page(held, { accepted: [accepted('o1')] }))
        expect(second).toMatchObject({ inserted: 0, updated: 1, guardedNoops: 0 })
        expect(await orderCount()).toBe(1)
        const stored = await row('o1')
        expect(stored?.observedAt.getTime()).toBe(second.observedAt.getTime())
        expect(second.observedAt.getTime()).toBeGreaterThanOrEqual(first.observedAt.getTime())
    })

    it('updates booked_at when it changes and keeps it when a later observation lacks it', async () => {
        const held = await lease()
        await store.writePage(page(held, { accepted: [accepted('o1')] }))
        await store.writePage(page(held, { accepted: [accepted('o1', { providerBookedAt: new Date('2026-09-16T08:30:00.000Z') })] }))
        expect((await row('o1'))?.providerBookedAt?.toISOString()).toBe('2026-09-16T08:30:00.000Z')
        await store.writePage(page(held, { accepted: [accepted('o1', { providerBookedAt: null, amountKopecks: 40_000, rawPrice: '400.0000' })] }))
        const stored = await row('o1')
        expect(stored?.providerBookedAt?.toISOString()).toBe('2026-09-16T08:30:00.000Z')
        expect(stored?.amountKopecks).toBe(40_000)
        expect(await orderCount()).toBe(1)
    })

    it('moves a rotated connection onto the same row', async () => {
        const held = await lease()
        await store.writePage(page(held, { accepted: [accepted('o1')] }))
        const before = await row('o1')
        await store.writePage(page(held, { sourceConnectionId: 'conn-yoko-rotated', accepted: [accepted('o1')] }))
        const after = await row('o1')
        expect(after?.id).toBe(before?.id)
        expect(after?.sourceConnectionId).toBe('conn-yoko-rotated')
    })

    it('counts a driver reassignment and an amount change, in place', async () => {
        const held = await lease()
        await store.writePage(page(held, { accepted: [accepted('o1')] }))
        const result = await store.writePage(page(held, {
            accepted: [accepted('o1', { externalDriverProfileId: 'c'.repeat(32), amountKopecks: 1, rawPrice: '0.0100' })],
        }))
        expect(result).toMatchObject({ updated: 1, driverReassigned: 1, amountChanged: 1, endedAtChanged: 0 })
        expect((await row('o1'))?.externalDriverProfileId).toBe('c'.repeat(32))
    })

    it('never lets an older observation overwrite a newer one', async () => {
        const held = await lease()
        await store.writePage(page(held, { accepted: [accepted('o1')] }))
        await database.$executeRawUnsafe(
            `UPDATE "CompensationCashOrder" SET "observedAt" = now() + interval '1 hour' WHERE "externalOrderId" = 'o1'`)
        const newer = await row('o1')
        const result = await store.writePage(page(held, { accepted: [accepted('o1', { amountKopecks: 99_900, rawPrice: '999.0000' })] }))
        expect(result).toMatchObject({ inserted: 0, updated: 0, guardedNoops: 1 })
        expect(await row('o1')).toEqual(newer)
    })

    it('deletes a positively disqualified order and leaves C1 evidence byte-identical', async () => {
        const held = await lease()
        await store.writePage(page(held, { accepted: [accepted('o1'), accepted('o2')] }))
        const month = { year: 2026, month: 9 }
        await database.$executeRawUnsafe(
            `INSERT INTO "CompensationBudgetPeriod"
                ("id","periodKey","periodStartsAt","periodEndsAt","submissionClosesAt","limitKopecks",
                 "reservedKopecks","settledKopecks","state","openedAt","createdAt","updatedAt")
             VALUES ('period_2026-09','2026-09',$1,$2,$3,500000,0,0,'open',NOW(),NOW(),NOW())`,
            compensationMonthStartInstantV1(month),
            compensationMonthEndInstantV1(month),
            compensationPeriodSubmissionClosesAtV1(month),
        )
        const submitted = await submitCompensationApplicationV1({
            contract: SUBMIT_COMPENSATION_APPLICATION_COMMAND_V1,
            idempotencyKey: randomUUID(),
            person: {
                canonicalContactId: 'contact-proof',
                resolutionStatus: 'live',
                lineage: ['contact-proof'],
                lineageDigest: createHash('sha256').update('contact-proof').digest('hex'),
                evidenceAt: new Date('2026-09-16T09:00:00.000Z'),
            },
            order: {
                provider: CASH_ORDER_PROVIDER_V1,
                externalParkId: PARK,
                externalOrderId: 'o1',
                shortOrderIdDisplay: '3982091',
                rawPrice: '335.0000',
                endedAt: new Date('2026-09-16T08:24:59.982Z'),
                verifiedAt: new Date('2026-09-16T08:30:00.000Z'),
            },
            claimedRubles: 300,
            submittedAt: new Date('2026-09-16T09:00:00.000Z'),
        })
        expect(submitted.status).toBe('created')
        const evidenceBefore = await monetaryEvidenceDigest()

        const result = await store.writePage(page(held, { removedOrderIds: ['o1', 'never-stored'] }))
        expect(result).toMatchObject({ removed: 1, guardedNoops: 1 })
        expect(await row('o1')).toBeNull()
        expect(await row('o2')).not.toBeNull()
        expect(await monetaryEvidenceDigest()).toEqual(evidenceBefore)
    })

    it('recreates a removed order with the same id when it is accepted again', async () => {
        const held = await lease()
        await store.writePage(page(held, { accepted: [accepted('o1')] }))
        const id = (await row('o1'))?.id
        await store.writePage(page(held, { removedOrderIds: ['o1'] }))
        await store.writePage(page(held, { accepted: [accepted('o1')] }))
        expect((await row('o1'))?.id).toBe(id)
    })

    it('does not delete a row whose stored observation is newer than the transaction', async () => {
        const held = await lease()
        await store.writePage(page(held, { accepted: [accepted('o1')] }))
        await database.$executeRawUnsafe(
            `UPDATE "CompensationCashOrder" SET "observedAt" = now() + interval '1 hour' WHERE "externalOrderId" = 'o1'`)
        const result = await store.writePage(page(held, { removedOrderIds: ['o1'] }))
        expect(result).toMatchObject({ removed: 0, guardedNoops: 1 })
        expect(await row('o1')).not.toBeNull()
    })

    it('rolls back the whole page when one accepted row cannot be persisted', async () => {
        const held = await lease()
        await store.writePage(page(held, { accepted: [accepted('keep')] }))
        const S = new Date('2026-09-16T09:00:00.000Z')
        await expect(store.writePage(page(held, {
            accepted: [accepted('o1'), accepted('bad', { rawPrice: '335.00' })],
            removedOrderIds: ['keep'],
            progress: { expected: NO_PROGRESS, next: { ...NO_PROGRESS, lastHotSuccessAt: S } },
        }))).rejects.toThrow()
        expect(await row('o1')).toBeNull()
        expect(await row('keep')).not.toBeNull()
        expect((await checkpoint()).lastHotSuccessAt).toBeNull()
    })

    it('advances progress only in the page transaction, against the value planned from', async () => {
        const held = await lease()
        const S = new Date('2026-09-16T09:00:00.000Z')
        const next = {
            lastHotSuccessAt: S,
            reconciliationPassStartedAt: S,
            reconciliationFloorBookedAt: new Date('2026-08-31T19:00:00.000Z'),
            reconciliationCursorBookedAt: new Date('2026-09-16T06:00:00.000Z'),
            lastReconciliationCompletedAt: null,
        }
        await store.writePage(page(held, { accepted: [accepted('o1')], progress: { expected: NO_PROGRESS, next } }))
        expect(await checkpoint()).toMatchObject(next)

        // A holder that planned from the old value is refused, and its page with it.
        await expect(store.writePage(page(held, {
            accepted: [accepted('o2')],
            progress: { expected: NO_PROGRESS, next: { ...next, lastHotSuccessAt: new Date('2026-09-16T09:02:00.000Z') } },
        }))).rejects.toBeInstanceOf(CashOrderProgressConflictError)
        expect(await row('o2')).toBeNull()
        expect(await checkpoint()).toMatchObject(next)
    })

    it('accepts an empty final page so progress can move without rows', async () => {
        const held = await lease()
        const S = new Date('2026-09-16T09:00:00.000Z')
        const result = await store.writePage(page(held, { progress: { expected: NO_PROGRESS, next: { ...NO_PROGRESS, lastHotSuccessAt: S } } }))
        expect(result).toMatchObject({ inserted: 0, updated: 0, removed: 0, guardedNoops: 0 })
        expect((await checkpoint()).lastHotSuccessAt?.toISOString()).toBe(S.toISOString())
    })
})

proof('park lease on real PostgreSQL', () => {
    beforeAll(async () => {
        database = new PrismaClient()
        await database.$connect()
    })
    beforeEach(truncateAll)
    afterAll(async () => {
        await truncateAll()
        await database.$disconnect()
    })

    it('creates the progress row on first acquisition and refuses a second holder', async () => {
        const first = await store.acquireLease({ provider: CASH_ORDER_PROVIDER_V1, externalParkId: PARK, token: 'token-a' })
        expect(first.acquired).toBe(true)
        const second = await store.acquireLease({ provider: CASH_ORDER_PROVIDER_V1, externalParkId: PARK, token: 'token-b' })
        expect(second.acquired).toBe(false)
        expect((await checkpoint()).leaseToken).toBe('token-a')
    })

    it('hands the lease over after release', async () => {
        const held = await lease()
        await store.releaseLease(held)
        const next = await store.acquireLease({ provider: CASH_ORDER_PROVIDER_V1, externalParkId: PARK, token: 'token-b' })
        expect(next.acquired).toBe(true)
    })

    it('lets an expired lease be taken over, and the stale holder then writes nothing', async () => {
        const stale = await lease()
        await database.$executeRawUnsafe(
            `UPDATE "CompensationCashOrderIngestionCheckpoint" SET "leaseExpiresAt" = now() - interval '1 second'`)
        const takeover = await store.acquireLease({ provider: CASH_ORDER_PROVIDER_V1, externalParkId: PARK, token: 'token-new' })
        expect(takeover.acquired).toBe(true)

        await expect(store.writePage(page(stale, {
            accepted: [accepted('o1')],
            removedOrderIds: ['o2'],
            progress: { expected: NO_PROGRESS, next: { ...NO_PROGRESS, lastHotSuccessAt: new Date() } },
        }))).rejects.toBeInstanceOf(CashOrderLeaseLostError)
        expect(await orderCount()).toBe(0)
        expect(await checkpoint()).toMatchObject({ leaseToken: 'token-new', lastHotSuccessAt: null })

        // Releasing with the stale token does not free the new holder's lease.
        await store.releaseLease(stale)
        expect((await checkpoint()).leaseToken).toBe('token-new')
    })

    it('refuses a write from a holder whose lease expired even with no takeover', async () => {
        const held = await lease()
        await database.$executeRawUnsafe(
            `UPDATE "CompensationCashOrderIngestionCheckpoint" SET "leaseExpiresAt" = now() - interval '1 second'`)
        await expect(store.writePage(page(held, { accepted: [accepted('o1')] }))).rejects.toBeInstanceOf(CashOrderLeaseLostError)
        expect(await orderCount()).toBe(0)
    })

    it('makes a concurrent takeover wait for the page commit, then find the lease renewed', async () => {
        const held = await lease()
        // The lease is about to expire while the holder is still writing.
        await database.$executeRawUnsafe(
            `UPDATE "CompensationCashOrderIngestionCheckpoint" SET "leaseExpiresAt" = now() + interval '150 milliseconds'`)
        // Renew and hold the checkpoint row lock the way a page write does.
        const blocker = database.$transaction(async (transaction) => {
            await transaction.$executeRawUnsafe(
                `UPDATE "CompensationCashOrderIngestionCheckpoint" SET "leaseExpiresAt" = now() + interval '120 seconds'
                 WHERE "id" = $1 AND "leaseToken" = $2 AND "leaseExpiresAt" > now()`,
                held.checkpointId, held.token,
            )
            await new Promise((resolve) => setTimeout(resolve, 450))
        }, { timeout: 10_000 })
        // By now the old expiry has passed, so only the held lock stands
        // between the takeover and the lease.
        await new Promise((resolve) => setTimeout(resolve, 300))
        const takeover = store.acquireLease({ provider: CASH_ORDER_PROVIDER_V1, externalParkId: PARK, token: 'token-new' })
        // The takeover waits for the commit and then re-reads the renewed
        // expiry. Should the wait outlast its lock timeout it fails instead;
        // either way it never gets the lease.
        const outcome = await takeover.then((value) => value.acquired, () => false)
        await blocker
        expect(outcome).toBe(false)
        expect((await checkpoint()).leaseToken).toBe(held.token)
    })

    it('records a deferral only for the lease holder', async () => {
        const held = await lease()
        expect(await store.recordDeferral({ checkpointId: held.checkpointId, token: 'not-the-holder', seconds: 60, connectionId: 'conn-yoko' })).toBeNull()
        const notBefore = await store.recordDeferral({ ...held, seconds: 60, connectionId: 'conn-yoko' })
        expect(notBefore).toBeInstanceOf(Date)
        expect(await checkpoint()).toMatchObject({ providerRetryConnectionId: 'conn-yoko' })
    })

    it('keeps background, targeted and dry-run summaries under their own keys', async () => {
        const held = await lease()
        expect(await store.finishBackgroundRun({
            provider: CASH_ORDER_PROVIDER_V1, externalParkId: PARK, leaseToken: held.token, mode: 'write',
            status: 'failed', startedAt: new Date(), errorCode: 'provider_timeout', errorSummary: 'provider_timeout',
            apiConnectionId: 'conn-yoko', summary: { hot: { status: 'failed' } },
        })).toBe(true)
        await store.recordTargetedSummary({ provider: CASH_ORDER_PROVIDER_V1, externalParkId: PARK, summary: { outcome: 'decided' } })
        expect(await store.recordDryRunProgress({ ...held, dryRun: { cursor: 'x' } })).toBe(true)
        expect(await store.recordDryRunProgress({ checkpointId: held.checkpointId, token: 'other', dryRun: { cursor: 'y' } })).toBe(false)
        const stored = await checkpoint()
        expect(stored.lastRunSummary).toEqual({
            background: { hot: { status: 'failed' } },
            targeted: { outcome: 'decided' },
            dryRun: { cursor: 'x' },
        })
        expect(stored).toMatchObject({ lastRunStatus: 'failed', consecutiveFailures: 1, lastErrorCode: 'provider_timeout', lastRunMode: 'write' })
    })

    it('never lets a background status write overwrite another live holder', async () => {
        await lease()
        expect(await store.finishBackgroundRun({
            provider: CASH_ORDER_PROVIDER_V1, externalParkId: PARK, leaseToken: null, mode: 'write',
            status: 'failed', startedAt: new Date(), errorCode: 'ambiguous_active_connection',
            errorSummary: 'ambiguous_active_connection', apiConnectionId: null, summary: {},
        })).toBe(false)
        expect((await checkpoint()).lastRunStatus).toBeNull()
    })

    it('resets the failure count on success and records a failing park with no lease', async () => {
        const failure = {
            provider: CASH_ORDER_PROVIDER_V1, externalParkId: 'ext-no-row', leaseToken: null, mode: 'write' as const,
            status: 'failed' as const, startedAt: new Date(), errorCode: 'park_connection_missing',
            errorSummary: 'park_connection_missing', apiConnectionId: null, summary: {},
        }
        expect(await store.finishBackgroundRun(failure)).toBe(true)
        expect(await store.finishBackgroundRun(failure)).toBe(true)
        let read = await store.readCheckpoints(CASH_ORDER_PROVIDER_V1, ['ext-no-row'])
        expect(read.checkpoints[0]).toMatchObject({ consecutiveFailures: 2, lastErrorCode: 'park_connection_missing' })
        expect(await store.finishBackgroundRun({ ...failure, status: 'succeeded', errorCode: null, errorSummary: null })).toBe(true)
        read = await store.readCheckpoints(CASH_ORDER_PROVIDER_V1, ['ext-no-row'])
        expect(read.checkpoints[0]).toMatchObject({ consecutiveFailures: 0, lastErrorCode: null, lastRunStatus: 'succeeded' })
    })
})
