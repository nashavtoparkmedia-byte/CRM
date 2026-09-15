/**
 * The full pilot chain on real PostgreSQL, end to end:
 *
 *   Fleet completed cash order
 *     → persisted verified cash-order projection
 *       → eligibility
 *         → C1 application
 *
 * Gated behind YOKO_COMPENSATION_MONETARY_POSTGRES_PROOF=1 and an isolated
 * DATABASE_URL. The monetary core is called through its real entry point with
 * its real rules; nothing here re-implements or relaxes them.
 */

import { createHash, randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
    compensationMonthEndInstantV1,
    compensationMonthStartInstantV1,
} from './compensation-calendar'
import {
    cashOrderBudgetPeriodKeyV1,
    cashOrderCatalogueV1,
    cashOrderRowIdV1,
    ingestCashOrderPageV1,
    type CashOrderIngestionPortV1,
    type StoredCashOrderV1,
} from './compensation-cash-order-ingestion'
import type { CashOrderRequestContextV1 } from './compensation-cash-order-projection'
import { compensationPeriodSubmissionClosesAtV1 } from './compensation-submission-window'
import { submitCompensationApplicationV1 } from './compensation-prisma-adapter'
import { SUBMIT_COMPENSATION_APPLICATION_COMMAND_V1 } from '../../../../contracts/fleet-operations/v1'

const proof = process.env.YOKO_COMPENSATION_MONETARY_POSTGRES_PROOF === '1' ? describe : describe.skip

const SEPTEMBER = { year: 2026, month: 9 }
const AUGUST = { year: 2026, month: 8 }
const PARK = 'park-yoko-1'
const PROFILE = 'b'.repeat(32)
const NOW = new Date('2026-09-20T09:00:00.000Z')

let database: PrismaClient

const CONTEXT: CashOrderRequestContextV1 = {
    provider: 'yandex_fleet',
    externalParkId: PARK,
    apiConnectionId: 'conn-1',
    observedAt: new Date('2026-09-20T08:00:00.000Z'),
}

/** Writes through the same unique provider identity the production adapter uses. */
function ingestionPort(): CashOrderIngestionPortV1 {
    return {
        async upsertCashOrder(row) {
            await database.$executeRawUnsafe(
                `INSERT INTO "CompensationCashOrder"
                   ("id","provider","externalParkId","externalOrderId","shortOrderIdDisplay",
                    "externalDriverProfileId","rawPrice","amountKopecks","endedAt","observedAt",
                    "createdAt","updatedAt")
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),NOW())
                 ON CONFLICT ("provider","externalParkId","externalOrderId") DO UPDATE SET
                   "shortOrderIdDisplay" = EXCLUDED."shortOrderIdDisplay",
                   "rawPrice" = EXCLUDED."rawPrice",
                   "amountKopecks" = EXCLUDED."amountKopecks",
                   "endedAt" = EXCLUDED."endedAt",
                   "observedAt" = EXCLUDED."observedAt",
                   "updatedAt" = NOW()`,
                row.id, row.provider, row.externalParkId, row.externalOrderId,
                row.shortOrderIdDisplay, row.externalDriverProfileId, row.rawPrice,
                row.amountKopecks, row.endedAt, row.observedAt,
            )
        },
    }
}

/** A live-shaped Fleet order. */
function fleetOrder(overrides: Record<string, unknown> = {}) {
    return {
        id: 'a'.repeat(32),
        short_id: 3982091,
        status: 'complete',
        payment_method: 'cash',
        price: '335.0000',
        ended_at: '2026-09-12T10:24:59.982+00:00',
        driver_profile: { id: PROFILE, name: 'never read' },
        ...overrides,
    }
}

