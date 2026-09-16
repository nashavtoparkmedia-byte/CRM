/**
 * The ingestion runtime end to end on real PostgreSQL: the production adapter
 * for every write, a fake Fleet API for every read. Park and link metadata
 * come from a fixed snapshot, because those tables belong to the connection
 * lifecycle rather than to this migration.
 *
 * Gated behind YOKO_COMPENSATION_MONETARY_POSTGRES_PROOF=1 and an isolated
 * DATABASE_URL.
 */

import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
    cashOrderConfirmationForOrderV1,
    CashOrderIngestionRuntimeV1,
    type CashOrderIngestionPortsV1,
} from './cash-order-ingestion-runtime'
import type { CashOrderIngestionStoreV1 } from './cash-order-ingestion-store'
import type { CashOrderPageRequestV1, CashOrderPageResponseV1 } from './yandex-cash-order-source'
import { legacyPrismaCashOrderIngestionStoreV1 } from './legacy-prisma-cash-order-ingestion-adapter'

const proof = process.env.YOKO_COMPENSATION_MONETARY_POSTGRES_PROOF === '1' ? describe : describe.skip

const PARK = 'ext-runtime-proof'
const HOUR = 3_600_000

let database: PrismaClient

type FleetOrder = Record<string, unknown> & { id: string; booked_at: string }

function fleet(orders: FleetOrder[]) {
    const requests: CashOrderPageRequestV1[] = []
    const fetchPage = async (request: CashOrderPageRequestV1): Promise<CashOrderPageResponseV1> => {
        requests.push(request)
        const matching = orders
            .filter((order) => {
                const bookedAt = Date.parse(order.booked_at)
                return bookedAt >= request.bookedFrom.getTime() && bookedAt <= request.bookedTo.getTime()
            })
            .map((order) => structuredClone(order))
        return { ok: true, orders: matching, cursor: null }
    }
    return { requests, fetchPage }
}

function order(id: string, bookedAt: Date, overrides: Record<string, unknown> = {}): FleetOrder {
    return {
        id,
        short_id: 101,
        status: 'complete',
        payment_method: 'cash',
        price: '335.0000',
        booked_at: bookedAt.toISOString(),
        ended_at: new Date(bookedAt.getTime() + 20 * 60_000).toISOString(),
        driver_profile: { id: 'profile-runtime' },
        ...overrides,
    }
}

function runtimeFor(mode: 'dry_run' | 'write', fetchPage: CashOrderIngestionPortsV1['fetchPage']) {
    const store: CashOrderIngestionStoreV1 = {
        ...legacyPrismaCashOrderIngestionStoreV1,
        readAuthoritySnapshot: async () => ({
            dbNow: await legacyPrismaCashOrderIngestionStoreV1.readDatabaseNow(),
            snapshot: {
                parks: [{ id: 'local-runtime', externalParkId: PARK }],
                links: [{
                    linkId: 'link-runtime',
                    localParkId: 'local-runtime',
                    linkExternalParkId: PARK,
                    parkExternalParkId: PARK,
                    apiConnectionId: 'conn-runtime',
                    apiConnectionParkId: PARK,
                }],
            },
        }),
    }
    return new CashOrderIngestionRuntimeV1({ mode, enabledParks: [PARK], configError: null }, {
        store,
        loadCredentials: async () => [{ connectionId: 'conn-runtime', localParkId: 'local-runtime', parkId: PARK, clid: 'clid', apiKey: 'key' }],
        fetchPage,
        clock: { nowMs: () => performance.now() },
        wallNowMs: () => Date.now(),
        sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.() }),
        random: () => 0,
        newToken: () => randomUUID(),
        log: () => undefined,
    })
}

async function stored(orderId: string) {
    const rows = await database.$queryRawUnsafe<Array<{ sourceConnectionId: string; providerBookedAt: Date | null; observedAt: Date }>>(
        `SELECT "sourceConnectionId","providerBookedAt","observedAt" FROM "CompensationCashOrder"
         WHERE "externalParkId" = $1 AND "externalOrderId" = $2`,
        PARK, orderId,
    )
    return rows[0] ?? null
}

