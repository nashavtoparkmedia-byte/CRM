/**
 * The read-only preflight against real PostgreSQL.
 *
 * Every claim here is a before/after comparison of actual rows, because the
 * invariant is about persistence and a mock cannot testify about that. The
 * probe runs with the production adapter as its one read capability and a fake
 * Fleet API for the provider; what must never appear or change is asserted by
 * reading the whole table, not a chosen column.
 *
 * Gated behind YOKO_COMPENSATION_MONETARY_POSTGRES_PROOF=1 and an isolated
 * DATABASE_URL.
 */

import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
    CashOrderIngestionPreflightV1,
    type CashOrderPreflightPortsV1,
} from './cash-order-ingestion-preflight'
import { legacyPrismaCashOrderIngestionStoreV1 as store } from './legacy-prisma-cash-order-ingestion-adapter'
import {
    CashOrderPreflightWriteAttemptV1,
    readOnlyCashOrderIngestionStoreV1,
} from './read-only-cash-order-ingestion-store'
import type { CashOrderPageRequestV1, CashOrderPageResponseV1 } from './yandex-cash-order-source'

const proof = process.env.YOKO_COMPENSATION_MONETARY_POSTGRES_PROOF === '1' ? describe : describe.skip

const PROVIDER = 'yandex_fleet'
const PARK = 'ext-preflight-proof'
const LOCAL = 'local-preflight'
const CONNECTION = 'conn-preflight'
const HOUR = 3_600_000

let database: PrismaClient

const snapshot = () => ({
    parks: [{ id: LOCAL, externalParkId: PARK }],
    links: [{
        linkId: 'link-preflight',
        localParkId: LOCAL,
        linkExternalParkId: PARK,
        parkExternalParkId: PARK,
        apiConnectionId: CONNECTION,
        apiConnectionParkId: PARK,
    }],
})

function order(id: string, bookedAt: Date, overrides: Record<string, unknown> = {}) {
    return {
        id,
        short_id: 202,
        status: 'complete',
        payment_method: 'cash',
        price: '410.0000',
        booked_at: bookedAt.toISOString(),
        ended_at: new Date(bookedAt.getTime() + 18 * 60_000).toISOString(),
        driver_profile: { id: 'profile-preflight' },
        ...overrides,
    }
}

/** The production read capability, with the fixed connection-metadata snapshot. */
const reader = {
    readAuthoritySnapshot: async () => ({
        dbNow: await store.readDatabaseNow(),
        snapshot: snapshot(),
    }),
}

function portsFor(
    respond: (request: CashOrderPageRequestV1, call: number) => CashOrderPageResponseV1,
): CashOrderPreflightPortsV1 {
    let calls = 0
    return {
        reader,
        loadCredentials: async () => [{
            connectionId: CONNECTION, localParkId: LOCAL, parkId: PARK, clid: 'clid', apiKey: 'key',
        }],
        fetchPage: async (request) => {
            calls += 1
            return respond(request, calls)
        },
        clock: { nowMs: () => performance.now() },
        wallNowMs: () => Date.now(),
        // Instant: these proofs are about what persists, not about how long the
        // provider backoff waits. Retry and throttle timing is covered by the
        // source's own tests and by cash-order-ingestion-preflight.test.ts.
        sleep: async () => {},
        random: () => 0,
    }
}

const servingOrders = (orders: Array<Record<string, unknown>>) =>
    (request: CashOrderPageRequestV1): CashOrderPageResponseV1 => ({
        ok: true,
        orders: orders
            .filter((raw) => {
                const bookedAt = Date.parse(String((raw as { booked_at: string }).booked_at))
                return bookedAt >= request.bookedFrom.getTime() && bookedAt <= request.bookedTo.getTime()
            })
            .map((raw) => structuredClone(raw)),
        cursor: null,
    })

const config = { mode: 'off' as const, enabledParks: [PARK], configError: null }

const runPreflight = (respond: (request: CashOrderPageRequestV1, call: number) => CashOrderPageResponseV1) =>
    new CashOrderIngestionPreflightV1(config, portsFor(respond)).run()

/** Whole-row state of everything the invariant protects. */
async function persistentState() {
    const orders = await database.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT * FROM "CompensationCashOrder" ORDER BY "id"`)
    const checkpoints = await database.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT * FROM "CompensationCashOrderIngestionCheckpoint" ORDER BY "id"`)
    return { orders, checkpoints }
}

async function cronHealthExists(): Promise<boolean> {
    const rows = await database.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT count(*) FROM information_schema.tables WHERE table_name = 'cron_health_log'`)
    return Number(rows[0].count) > 0
}

async function cronHealthRows(): Promise<Array<Record<string, unknown>>> {
    return database.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT cron_name, status, duration_ms, error_message FROM cron_health_log ORDER BY executed_at, cron_name`)
}