async function storedOrders(): Promise<StoredCashOrderV1[]> {
    const rows = await database.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT "id","provider","externalParkId","externalOrderId","shortOrderIdDisplay",
                "externalDriverProfileId","rawPrice","amountKopecks","endedAt"
         FROM "CompensationCashOrder"
         WHERE "externalParkId" = $1 AND "externalDriverProfileId" = $2`,
        PARK, PROFILE,
    )
    return rows.map((row) => ({
        id: String(row.id),
        provider: String(row.provider),
        externalParkId: String(row.externalParkId),
        externalOrderId: String(row.externalOrderId),
        shortOrderIdDisplay: row.shortOrderIdDisplay === null ? null : String(row.shortOrderIdDisplay),
        externalDriverProfileId: String(row.externalDriverProfileId),
        rawPrice: String(row.rawPrice),
        amountKopecks: Number(row.amountKopecks),
        endedAt: new Date(row.endedAt as string),
    }))
}

function provenPerson(contactId: string) {
    return {
        canonicalContactId: contactId,
        resolutionStatus: 'live' as const,
        lineage: [contactId],
        lineageDigest: createHash('sha256').update(contactId).digest('hex'),
        evidenceAt: NOW,
    }
}

async function openPeriod(month: { year: number; month: number }, limitKopecks = 500_000): Promise<void> {
    const key = `${month.year}-${String(month.month).padStart(2, '0')}`
    await database.$executeRawUnsafe(
        `INSERT INTO "CompensationBudgetPeriod"
            ("id","periodKey","periodStartsAt","periodEndsAt","submissionClosesAt","limitKopecks",
             "reservedKopecks","settledKopecks","state","openedAt","createdAt","updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,0,0,'open',NOW(),NOW(),NOW())
         ON CONFLICT ("periodKey") DO NOTHING`,
        `period_${key}`, key,
        compensationMonthStartInstantV1(month),
        compensationMonthEndInstantV1(month),
        compensationPeriodSubmissionClosesAtV1(month),
        limitKopecks,
    )
}

async function truncateAll(): Promise<void> {
    await database.$executeRawUnsafe(`TRUNCATE TABLE
        "CompensationAuditEvent","CompensationReconciliationTask","CompensationSettlement",
        "CompensationPayoutAuthorization","CompensationApplication","CompensationOrderClaim",
        "CompensationVerifiedOrder","CompensationPersonBinding","CompensationPerson",
        "CompensationBudgetPeriod","CompensationCashOrder" RESTART IDENTITY CASCADE`)
}

/** Eligible: park-SMZ, hired inside the current calendar month. */
const ELIGIBLE_FACTS = {
    isSelfEmployed: true,
    employmentType: 'selfemployed',
    parkHireDate: new Date('2026-09-02T06:00:00.000Z'),
}

proof('cash order chain on real PostgreSQL', () => {
    beforeAll(async () => {
        database = new PrismaClient()
        await database.$connect()
    })
    afterAll(async () => {
        await truncateAll()
        await database.$disconnect()
    })
    beforeEach(async () => {
        await truncateAll()
        await openPeriod(AUGUST)
        await openPeriod(SEPTEMBER)
    })

    it('runs the whole chain: fleet order, projection, eligibility, application', async () => {
        const ingestion = await ingestCashOrderPageV1([fleetOrder()], CONTEXT, ingestionPort())
        expect(ingestion.ingested).toBe(1)

        const catalogue = cashOrderCatalogueV1(ELIGIBLE_FACTS, await storedOrders(), NOW)
        expect(catalogue.eligible).toBe(true)
        if (!catalogue.eligible) return
        expect(catalogue.orders).toHaveLength(1)

        const chosen = catalogue.orders[0]
        const result = await submitCompensationApplicationV1({
            contract: SUBMIT_COMPENSATION_APPLICATION_COMMAND_V1,
            idempotencyKey: randomUUID(),
            person: provenPerson('contact-1'),
            order: {
                provider: chosen.provider,
                externalParkId: chosen.externalParkId,
                externalOrderId: chosen.externalOrderId,
                shortOrderIdDisplay: chosen.shortOrderIdDisplay,
                rawPrice: chosen.rawPrice,
                endedAt: chosen.endedAt,
                verifiedAt: CONTEXT.observedAt,
            },
            claimedRubles: 300,
            submittedAt: NOW,
        })

        expect(result.status).toBe('created')
        // Claimed 300 RUB against a 335 RUB order: the monetary core takes the
        // lower of the two, unchanged by anything in this branch.
        expect(result.amountKopecks).toBe(30_000)
        expect(result.budgetPeriodKey).toBe('2026-09')
    })

    it('ingests idempotently: the same page twice is one order', async () => {
        await ingestCashOrderPageV1([fleetOrder()], CONTEXT, ingestionPort())
        await ingestCashOrderPageV1([fleetOrder()], CONTEXT, ingestionPort())

        const rows = await storedOrders()
        expect(rows).toHaveLength(1)
        expect(rows[0].id).toBe(cashOrderRowIdV1({
            provider: 'yandex_fleet', externalParkId: PARK, externalOrderId: 'a'.repeat(32),
        }))
    })

    it('keeps one external order per park, and separates the same id in another park', async () => {
        await ingestCashOrderPageV1([fleetOrder()], CONTEXT, ingestionPort())
        await ingestCashOrderPageV1([fleetOrder()], { ...CONTEXT, externalParkId: 'park-yoko-2' }, ingestionPort())

        const all = await database.$queryRawUnsafe<Array<{ count: bigint }>>(
            'SELECT count(*) AS count FROM "CompensationCashOrder"')
        expect(Number(all[0].count)).toBe(2)
    })

    it('never ingests a running or cashless order', async () => {
        const result = await ingestCashOrderPageV1([
            fleetOrder({ id: 'c'.repeat(32), status: 'driving', payment_method: null, ended_at: null }),
            fleetOrder({ id: 'd'.repeat(32), payment_method: 'cashless' }),
            fleetOrder({ id: 'e'.repeat(32), status: 'cancelled', payment_method: 'cash' }),
        ], CONTEXT, ingestionPort())

        expect(result.ingested).toBe(0)
        expect(result.rejected.map((r) => r.reason)).toEqual(['not_completed', 'not_cash', 'not_completed'])
        expect(await storedOrders()).toHaveLength(0)
    })

    it('the database refuses a price that is not four decimals', async () => {
        await expect(database.$executeRawUnsafe(
            `INSERT INTO "CompensationCashOrder"
               ("id","provider","externalParkId","externalOrderId","externalDriverProfileId",
                "rawPrice","amountKopecks","endedAt","observedAt","createdAt","updatedAt")
             VALUES ('x','yandex_fleet',$1,'zzz',$2,'335.00',33500,NOW(),NOW(),NOW(),NOW())`,
            PARK, PROFILE,
        )).rejects.toThrow()
    })

    it('shows nothing to a driver who is not park-SMZ', async () => {
        await ingestCashOrderPageV1([fleetOrder()], CONTEXT, ingestionPort())
        const catalogue = cashOrderCatalogueV1(
            { isSelfEmployed: false, employmentType: 'park_employee', parkHireDate: ELIGIBLE_FACTS.parkHireDate },
            await storedOrders(), NOW,
        )
        expect(catalogue).toMatchObject({ eligible: false, reason: 'not_self_employed', orders: [] })
    })

    it('shows nothing to an individual entrepreneur', async () => {
        await ingestCashOrderPageV1([fleetOrder()], CONTEXT, ingestionPort())
        const catalogue = cashOrderCatalogueV1(
            { isSelfEmployed: false, employmentType: 'individual_entrepreneur', parkHireDate: ELIGIBLE_FACTS.parkHireDate },
            await storedOrders(), NOW,
        )
        expect(catalogue).toMatchObject({ eligible: false, reason: 'not_self_employed' })
    })

    it('fails closed when the park never stated self-employment', async () => {
        await ingestCashOrderPageV1([fleetOrder()], CONTEXT, ingestionPort())
        const catalogue = cashOrderCatalogueV1(
            { isSelfEmployed: null, employmentType: null, parkHireDate: ELIGIBLE_FACTS.parkHireDate },
            await storedOrders(), NOW,
        )
        expect(catalogue).toMatchObject({ eligible: false, reason: 'self_employment_unknown' })
    })

    it('shows nothing once the first calendar month has passed', async () => {
        await ingestCashOrderPageV1([fleetOrder()], CONTEXT, ingestionPort())
        const catalogue = cashOrderCatalogueV1(
            ELIGIBLE_FACTS, await storedOrders(), new Date('2026-10-02T09:00:00.000Z'),
        )
        expect(catalogue).toMatchObject({ eligible: false, reason: 'outside_first_calendar_month' })
    })

    it('charges an August order to the August period even when submitted in September', async () => {
        // 31 Aug 18:00 Yekaterinburg, ingested and claimed on 2 September.
        const augustOrder = fleetOrder({
            id: 'f'.repeat(32),
            ended_at: '2026-08-31T13:00:00.000Z',
            price: '306.0000',
        })
        await ingestCashOrderPageV1([augustOrder], CONTEXT, ingestionPort())
        const rows = await storedOrders()
        expect(cashOrderBudgetPeriodKeyV1(rows[0])).toBe('2026-08')

        const result = await submitCompensationApplicationV1({
            contract: SUBMIT_COMPENSATION_APPLICATION_COMMAND_V1,
            idempotencyKey: randomUUID(),
            person: provenPerson('contact-2'),
            order: {
                provider: rows[0].provider,
                externalParkId: rows[0].externalParkId,
                externalOrderId: rows[0].externalOrderId,
                shortOrderIdDisplay: rows[0].shortOrderIdDisplay,
                rawPrice: rows[0].rawPrice,
                endedAt: rows[0].endedAt,
                verifiedAt: new Date('2026-08-31T13:05:00.000Z'),
            },
            claimedRubles: 306,
            submittedAt: new Date('2026-09-02T09:00:00.000Z'),
        })

        // The budget period follows the order month, not the submission month.
        expect(result.budgetPeriodKey).toBe('2026-08')
        expect(result.amountKopecks).toBe(30_600)
    })

    it('confines the catalogue to the driver hire month', async () => {
        await ingestCashOrderPageV1([
            fleetOrder({ id: 'g'.repeat(32), ended_at: '2026-09-12T10:00:00.000Z' }),
            fleetOrder({ id: 'h'.repeat(32), ended_at: '2026-08-20T10:00:00.000Z' }),
        ], CONTEXT, ingestionPort())

        const catalogue = cashOrderCatalogueV1(ELIGIBLE_FACTS, await storedOrders(), NOW)
        expect(catalogue.eligible).toBe(true)
        if (!catalogue.eligible) return
        expect(catalogue.orders.map((o) => o.externalOrderId)).toEqual(['g'.repeat(32)])
    })
})
