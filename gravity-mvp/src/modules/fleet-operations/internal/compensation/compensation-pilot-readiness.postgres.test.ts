/**
 * Pilot readiness against real PostgreSQL.
 *
 * The claims that need a real database are the correlation ones: that an order
 * belonging to another park or another driver profile is never counted for this
 * candidate, that a claimed order stops counting, and that a budget row is read
 * as it is written. A fake port cannot testify about the SQL that does the
 * scoping, so the production adapters do the reading here.
 *
 * The other half is what must NOT happen. Readiness is a proof, not a step: the
 * whole content of every table it can see is hashed before and after, and the
 * cron health table must not come into existence.
 *
 * Gated behind YOKO_COMPENSATION_MONETARY_POSTGRES_PROOF=1 and an isolated
 * DATABASE_URL.
 */

import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
    compensationCalendarMonthV1,
    compensationMonthEndInstantV1,
    compensationMonthStartInstantV1,
    compensationPeriodKeyV1,
} from './compensation-calendar'
import { CASH_ORDER_PROVIDER_V1 } from './cash-order-ingestion-store'
import { legacyPrismaCashOrderIngestionStoreV1 } from './legacy-prisma-cash-order-ingestion-adapter'
import { pilotCatalogueStatusV1 } from './compensation-pilot-selection'
import { compensationPeriodSubmissionClosesAtV1 } from './compensation-submission-window'
import {
    compensationPilotReadinessReportV1,
    type CompensationPilotReadinessIngestionPortV1,
} from './compensation-pilot-readiness-service'
import { legacyPrismaCompensationPilotPortV1 } from './legacy-prisma-compensation-pilot-adapter'
import { legacyPrismaCompensationPilotReadinessPortV1 } from './legacy-prisma-compensation-pilot-readiness-adapter'
import type { CompensationPilotTelegramLinkReaderV1 } from '../../public/v1/compensation-pilot-telegram-link-reader'

const proof = process.env.YOKO_COMPENSATION_MONETARY_POSTGRES_PROOF === '1' ? describe : describe.skip

const PARK = 'ext-park-ready'
const OTHER_PARK = 'ext-park-ready-other'
const PROFILE = 'profile-ready-1'
const OTHER_PROFILE = 'profile-ready-2'
const DRIVER_ID = 'pilot-ready-driver-1'
const OTHER_DRIVER_ID = 'pilot-ready-driver-2'
const CONTACT_ID = 'pilot-ready-contact-1'
const OTHER_CONTACT_ID = 'pilot-ready-contact-2'
const TELEGRAM_ID = 880000000001n

const NOW = new Date()
const MONTH = compensationCalendarMonthV1(NOW)
const MONTH_START = compensationMonthStartInstantV1(MONTH)
const PERIOD_KEY = compensationPeriodKeyV1(MONTH)
const ORDER_ENDED_AT = new Date(Math.min(MONTH_START.getTime() + 3_600_000, NOW.getTime() - 60_000))

let database: PrismaClient

/** The tables readiness can see; none of them may change while it runs. */
const WATCHED_TABLES = [
    'Driver', 'DriverTelegram', 'Contact', 'CompensationCashOrder',
    'CompensationCashOrderIngestionCheckpoint', 'CompensationBudgetPeriod',
    'CompensationApplication', 'CompensationPerson', 'CompensationPersonBinding',
    'CompensationOrderClaim', 'CompensationVerifiedOrder', 'CompensationPilotSubmission',
]

/**
 * A digest of the whole content of one table, not of a chosen column: a write
 * anywhere in any row changes it.
 */
async function tableDigest(table: string): Promise<string> {
    const rows = await database.$queryRawUnsafe<Array<{ digest: string | null; rows: bigint }>>(
        `SELECT md5(string_agg(t.line, E'\\n' ORDER BY t.line)) AS digest, count(*) AS rows
         FROM (SELECT "${table}"::text AS line FROM "${table}") t`,
    )
    return `${table}:${rows[0].rows}:${rows[0].digest ?? 'empty'}`
}

const snapshotAll = async () => (await Promise.all(WATCHED_TABLES.map(tableDigest))).join('|')