async function checkpoint() {
    const read = await legacyPrismaCashOrderIngestionStoreV1.readCheckpoints('yandex_fleet', [PARK])
    return read.checkpoints[0]
}

async function truncate(): Promise<void> {
    await database.$executeRawUnsafe(
        'TRUNCATE TABLE "CompensationCashOrder","CompensationCashOrderIngestionCheckpoint" RESTART IDENTITY CASCADE')
}

proof('cash-order ingestion runtime on real PostgreSQL', () => {
    beforeAll(async () => {
        database = new PrismaClient()
        await database.$connect()
    })
    beforeEach(truncate)
    afterAll(async () => {
        await truncate()
        await database.$disconnect()
    })

    it('writes the hot window, freshness and a complete initial backfill in one tick', async () => {
        const now = Date.now()
        const source = fleet([
            order('hot', new Date(now - HOUR)),
            order('backfill', new Date(now - 30 * HOUR)),
            order('cancelled', new Date(now - 40 * HOUR), { status: 'cancelled' }),
        ])
        const result = await runtimeFor('write', source.fetchPage).runTick()
        expect(result.errors).toEqual([])
        expect(result.parks[0].reconciliation?.status).toBe('complete')
        expect(await stored('hot')).toMatchObject({ sourceConnectionId: 'conn-runtime' })
        expect(await stored('backfill')).not.toBeNull()
        expect(await stored('cancelled')).toBeNull()
        const row = await checkpoint()
        expect(row).toMatchObject({ lastRunMode: 'write', lastRunStatus: 'succeeded', leaseToken: null, lastApiConnectionId: 'conn-runtime' })
        expect(row.lastHotSuccessAt).not.toBeNull()
        expect(row.lastReconciliationCompletedAt).not.toBeNull()
        expect(row.lastReconciliationCompletedAt!.getTime()).toBeGreaterThanOrEqual(row.reconciliationPassStartedAt!.getTime())
    })

    it('writes no order and no freshness in dry_run, only its own progress', async () => {
        const source = fleet([order('hot', new Date(Date.now() - HOUR))])
        const result = await runtimeFor('dry_run', source.fetchPage).runTick()
        expect(result.errors).toEqual([])
        expect(source.requests.length).toBeGreaterThan(1)
        expect(await stored('hot')).toBeNull()
        const row = await checkpoint()
        expect(row).toMatchObject({ lastRunMode: 'dry_run', lastHotSuccessAt: null, reconciliationCursorBookedAt: null, lastReconciliationCompletedAt: null })
        expect(row.lastRunSummary?.dryRun).toMatchObject({ passStartedAt: expect.any(String) })
    })

    it('confirms one order with a narrow query and removes it once the provider disqualifies it', async () => {
        const bookedAt = new Date(Date.now() - 2 * HOUR)
        const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Yekaterinburg' }).format(new Date(bookedAt.getTime() + 20 * 60_000))
        const orders = [order('target', bookedAt)]
        const source = fleet(orders)
        const runtime = runtimeFor('write', source.fetchPage)

        expect((await runtime.requestDayConfirmation({ externalParkId: PARK, dayKey, order: { externalOrderId: 'target', providerBookedAt: bookedAt } })).status).toBe('scheduled')
        await runtime.dayConfirmationSettled(PARK, dayKey)
        expect(cashOrderConfirmationForOrderV1(runtime.readDayConfirmation(PARK, dayKey), 'target')).toMatchObject({ state: 'confirmed', via: 'narrow' })
        expect(source.requests).toHaveLength(1)
        expect((await stored('target'))?.providerBookedAt?.toISOString()).toBe(bookedAt.toISOString())
        expect((await checkpoint()).lastHotSuccessAt).toBeNull()

        orders[0].payment_method = 'cashless'
        expect((await runtime.requestDayConfirmation({ externalParkId: PARK, dayKey, order: { externalOrderId: 'target', providerBookedAt: bookedAt } })).status).toBe('scheduled')
        await runtime.dayConfirmationSettled(PARK, dayKey)
        expect(cashOrderConfirmationForOrderV1(runtime.readDayConfirmation(PARK, dayKey), 'target')).toMatchObject({ state: 'removed' })
        expect(await stored('target')).toBeNull()
    })
})