/** Seeds one real catalogue row and one real checkpoint through the production writer. */
async function seedWrittenState(bookedAt: Date): Promise<void> {
    const token = randomUUID()
    const acquisition = await store.acquireLease({ provider: PROVIDER, externalParkId: PARK, token })
    expect(acquisition.acquired).toBe(true)
    if (!acquisition.acquired) return
    await store.writePage({
        checkpointId: acquisition.checkpoint.id,
        leaseToken: token,
        provider: PROVIDER,
        externalParkId: PARK,
        sourceConnectionId: CONNECTION,
        accepted: [{
            id: `${PARK}:seeded`,
            externalOrderId: 'seeded',
            shortOrderIdDisplay: '202',
            externalDriverProfileId: 'profile-preflight',
            rawPrice: '410.0000',
            amountKopecks: 41_000,
            endedAt: new Date(bookedAt.getTime() + 18 * 60_000),
            providerBookedAt: bookedAt,
        }],
        removedOrderIds: [],
        progress: null,
    })
    await store.releaseLease({ checkpointId: acquisition.checkpoint.id, token })
}

proof('cash-order preflight on real PostgreSQL', () => {
    beforeAll(async () => {
        database = new PrismaClient()
        await database.$connect()
    })
    afterAll(async () => {
        await database.$executeRawUnsafe(
            'TRUNCATE TABLE "CompensationCashOrder","CompensationCashOrderIngestionCheckpoint" CASCADE')
        await database.$disconnect()
    })
    beforeEach(async () => {
        await database.$executeRawUnsafe(
            'TRUNCATE TABLE "CompensationCashOrder","CompensationCashOrderIngestionCheckpoint" CASCADE')
        await database.$executeRawUnsafe('DROP TABLE IF EXISTS cron_health_log')
    })

    it('A. leaves an absent checkpoint absent', async () => {
        const bookedAt = new Date(Date.now() - HOUR)
        expect((await persistentState()).checkpoints).toEqual([])

        const report = await runPreflight(servingOrders([order('o1', bookedAt)]))
        expect(report.ok).toBe(true)
        expect(report.parks[0]).toMatchObject({ authority: 'authoritative', credential: 'admitted', accepted: 1 })
        expect(report.sufficientToAuthorizeWriteMode).toBe(true)

        // The whole point: a run that read the provider created no checkpoint.
        expect((await persistentState()).checkpoints).toEqual([])
    })

    it('B + C. leaves an existing checkpoint and catalogue byte-identical', async () => {
        const bookedAt = new Date(Date.now() - HOUR)
        await seedWrittenState(bookedAt)
        const before = await persistentState()
        expect(before.checkpoints).toHaveLength(1)
        expect(before.orders).toHaveLength(1)

        const report = await runPreflight(servingOrders([order('seeded', bookedAt), order('fresh', bookedAt)]))
        expect(report.ok).toBe(true)

        const after = await persistentState()
        // Every column of every row, not a chosen subset.
        expect(after).toEqual(before)
        expect(after.orders).toHaveLength(1)
    })

    it('D. does not create cron_health_log', async () => {
        expect(await cronHealthExists()).toBe(false)
        await runPreflight(servingOrders([]))
        expect(await cronHealthExists()).toBe(false)
    })

    it('E. leaves an existing cron_health_log untouched', async () => {
        await database.$executeRawUnsafe(`
            CREATE TABLE cron_health_log (
                id SERIAL PRIMARY KEY,
                cron_name TEXT NOT NULL,
                status TEXT NOT NULL,
                executed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                duration_ms INTEGER,
                error_message TEXT,
                metadata JSONB
            )`)
        await database.$executeRawUnsafe(
            `INSERT INTO cron_health_log (cron_name, status, duration_ms) VALUES ('unrelated', 'ok', 5)`)
        const before = await cronHealthRows()

        await runPreflight(servingOrders([order('o1', new Date(Date.now() - HOUR))]))

        expect(await cronHealthRows()).toEqual(before)
        expect(before).toHaveLength(1)
    })

    it('F. is idempotent in persistent state across repeated runs', async () => {
        const bookedAt = new Date(Date.now() - HOUR)
        await seedWrittenState(bookedAt)
        const before = await persistentState()

        for (let run = 0; run < 3; run += 1) {
            const report = await runPreflight(servingOrders([order('seeded', bookedAt)]))
            expect(report.ok).toBe(true)
        }

        expect(await persistentState()).toEqual(before)
        expect(await cronHealthExists()).toBe(false)
    })

    it('G. fails closed on a provider failure and changes nothing', async () => {
        await seedWrittenState(new Date(Date.now() - HOUR))
        const before = await persistentState()

        const report = await runPreflight(() => ({ ok: false, kind: 'network' }))
        expect(report.parks[0]).toMatchObject({ provider: 'failed', sufficient: false })
        expect(report.sufficientToAuthorizeWriteMode).toBe(false)

        expect(await persistentState()).toEqual(before)
    })

    it('H. records a 429 without persisting a deferral', async () => {
        await seedWrittenState(new Date(Date.now() - HOUR))
        const before = await persistentState()
        const retryBefore = before.checkpoints[0].providerRetryNotBefore
        const retryConnection = before.checkpoints[0].providerRetryConnectionId

        const report = await runPreflight(() => ({ ok: false, kind: 'http', status: 429, retryAfter: '60' }))
        expect(report.parks[0].http429).toBeGreaterThan(0)
        expect(report.parks[0].sufficient).toBe(false)
        expect(report.sufficientToAuthorizeWriteMode).toBe(false)

        const after = await persistentState()
        expect(after).toEqual(before)
        // Named explicitly because this is the state the writer would have moved.
        expect(after.checkpoints[0].providerRetryNotBefore).toEqual(retryBefore)
        expect(after.checkpoints[0].providerRetryConnectionId).toEqual(retryConnection)
    })

    it('I. neither waits on nor changes a lease held by another token', async () => {
        const bookedAt = new Date(Date.now() - HOUR)
        const foreignToken = randomUUID()
        const acquisition = await store.acquireLease({ provider: PROVIDER, externalParkId: PARK, token: foreignToken })
        expect(acquisition.acquired).toBe(true)
        const before = await persistentState()
        expect(before.checkpoints[0].leaseToken).toBe(foreignToken)

        const started = Date.now()
        const report = await runPreflight(servingOrders([order('o1', bookedAt)]))
        const elapsed = Date.now() - started

        // It completed rather than blocking on a lease it never asks for.
        expect(report.ok).toBe(true)
        expect(report.parks[0].sufficient).toBe(true)
        expect(elapsed).toBeLessThan(30_000)

        const after = await persistentState()
        expect(after).toEqual(before)
        expect(after.checkpoints[0].leaseToken).toBe(foreignToken)
        expect(after.checkpoints[0].leaseExpiresAt).toEqual(before.checkpoints[0].leaseExpiresAt)
    })

    it('J. refuses a reconnected writer before any database mutation', async () => {
        await seedWrittenState(new Date(Date.now() - HOUR))
        const before = await persistentState()
        const guarded = readOnlyCashOrderIngestionStoreV1(reader)
        const checkpointId = String(before.checkpoints[0].id)

        // Each of these, given the real adapter, would mutate a row. Through the
        // capability the preflight actually holds they throw first.
        const mutations: Array<[string, () => Promise<unknown>]> = [
            ['acquireLease', () => guarded.acquireLease({ provider: PROVIDER, externalParkId: PARK, token: randomUUID() })],
            ['releaseLease', () => guarded.releaseLease({ checkpointId, token: randomUUID() })],
            ['recordDryRunProgress', () => guarded.recordDryRunProgress({ checkpointId, token: randomUUID(), dryRun: { passStartedAt: new Date().toISOString() } })],
            ['recordDeferral', () => guarded.recordDeferral({ checkpointId, token: randomUUID(), seconds: 60, connectionId: CONNECTION })],
            ['finishBackgroundRun', () => guarded.finishBackgroundRun({
                provider: PROVIDER,
                externalParkId: PARK,
                mode: 'write',
                status: 'succeeded',
                startedAt: new Date(),
                errorCode: null,
                errorSummary: null,
                apiConnectionId: CONNECTION,
                summary: {},
                leaseToken: null,
            })],
            ['writePage', () => guarded.writePage({
                checkpointId,
                leaseToken: randomUUID(),
                provider: PROVIDER,
                externalParkId: PARK,
                sourceConnectionId: CONNECTION,
                accepted: [{
                    id: `${PARK}:smuggled`,
                    externalOrderId: 'smuggled',
                    shortOrderIdDisplay: '999',
                    externalDriverProfileId: 'profile-preflight',
                    rawPrice: '1.0000',
                    amountKopecks: 100,
                    endedAt: new Date(),
                    providerBookedAt: new Date(),
                }],
                removedOrderIds: [],
                progress: null,
            })],
        ]
        for (const [method, call] of mutations) {
            await expect(call()).rejects.toThrow(CashOrderPreflightWriteAttemptV1)
            await expect(call()).rejects.toThrow(method)
        }

        // Nothing landed, including the row writePage was handed.
        expect(await persistentState()).toEqual(before)
        const smuggled = await database.$queryRawUnsafe<Array<{ id: string }>>(
            `SELECT "id" FROM "CompensationCashOrder" WHERE "externalOrderId" = 'smuggled'`)
        expect(smuggled).toEqual([])
    })

    it('refuses to run at all while ingestion is in write mode', async () => {
        await seedWrittenState(new Date(Date.now() - HOUR))
        const before = await persistentState()
        let providerCalls = 0

        const report = await new CashOrderIngestionPreflightV1(
            { mode: 'write', enabledParks: [PARK], configError: null },
            portsFor(() => {
                providerCalls += 1
                return { ok: true, orders: [], cursor: null }
            }),
        ).run()

        expect(report).toMatchObject({ ok: false, refusal: 'ingestion_mode_write' })
        expect(providerCalls).toBe(0)
        expect(await persistentState()).toEqual(before)
    })
})