/** Schema-local, because a database-wide count sees other schemas' copies. */
async function cronHealthExistsHere(): Promise<boolean> {
    const rows = await database.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT count(*) AS count FROM information_schema.tables
         WHERE table_schema = current_schema() AND table_name = 'cron_health_log'`,
    )
    return Number(rows[0].count) > 0
}

async function truncateAll(): Promise<void> {
    await database.$executeRawUnsafe(`TRUNCATE TABLE
        "CompensationPilotSubmission","CompensationAuditEvent","CompensationReconciliationTask",
        "CompensationSettlement","CompensationPayoutAuthorization","CompensationApplication",
        "CompensationOrderClaim","CompensationVerifiedOrder","CompensationPersonBinding",
        "CompensationPerson","CompensationBudgetPeriod","CompensationCashOrder",
        "CompensationCashOrderIngestionCheckpoint"
        RESTART IDENTITY CASCADE`)
    await database.$executeRawUnsafe(`DELETE FROM "DriverTelegram" WHERE "driverId" LIKE 'pilot-ready-%'`)
    await database.$executeRawUnsafe(`DELETE FROM "Contact" WHERE "id" LIKE 'pilot-ready-%'`)
    await database.$executeRawUnsafe(`DELETE FROM "Driver" WHERE "id" LIKE 'pilot-ready-%'`)
}

/**
 * Driver and Contact reference each other, so the row order matters: the driver
 * first with no contact, then the contact naming it as its main driver, then the
 * Fleet projection back to the contact.
 */
async function seedDriverRow(input: {
    driverId: string
    externalParkId: string
    externalDriverProfileId: string
}): Promise<void> {
    await database.$executeRawUnsafe(
        `INSERT INTO "Driver"
           ("id","yandexDriverId","fullName","externalParkId","externalDriverProfileId",
            "isSelfEmployed","employmentType","yandexHireDate","updatedAt")
         VALUES ($1,$2,'Pilot Readiness Driver',$3,$4,true,'selfemployed',$5,NOW())`,
        input.driverId, `park-profile:${input.driverId}`, input.externalParkId,
        input.externalDriverProfileId, MONTH_START,
    )
}

/** The Contact is the person authority; Driver.contactId only names a candidate. */
async function seedContact(contactId: string, options: {
    mainDriverId?: string | null
    confirmedFor?: string | null
} = {}): Promise<void> {
    const confirmations = options.confirmedFor
        ? { driverConfirmations: [{ status: 'confirmed', representativeDriverId: options.confirmedFor }] }
        : {}
    await database.$executeRawUnsafe(
        `INSERT INTO "Contact" ("id","displayName","mainDriverId","customFields","updatedAt")
         VALUES ($1,'Pilot Readiness Person',$2,$3::jsonb,NOW())`,
        contactId, options.mainDriverId ?? null, JSON.stringify(confirmations),
    )
}

async function linkDriverContact(driverId: string, contactId: string): Promise<void> {
    await database.$executeRawUnsafe(
        `UPDATE "Driver" SET "contactId" = $1 WHERE "id" = $2`, contactId, driverId)
}

/** A driver Contacts fully confirms: the Gate-1 identity facts, all aligned. */
async function seedConfirmedDriver(input: {
    driverId: string
    contactId: string
    externalParkId: string
    externalDriverProfileId: string
}): Promise<void> {
    await seedDriverRow(input)
    await seedContact(input.contactId, { mainDriverId: input.driverId, confirmedFor: input.driverId })
    await linkDriverContact(input.driverId, input.contactId)
}

async function seedTelegramLink(driverId: string, telegramId: bigint, activeParkId: string | null): Promise<void> {
    await database.$executeRawUnsafe(
        `INSERT INTO "DriverTelegram" ("id","driverId","telegramId","activeParkId","createdAt")
         VALUES ($1,$2,$3,$4,NOW())`,
        `tg-${driverId}`, driverId, telegramId, activeParkId,
    )
}

async function seedCashOrder(input: {
    externalOrderId: string
    externalParkId?: string
    externalDriverProfileId?: string
    amountKopecks?: number
    observedMinutesAgo?: number
}): Promise<void> {
    await database.$executeRawUnsafe(
        `INSERT INTO "CompensationCashOrder"
           ("id","provider","externalParkId","externalOrderId","shortOrderIdDisplay",
            "externalDriverProfileId","rawPrice","amountKopecks","endedAt","observedAt",
            "createdAt","updatedAt")
         VALUES ($1,$2,$3,$4,'4242',$5,'500.0000',$6,$7,
                 NOW() - ($8 || ' minutes')::interval, NOW(), NOW())`,
        `row-${input.externalOrderId}`, CASH_ORDER_PROVIDER_V1,
        input.externalParkId ?? PARK, input.externalOrderId,
        input.externalDriverProfileId ?? PROFILE,
        input.amountKopecks ?? 50_000, ORDER_ENDED_AT,
        String(input.observedMinutesAgo ?? 30),
    )
}

async function openPeriod(limitKopecks = 500_000, reservedKopecks = 0): Promise<void> {
    await database.$executeRawUnsafe(
        `INSERT INTO "CompensationBudgetPeriod"
            ("id","periodKey","periodStartsAt","periodEndsAt","submissionClosesAt","limitKopecks",
             "reservedKopecks","settledKopecks","state","openedAt","createdAt","updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,0,'open',NOW(),NOW(),NOW())
         ON CONFLICT ("periodKey") DO NOTHING`,
        `period_${PERIOD_KEY}`, PERIOD_KEY,
        MONTH_START, compensationMonthEndInstantV1(MONTH),
        compensationPeriodSubmissionClosesAtV1(MONTH), limitKopecks, reservedKopecks,
    )
}

/** A checkpoint whose hot pass is recent and whose month is fully covered. */
async function seedReadyCheckpoint(externalParkId = PARK): Promise<void> {
    await database.$executeRawUnsafe(
        `INSERT INTO "CompensationCashOrderIngestionCheckpoint"
           ("id","provider","externalParkId","lastHotSuccessAt","lastReconciliationCompletedAt",
            "createdAt","updatedAt")
         VALUES ($1,$2,$3,NOW(),NOW(),NOW(),NOW())
         ON CONFLICT ("provider","externalParkId") DO NOTHING`,
        `checkpoint-${externalParkId}`, CASH_ORDER_PROVIDER_V1, externalParkId,
    )
}

/**
 * The real store read and the real status rule; only the configured mode and
 * park enablement are supplied, because those come from the environment.
 */
function ingestionPort(options: { mode?: string; parkEnabled?: boolean } = {}): CompensationPilotReadinessIngestionPortV1 {
    const mode = options.mode ?? 'write'
    const parkEnabled = options.parkEnabled ?? true
    return {
        parkScope: () => ({ mode, enabledParks: [PARK], configError: null }),
        readParkAuthority: async () => ({ status: 'authoritative', code: null }),
        async readCatalogueFacts(externalParkId) {
            const read = await legacyPrismaCashOrderIngestionStoreV1.readCheckpoints(
                CASH_ORDER_PROVIDER_V1, [externalParkId],
            )
            const checkpoint = read.checkpoints.find((row) => row.externalParkId === externalParkId) ?? null
            return {
                mode,
                parkEnabled,
                dbNow: read.dbNow,
                lastHotSuccessAt: checkpoint?.lastHotSuccessAt ?? null,
                reconciliationPassStartedAt: checkpoint?.reconciliationPassStartedAt ?? null,
                reconciliationFloorBookedAt: checkpoint?.reconciliationFloorBookedAt ?? null,
                reconciliationCursorBookedAt: checkpoint?.reconciliationCursorBookedAt ?? null,
                lastReconciliationCompletedAt: checkpoint?.lastReconciliationCompletedAt ?? null,
            }
        },
    }
}

/**
 * Stands in for the registered Telegram reader, and reads the real table with
 * the same two-column projection the owner's public read returns.
 *
 * fleet_operations must not import telegram_channel — the manifest graph runs
 * the other way — so this is the test's own query rather than the owner's code.
 * That the owner's read really returns these two columns and nothing else is
 * proven where it belongs, in
 * modules/telegram-channel/public/v1/driver-telegram-park-link.postgres.test.ts.
 */
const readTelegramLinks: CompensationPilotTelegramLinkReaderV1 = async (driverIds) => {
    const rows = await database.$queryRawUnsafe<Array<{ driverId: string; activeParkId: string | null }>>(
        `SELECT "driverId","activeParkId" FROM "DriverTelegram" WHERE "driverId" = ANY($1::text[])`,
        [...driverIds],
    )
    return rows.map((row) => ({ driverId: row.driverId, activeParkId: row.activeParkId }))
}

const runReadiness = (options: { mode?: string; parkEnabled?: boolean } = {}) =>
    compensationPilotReadinessReportV1(
        legacyPrismaCompensationPilotPortV1,
        legacyPrismaCompensationPilotReadinessPortV1,
        ingestionPort(options),
        readTelegramLinks,
        new Date(),
    )

proof('pilot readiness on real PostgreSQL', () => {
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
    })

    it('A. is ready on both gates for one real driver', async () => {
        await seedConfirmedDriver({ driverId: DRIVER_ID, contactId: CONTACT_ID, externalParkId: PARK, externalDriverProfileId: PROFILE })
        await seedTelegramLink(DRIVER_ID, TELEGRAM_ID, PARK)
        await seedReadyCheckpoint()
        await seedCashOrder({ externalOrderId: 'ready-order-1' })
        await openPeriod()

        const report = await runReadiness()
        expect(report.pilotCandidateReady).toBe(true)
        expect(report.pilotInputReady).toBe(true)
        expect(report.parks[0]).toMatchObject({ externalParkId: PARK, catalogueStatus: 'ready' })
        expect(report.candidates[0]).toMatchObject({
            driverId: DRIVER_ID,
            firstMonthKey: PERIOD_KEY,
            pilotCandidateReady: true,
            pilotInputReady: true,
        })
        expect(report.candidates[0].counts).toMatchObject({
            catalogueOrderCount: 1, freshOrderCount: 1, freshUnclaimedOrderCount: 1, claimableOrderCount: 1,
        })
    })

    it('B. never counts an order from another park or another driver profile', async () => {
        await seedConfirmedDriver({ driverId: DRIVER_ID, contactId: CONTACT_ID, externalParkId: PARK, externalDriverProfileId: PROFILE })
        await seedTelegramLink(DRIVER_ID, TELEGRAM_ID, PARK)
        await seedReadyCheckpoint()
        await openPeriod()
        // Same profile, wrong park; and same park, wrong profile.
        await seedCashOrder({ externalOrderId: 'other-park-order', externalParkId: OTHER_PARK })
        await seedCashOrder({ externalOrderId: 'other-profile-order', externalDriverProfileId: OTHER_PROFILE })

        const report = await runReadiness()
        expect(report.pilotCandidateReady).toBe(true)
        expect(report.pilotInputReady).toBe(false)
        expect(report.reasons).toEqual([{ gate: 'input', code: 'no_cash_orders', count: 1 }])
        expect(report.candidates[0].counts?.catalogueOrderCount).toBe(0)
    })

    it('C. never combines one driver eligibility with another driver order', async () => {
        await seedConfirmedDriver({ driverId: DRIVER_ID, contactId: CONTACT_ID, externalParkId: PARK, externalDriverProfileId: PROFILE })
        await seedTelegramLink(DRIVER_ID, TELEGRAM_ID, PARK)
        // A second real driver in the same park, with the order and no link.
        await seedConfirmedDriver({ driverId: OTHER_DRIVER_ID, contactId: OTHER_CONTACT_ID, externalParkId: PARK, externalDriverProfileId: OTHER_PROFILE })
        await seedReadyCheckpoint()
        await openPeriod()
        await seedCashOrder({ externalOrderId: 'belongs-to-other', externalDriverProfileId: OTHER_PROFILE })

        const report = await runReadiness()
        expect(report.counts).toMatchObject({ pilotParkDrivers: 2, candidateReady: 1, inputReady: 0 })
        expect(report.pilotInputReady).toBe(false)
    })

    it('D. excludes an order a real C1 claim already holds', async () => {
        await seedConfirmedDriver({ driverId: DRIVER_ID, contactId: CONTACT_ID, externalParkId: PARK, externalDriverProfileId: PROFILE })
        await seedTelegramLink(DRIVER_ID, TELEGRAM_ID, PARK)
        await seedReadyCheckpoint()
        await openPeriod()
        await seedCashOrder({ externalOrderId: 'claimed-order-1' })
        await seedCashOrder({ externalOrderId: 'spare-order-1' })

        expect((await runReadiness()).candidates[0].counts?.freshUnclaimedOrderCount).toBe(2)

        // Claim one of them through C1, exactly as the bot would.
        const orders = await legacyPrismaCompensationPilotPortV1.findCashOrders({
            externalParkId: PARK, externalDriverProfileId: PROFILE,
        })
        const claimed = orders.find((order) => order.externalOrderId === 'claimed-order-1')!
        const submitted = await legacyPrismaCompensationPilotPortV1.submitApplication({
            canonicalContactId: CONTACT_ID,
            lineage: [CONTACT_ID],
            order: claimed,
            claimedRubles: 100,
            telegramUserId: String(TELEGRAM_ID),
            attachmentFileId: 'tg-file-ready-1',
            attachmentKind: 'photo',
            idempotencyKey: randomUUID(),
            submittedAt: new Date(),
        })
        expect(submitted).not.toHaveProperty('refusal')

        const after = await runReadiness()
        expect(after.pilotInputReady).toBe(true)
        expect(after.candidates[0].counts?.freshUnclaimedOrderCount).toBe(1)

        // With the spare gone, the same claim makes the driver not ready.
        await database.$executeRawUnsafe(
            `DELETE FROM "CompensationCashOrder" WHERE "externalOrderId" = 'spare-order-1'`)
        const exhausted = await runReadiness()
        expect(exhausted.pilotInputReady).toBe(false)
        expect(exhausted.reasons).toEqual([{ gate: 'input', code: 'all_fresh_orders_claimed', count: 1 }])
    })

    it('E. reads the budget row as written, and distinguishes missing from insufficient', async () => {
        await seedConfirmedDriver({ driverId: DRIVER_ID, contactId: CONTACT_ID, externalParkId: PARK, externalDriverProfileId: PROFILE })
        await seedTelegramLink(DRIVER_ID, TELEGRAM_ID, PARK)
        await seedReadyCheckpoint()
        await seedCashOrder({ externalOrderId: 'budget-order-1' })

        const missing = await runReadiness()
        expect(missing.reasons).toEqual([{ gate: 'input', code: 'budget_period_missing', count: 1 }])
        expect(missing.candidates[0].counts?.remainingBudgetKopecks).toBe(0)

        // 99 kopecks of headroom cannot cover the smallest valid claim of one ruble.
        await openPeriod(100_000, 99_901)
        const insufficient = await runReadiness()
        expect(insufficient.reasons).toEqual([
            { gate: 'input', code: 'budget_exhausted_or_insufficient', count: 1 },
        ])
        expect(insufficient.candidates[0].counts?.remainingBudgetKopecks).toBe(99)
    })

    it('F. reads catalogue status from the real checkpoint row', async () => {
        await seedConfirmedDriver({ driverId: DRIVER_ID, contactId: CONTACT_ID, externalParkId: PARK, externalDriverProfileId: PROFILE })
        await seedTelegramLink(DRIVER_ID, TELEGRAM_ID, PARK)
        await openPeriod()
        await seedCashOrder({ externalOrderId: 'status-order-1' })

        // No checkpoint at all: no hot pass, so the catalogue is stale.
        expect((await runReadiness()).reasons).toEqual([{ gate: 'input', code: 'catalogue_stale', count: 1 }])

        // A recent hot pass with no month coverage yet is partial.
        await database.$executeRawUnsafe(
            `INSERT INTO "CompensationCashOrderIngestionCheckpoint"
               ("id","provider","externalParkId","lastHotSuccessAt","createdAt","updatedAt")
             VALUES ($1,$2,$3,NOW(),NOW(),NOW())`,
            `checkpoint-${PARK}`, CASH_ORDER_PROVIDER_V1, PARK,
        )
        expect((await runReadiness()).reasons).toEqual([{ gate: 'input', code: 'catalogue_partial', count: 1 }])

        await database.$executeRawUnsafe(
            `UPDATE "CompensationCashOrderIngestionCheckpoint"
             SET "lastReconciliationCompletedAt" = NOW() WHERE "externalParkId" = $1`, PARK)
        expect((await runReadiness()).pilotInputReady).toBe(true)

        // Mode off is a different answer from an empty or stale catalogue.
        expect((await runReadiness({ mode: 'off' })).reasons)
            .toEqual([{ gate: 'input', code: 'catalogue_disabled', count: 1 }])
        expect((await runReadiness({ parkEnabled: false })).reasons)
            .toEqual([{ gate: 'input', code: 'catalogue_disabled', count: 1 }])

        // And the status the operator is shown is the real rule over the real row.
        const facts = await ingestionPort().readCatalogueFacts(PARK)
        expect(pilotCatalogueStatusV1(facts)).toBe('ready')
    })

    it('G. fails closed when Driver.contactId names a contact Contacts will not confirm', async () => {
        await seedDriverRow({ driverId: DRIVER_ID, externalParkId: PARK, externalDriverProfileId: PROFILE })
        // A real contact, but one that is not this driver's person.
        await seedContact(OTHER_CONTACT_ID, { mainDriverId: null, confirmedFor: null })
        await linkDriverContact(DRIVER_ID, OTHER_CONTACT_ID)
        await seedTelegramLink(DRIVER_ID, TELEGRAM_ID, PARK)
        await seedReadyCheckpoint()
        await seedCashOrder({ externalOrderId: 'unconfirmed-order-1' })
        await openPeriod()

        const report = await runReadiness()
        expect(report.pilotCandidateReady).toBe(false)
        expect(report.reasons).toEqual([{ gate: 'candidate', code: 'contact_not_confirmed', count: 1 }])
    })

    it('H. mutates nothing, and does not create the cron health table', async () => {
        await seedConfirmedDriver({ driverId: DRIVER_ID, contactId: CONTACT_ID, externalParkId: PARK, externalDriverProfileId: PROFILE })
        await seedTelegramLink(DRIVER_ID, TELEGRAM_ID, PARK)
        await seedReadyCheckpoint()
        await seedCashOrder({ externalOrderId: 'immutable-order-1' })
        await openPeriod()

        const cronBefore = await cronHealthExistsHere()
        const before = await snapshotAll()
        const first = await runReadiness()
        const after = await snapshotAll()

        expect(first.pilotInputReady).toBe(true)
        expect(after).toBe(before)
        expect(await cronHealthExistsHere()).toBe(cronBefore)
    })

    it('I. is idempotent: a repeated run changes nothing and answers the same', async () => {
        await seedConfirmedDriver({ driverId: DRIVER_ID, contactId: CONTACT_ID, externalParkId: PARK, externalDriverProfileId: PROFILE })
        await seedTelegramLink(DRIVER_ID, TELEGRAM_ID, PARK)
        await seedReadyCheckpoint()
        await seedCashOrder({ externalOrderId: 'repeat-order-1' })
        await openPeriod()

        const before = await snapshotAll()
        const first = await runReadiness()
        const second = await runReadiness()
        expect(await snapshotAll()).toBe(before)
        expect(second.pilotCandidateReady).toBe(first.pilotCandidateReady)
        expect(second.pilotInputReady).toBe(first.pilotInputReady)
        expect(second.counts).toEqual(first.counts)
        expect(second.reasons).toEqual(first.reasons)
    })

    it('J. refuses a link with no park, and a link on another park', async () => {
        await seedConfirmedDriver({ driverId: DRIVER_ID, contactId: CONTACT_ID, externalParkId: PARK, externalDriverProfileId: PROFILE })
        await seedReadyCheckpoint()
        await openPeriod()

        // No link row at all.
        expect((await runReadiness()).reasons).toEqual([
            { gate: 'candidate', code: 'telegram_link_missing', count: 1 },
        ])

        await seedTelegramLink(DRIVER_ID, TELEGRAM_ID, null)
        expect((await runReadiness()).reasons).toEqual([
            { gate: 'candidate', code: 'telegram_park_missing', count: 1 },
        ])

        await database.$executeRawUnsafe(
            `UPDATE "DriverTelegram" SET "activeParkId" = $1 WHERE "driverId" = $2`, OTHER_PARK, DRIVER_ID)
        expect((await runReadiness()).reasons).toEqual([
            { gate: 'candidate', code: 'telegram_park_mismatch', count: 1 },
        ])
    })
})
