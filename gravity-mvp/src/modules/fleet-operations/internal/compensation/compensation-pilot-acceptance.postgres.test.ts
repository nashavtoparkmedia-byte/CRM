/**
 * End-to-end pilot acceptance on real PostgreSQL.
 *
 * One driver walks the whole journey: a Telegram account proven to a canonical
 * person, eligible as park-SMZ in their first calendar month, claiming against
 * a real ingested cash order, then a manager approving, paying by hand and the
 * driver seeing the final status.
 *
 * Gated behind YOKO_COMPENSATION_MONETARY_POSTGRES_PROOF=1 and an isolated
 * DATABASE_URL. Payout stays manual throughout: nothing here moves money, it
 * records that a human did.
 */

import { createHash, randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
    FINALIZE_COMPENSATION_PAYOUT_COMMAND_V1,
    REJECT_COMPENSATION_APPLICATION_COMMAND_V1,
    START_COMPENSATION_PAYOUT_COMMAND_V1,
    SUBMIT_COMPENSATION_APPLICATION_COMMAND_V1,
} from '../../../../contracts/fleet-operations/v1'
import {
    compensationCalendarMonthV1,
    compensationMonthEndInstantV1,
    compensationMonthStartInstantV1,
} from './compensation-calendar'
import {
    cashOrderCatalogueV1,
    ingestCashOrderPageV1,
    type CashOrderIngestionPortV1,
    type StoredCashOrderV1,
} from './compensation-cash-order-ingestion'
import type { CashOrderRequestContextV1 } from './compensation-cash-order-projection'
import {
    decidePilotSubmissionV1,
    pilotDriverStatusV1,
    remainingBudgetKopecksV1,
    routeManagerActionV1,
} from './compensation-pilot-flow'
import {
    finalizeCompensationPayoutV1,
    rejectCompensationApplicationV1,
    startCompensationPayoutV1,
    submitCompensationApplicationV1,
} from './compensation-prisma-adapter'
import { compensationPeriodSubmissionClosesAtV1 } from './compensation-submission-window'
import {
    compensationSectionViewV1,
    resolvePilotIdentityV1,
    submitPilotApplicationV1,
    type PilotTelegramPersonProofV1,
} from './compensation-pilot-service'
import { legacyPrismaCompensationPilotPortV1 } from './legacy-prisma-compensation-pilot-adapter'
import {
    CONTACT_OWNERSHIP_ADVISORY_CLASS_ID_V1,
    CONTACT_OWNERSHIP_ADVISORY_OBJECT_ID_V1,
} from '@/modules/contacts/public/v1/contact-ownership-lock-contract'

const proof = process.env.YOKO_COMPENSATION_MONETARY_POSTGRES_PROOF === '1' ? describe : describe.skip

const PARK = 'park-yoko-1'
const PROFILE = 'b'.repeat(32)
const CONTACT = 'contact-driver-1'
const TELEGRAM_USER = '777001'

// C1 refuses a payout whose caller clock disagrees with the database clock,
// which is exactly the protection that stops a stale or forged timestamp from
// choosing a business day. The fixture therefore runs in real time and builds
// the month around it, rather than pinning a date the database will reject.
const NOW = new Date()
const CURRENT_MONTH = compensationCalendarMonthV1(NOW)
const MONTH_START = compensationMonthStartInstantV1(CURRENT_MONTH)
// An hour ago, but never before the month began: the order has to belong to
// the month whose budget period it will charge.
const ORDER_ENDED_AT = new Date(Math.max(MONTH_START.getTime() + 3_600_000, NOW.getTime() - 3_600_000))
const PERIOD_KEY = `${CURRENT_MONTH.year}-${String(CURRENT_MONTH.month).padStart(2, '0')}`

const MANAGER = {
    principalId: 'manager-1',
    principalKind: 'crm_user' as const,
    operatorLabel: 'Pilot manager',
}

let database: PrismaClient

const CONTEXT: CashOrderRequestContextV1 = {
    provider: 'yandex_fleet',
    externalParkId: PARK,
    apiConnectionId: 'conn-1',
    observedAt: new Date(NOW.getTime() - 7_200_000),
}

const ELIGIBLE_FACTS = {
    isSelfEmployed: true,
    employmentType: 'selfemployed',
    parkHireDate: MONTH_START,
}

function ingestionPort(): CashOrderIngestionPortV1 {
    return {
        async upsertCashOrder(row) {
            await database.$executeRawUnsafe(
                `INSERT INTO "CompensationCashOrder"
                   ("id","provider","externalParkId","externalOrderId","shortOrderIdDisplay",
                    "externalDriverProfileId","rawPrice","amountKopecks","endedAt","observedAt",
                    "createdAt","updatedAt")
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),NOW())
                 ON CONFLICT ("provider","externalParkId","externalOrderId") DO NOTHING`,
                row.id, row.provider, row.externalParkId, row.externalOrderId,
                row.shortOrderIdDisplay, row.externalDriverProfileId, row.rawPrice,
                row.amountKopecks, row.endedAt, row.observedAt,
            )
        },
    }
}

function fleetOrder(overrides: Record<string, unknown> = {}) {
    return {
        id: 'a'.repeat(32),
        short_id: 3982091,
        status: 'complete',
        payment_method: 'cash',
        price: '335.0000',
        ended_at: ORDER_ENDED_AT.toISOString(),
        driver_profile: { id: PROFILE },
        ...overrides,
    }
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

async function storedOrders(): Promise<StoredCashOrderV1[]> {
    const rows = await database.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT "id","provider","externalParkId","externalOrderId","shortOrderIdDisplay",
                "externalDriverProfileId","rawPrice","amountKopecks","endedAt"
         FROM "CompensationCashOrder" WHERE "externalDriverProfileId" = $1`,
        PROFILE,
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

async function periodRow(key: string) {
    const rows = await database.$queryRawUnsafe<Array<{
        limitKopecks: number; reservedKopecks: number; settledKopecks: number
    }>>(
        `SELECT "limitKopecks","reservedKopecks","settledKopecks"
         FROM "CompensationBudgetPeriod" WHERE "periodKey" = $1`, key,
    )
    return rows[0]
}

/** What the manager list shows for one application, joined as the CRM would. */
async function managerRow(applicationId: string) {
    const rows = await database.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT app."id", app."status", app."amountKopecks", app."claimedKopecks",
                vo."externalParkId", vo."externalOrderId", vo."rawPrice", vo."amountKopecks" AS "verifiedKopecks",
                pb."contactId", ps."telegramUserId", ps."attachmentFileId", ps."supportContactedAt",
                (SELECT count(*) FROM "CompensationPayoutAuthorization" pa
                  WHERE pa."applicationId" = app."id"
                    AND pa."state" IN ('active','unknown_outcome')) AS "liveAuthorizations",
                -- A reconciliation task hangs off the authorization, not the
                -- application, so it is reached through the authorization.
                (SELECT count(*) FROM "CompensationReconciliationTask" rt
                  JOIN "CompensationPayoutAuthorization" pa2 ON pa2."id" = rt."payoutAuthorizationId"
                  WHERE pa2."applicationId" = app."id" AND rt."state" = 'open') AS "openReconciliations"
         FROM "CompensationApplication" app
         JOIN "CompensationVerifiedOrder" vo ON vo."id" = app."verifiedOrderId"
         JOIN "CompensationPersonBinding" pb ON pb."compensationPersonId" = app."compensationPersonId"
         LEFT JOIN "CompensationPilotSubmission" ps ON ps."applicationId" = app."id"
         WHERE app."id" = $1`,
        applicationId,
    )
    const row = rows[0]
    return {
        status: String(row.status),
        contactId: String(row.contactId),
        externalParkId: String(row.externalParkId),
        externalOrderId: String(row.externalOrderId),
        rawPrice: String(row.rawPrice),
        telegramUserId: row.telegramUserId === null ? null : String(row.telegramUserId),
        attachmentFileId: row.attachmentFileId === null ? null : String(row.attachmentFileId),
        claimedKopecks: Number(row.claimedKopecks),
        verifiedKopecks: Number(row.verifiedKopecks),
        amountKopecks: Number(row.amountKopecks),
        liveAuthorizations: Number(row.liveAuthorizations),
        openReconciliations: Number(row.openReconciliations),
    }
}

async function recordPilotSubmission(input: {
    applicationId: string
    attachmentFileId: string
    attachmentKind: string
    claimedRubles: number
}): Promise<void> {
    await database.$executeRawUnsafe(
        `INSERT INTO "CompensationPilotSubmission"
           ("id","applicationId","telegramUserId","supportContactedAt","attachmentFileId",
            "attachmentKind","claimedRubles","createdAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
         ON CONFLICT ("applicationId") DO NOTHING`,
        randomUUID(), input.applicationId, TELEGRAM_USER, NOW,
        input.attachmentFileId, input.attachmentKind, input.claimedRubles,
    )
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
        "CompensationPilotSubmission","CompensationAuditEvent","CompensationReconciliationTask",
        "CompensationSettlement","CompensationPayoutAuthorization","CompensationApplication",
        "CompensationOrderClaim","CompensationVerifiedOrder","CompensationPersonBinding",
        "CompensationPerson","CompensationBudgetPeriod","CompensationCashOrder"
        RESTART IDENTITY CASCADE`)
}

/** The driver's own view of one application, as the bot would render it. */
async function driverStatus(applicationId: string) {
    const row = await managerRow(applicationId)
    return pilotDriverStatusV1({
        status: row.status,
        hasLiveAuthorization: row.liveAuthorizations > 0,
    })
}

proof('telegram pilot acceptance on real PostgreSQL', () => {
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
        await openPeriod(CURRENT_MONTH)
        await ingestCashOrderPageV1([fleetOrder()], CONTEXT, ingestionPort())
    })

    it('carries one driver from telegram share to paid, with a manual payout', async () => {
        // The driver opens the compensation section. Eligibility gates the list.
        const catalogue = cashOrderCatalogueV1(ELIGIBLE_FACTS, await storedOrders(), NOW)
        expect(catalogue.eligible).toBe(true)
        if (!catalogue.eligible) return
        expect(catalogue.orders).toHaveLength(1)

        // Remaining monthly budget, shown alongside the list.
        const period = await periodRow(PERIOD_KEY)
        expect(remainingBudgetKopecksV1(period)).toBe(500_000)

        // The driver picks the order, confirms support, attaches the reply.
        const gate = decidePilotSubmissionV1({
            externalOrderId: catalogue.orders[0].externalOrderId,
            claimedRubles: 300,
            supportConfirmed: true,
            attachmentFileId: 'tg-file-support-1',
            attachmentKind: 'photo',
        }, {
            catalogue: catalogue.orders,
            alreadyClaimedOrderIds: [],
            remainingBudgetKopecks: remainingBudgetKopecksV1(period),
        })
        expect(gate.accepted).toBe(true)
        if (!gate.accepted) return

        // Submit goes through C1 unchanged.
        const submitted = await submitCompensationApplicationV1({
            contract: SUBMIT_COMPENSATION_APPLICATION_COMMAND_V1,
            idempotencyKey: randomUUID(),
            person: provenPerson(CONTACT),
            order: {
                provider: gate.order.provider,
                externalParkId: gate.order.externalParkId,
                externalOrderId: gate.order.externalOrderId,
                shortOrderIdDisplay: gate.order.shortOrderIdDisplay,
                rawPrice: gate.order.rawPrice,
                endedAt: gate.order.endedAt,
                verifiedAt: CONTEXT.observedAt,
            },
            claimedRubles: gate.claimedRubles,
            submittedAt: NOW,
        })
        await recordPilotSubmission({
            applicationId: submitted.applicationId,
            attachmentFileId: gate.attachmentFileId,
            attachmentKind: gate.attachmentKind,
            claimedRubles: gate.claimedRubles,
        })
        expect(submitted.amountKopecks).toBe(30_000)
        expect(await driverStatus(submitted.applicationId)).toBe('submitted')

        // The manager sees person, park, order, both amounts and the attachment.
        const listed = await managerRow(submitted.applicationId)
        expect(listed).toMatchObject({
            status: 'PENDING',
            contactId: CONTACT,
            externalParkId: PARK,
            externalOrderId: 'a'.repeat(32),
            rawPrice: '335.0000',
            telegramUserId: TELEGRAM_USER,
            attachmentFileId: 'tg-file-support-1',
        })
        expect(listed.claimedKopecks).toBe(30_000)
        expect(listed.verifiedKopecks).toBe(33_500)

        // Approve routes to the C1 payout start.
        const approveRoute = routeManagerActionV1('approve', {
            status: listed.status,
            hasLiveAuthorization: listed.liveAuthorizations > 0,
            hasOpenReconciliation: listed.openReconciliations > 0,
        })
        expect(approveRoute).toEqual({ operation: 'start_payout' })

        const authorization = await startCompensationPayoutV1({
            contract: START_COMPENSATION_PAYOUT_COMMAND_V1,
            applicationId: submitted.applicationId,
            principal: MANAGER,
            startedAt: new Date(),
        })
        expect(authorization.status).toBe('opened')
        expect(authorization.amountKopecks).toBe(30_000)
        expect(await driverStatus(submitted.applicationId)).toBe('awaiting_payment')

        // The manager pays by hand, then records it. Nothing here moves money.
        const afterApproval = await managerRow(submitted.applicationId)
        const payRoute = routeManagerActionV1('mark_paid', {
            status: afterApproval.status,
            hasLiveAuthorization: afterApproval.liveAuthorizations > 0,
            hasOpenReconciliation: afterApproval.openReconciliations > 0,
        })
        expect(payRoute).toEqual({ operation: 'finalize_payout' })

        const settled = await finalizeCompensationPayoutV1({
            contract: FINALIZE_COMPENSATION_PAYOUT_COMMAND_V1,
            payoutAuthorizationId: authorization.payoutAuthorizationId,
            authorizationFence: authorization.authorizationFence,
            principal: MANAGER,
            finalizedAt: new Date(),
        })
        expect(settled.status).toBe('settled')
        expect(settled.amountKopecks).toBe(30_000)

        // The driver sees the final status, and the budget moved reserved to settled.
        expect(await driverStatus(submitted.applicationId)).toBe('paid')
        const closingPeriod = await periodRow(PERIOD_KEY)
        expect(closingPeriod.settledKopecks).toBe(30_000)
        expect(closingPeriod.reservedKopecks).toBe(0)
        expect(remainingBudgetKopecksV1(closingPeriod)).toBe(470_000)
    })

    it('rejects through C1 and the driver sees it', async () => {
        const orders = await storedOrders()
        const submitted = await submitCompensationApplicationV1({
            contract: SUBMIT_COMPENSATION_APPLICATION_COMMAND_V1,
            idempotencyKey: randomUUID(),
            person: provenPerson(CONTACT),
            order: {
                provider: orders[0].provider,
                externalParkId: orders[0].externalParkId,
                externalOrderId: orders[0].externalOrderId,
                shortOrderIdDisplay: orders[0].shortOrderIdDisplay,
                rawPrice: orders[0].rawPrice,
                endedAt: orders[0].endedAt,
                verifiedAt: CONTEXT.observedAt,
            },
            claimedRubles: 300,
            submittedAt: NOW,
        })
        await recordPilotSubmission({
            applicationId: submitted.applicationId,
            attachmentFileId: 'tg-file-support-2',
            attachmentKind: 'document',
            claimedRubles: 300,
        })

        await rejectCompensationApplicationV1({
            contract: REJECT_COMPENSATION_APPLICATION_COMMAND_V1,
            applicationId: submitted.applicationId,
            rejectionKey: randomUUID(),
            reason: 'support response does not show a cash payment',
            principal: MANAGER,
            rejectedAt: new Date(),
        })

        expect(await driverStatus(submitted.applicationId)).toBe('rejected')
        // A rejection releases the reservation rather than spending it.
        expect((await periodRow(PERIOD_KEY)).reservedKopecks).toBe(0)
    })

    it('refuses to reject an application whose payout is already in flight', async () => {
        const orders = await storedOrders()
        const submitted = await submitCompensationApplicationV1({
            contract: SUBMIT_COMPENSATION_APPLICATION_COMMAND_V1,
            idempotencyKey: randomUUID(),
            person: provenPerson(CONTACT),
            order: {
                provider: orders[0].provider,
                externalParkId: orders[0].externalParkId,
                externalOrderId: orders[0].externalOrderId,
                shortOrderIdDisplay: orders[0].shortOrderIdDisplay,
                rawPrice: orders[0].rawPrice,
                endedAt: orders[0].endedAt,
                verifiedAt: CONTEXT.observedAt,
            },
            claimedRubles: 300,
            submittedAt: NOW,
        })
        await startCompensationPayoutV1({
            contract: START_COMPENSATION_PAYOUT_COMMAND_V1,
            applicationId: submitted.applicationId,
            principal: MANAGER,
            startedAt: new Date(),
        })

        const row = await managerRow(submitted.applicationId)
        const route = routeManagerActionV1('reject', {
            status: row.status,
            hasLiveAuthorization: row.liveAuthorizations > 0,
            hasOpenReconciliation: row.openReconciliations > 0,
        })
        expect(route).toEqual({ refusal: 'reject_requires_no_live_authorization' })
    })

    it('keeps the pilot evidence to one row when a submit is replayed', async () => {
        const orders = await storedOrders()
        const key = randomUUID()
        const command = {
            contract: SUBMIT_COMPENSATION_APPLICATION_COMMAND_V1,
            idempotencyKey: key,
            person: provenPerson(CONTACT),
            order: {
                provider: orders[0].provider,
                externalParkId: orders[0].externalParkId,
                externalOrderId: orders[0].externalOrderId,
                shortOrderIdDisplay: orders[0].shortOrderIdDisplay,
                rawPrice: orders[0].rawPrice,
                endedAt: orders[0].endedAt,
                verifiedAt: CONTEXT.observedAt,
            },
            claimedRubles: 300,
            submittedAt: NOW,
        } as const

        const first = await submitCompensationApplicationV1(command)
        await recordPilotSubmission({
            applicationId: first.applicationId,
            attachmentFileId: 'tg-file-support-3',
            attachmentKind: 'photo',
            claimedRubles: 300,
        })
        const replay = await submitCompensationApplicationV1(command)
        await recordPilotSubmission({
            applicationId: replay.applicationId,
            attachmentFileId: 'tg-file-support-3',
            attachmentKind: 'photo',
            claimedRubles: 300,
        })

        expect(replay.status).toBe('replayed')
        expect(replay.applicationId).toBe(first.applicationId)
        const count = await database.$queryRawUnsafe<Array<{ count: bigint }>>(
            'SELECT count(*) AS count FROM "CompensationPilotSubmission"')
        expect(Number(count[0].count)).toBe(1)
        // One reservation, not two.
        expect((await periodRow(PERIOD_KEY)).reservedKopecks).toBe(30_000)
    })

    it('refuses a claim above the pilot cap before it reaches the monetary core', async () => {
        const catalogue = cashOrderCatalogueV1(ELIGIBLE_FACTS, await storedOrders(), NOW)
        expect(catalogue.eligible).toBe(true)
        if (!catalogue.eligible) return

        const gate = decidePilotSubmissionV1({
            externalOrderId: catalogue.orders[0].externalOrderId,
            claimedRubles: 1001,
            supportConfirmed: true,
            attachmentFileId: 'tg-file-support-4',
            attachmentKind: 'photo',
        }, {
            catalogue: catalogue.orders,
            alreadyClaimedOrderIds: [],
            remainingBudgetKopecks: 500_000,
        })
        expect(gate).toEqual({ accepted: false, refusal: 'claim_above_pilot_cap' })

        const applications = await database.$queryRawUnsafe<Array<{ count: bigint }>>(
            'SELECT count(*) AS count FROM "CompensationApplication"')
        expect(Number(applications[0].count)).toBe(0)
    })
})

/**
 * The same journey through the real pilot port: the person is proven through
 * Contacts' public reads from the proof Telegram channel authority produced,
 * and the lists and C1 submit run the adapter's own SQL.
 */
proof('telegram pilot port proves the person through Contacts on real PostgreSQL', () => {
    const DRIVER_ID = 'pilot-port-driver-1'
    const CONTACT_ID = 'pilot-port-contact-1'
    const OTHER_CONTACT_ID = 'pilot-port-contact-2'
    const PROOF: PilotTelegramPersonProofV1 = {
        telegramUserId: TELEGRAM_USER,
        driverId: DRIVER_ID,
        contactId: CONTACT_ID,
    }
    const port = legacyPrismaCompensationPilotPortV1
    const submitInput = (idempotencyKey: string, externalOrderId: string) => ({
        ...PROOF,
        externalOrderId,
        claimedRubles: 300,
        supportConfirmed: true,
        attachmentFileId: 'tg-file-port-1',
        attachmentKind: 'photo',
        idempotencyKey,
    })

    async function clearIdentityFixtures(): Promise<void> {
        await database.$executeRawUnsafe(`DELETE FROM "ContactMerge" WHERE "survivorId" LIKE 'pilot-port-%'`)
        await database.$executeRawUnsafe(`DELETE FROM "Contact" WHERE "id" LIKE 'pilot-port-%'`)
        await database.$executeRawUnsafe(`DELETE FROM "Driver" WHERE "id" LIKE 'pilot-port-%'`)
    }

    // Fixtures are written with static SQL, the same way as the rest of this
    // file, so every row they touch is visible from the statement text alone.
    async function seedPerson(confirmedDriverId = DRIVER_ID): Promise<void> {
        await database.$executeRawUnsafe(
            `INSERT INTO "Contact" ("id","displayName","updatedAt") VALUES ($1,'Unrelated contact',NOW())`,
            OTHER_CONTACT_ID,
        )
        // Driver.contactId is only a Fleet projection. Pointing it elsewhere
        // proves the port never takes the person from it.
        await database.$executeRawUnsafe(
            `INSERT INTO "Driver"
               ("id","yandexDriverId","fullName","externalParkId","externalDriverProfileId",
                "isSelfEmployed","employmentType","yandexHireDate","contactId","updatedAt")
             VALUES ($1,'park-profile:pilot-port-1','Pilot Port Driver',$2,$3,true,'selfemployed',$4,$5,NOW())`,
            DRIVER_ID, PARK, PROFILE, MONTH_START, OTHER_CONTACT_ID,
        )
        await database.$executeRawUnsafe(
            `INSERT INTO "Contact" ("id","displayName","mainDriverId","customFields","updatedAt")
             VALUES ($1,'Pilot Port Person',$2,$3::jsonb,NOW())`,
            CONTACT_ID, DRIVER_ID,
            JSON.stringify({ driverConfirmations: [{ status: 'confirmed', representativeDriverId: confirmedDriverId }] }),
        )
    }

    async function count(table: string): Promise<number> {
        const rows = await database.$queryRawUnsafe<Array<{ count: bigint }>>(
            `SELECT count(*) AS count FROM "${table}"`)
        return Number(rows[0].count)
    }

    beforeAll(async () => {
        database = new PrismaClient()
        await database.$connect()
    })
    afterAll(async () => {
        await truncateAll()
        await clearIdentityFixtures()
        await database.$disconnect()
    })
    beforeEach(async () => {
        await truncateAll()
        await clearIdentityFixtures()
        await openPeriod(CURRENT_MONTH)
        await ingestCashOrderPageV1([fleetOrder()], CONTEXT, ingestionPort())
    })

    it('shows the confirmed person their orders and submits through C1 with the Contacts lineage', async () => {
        await seedPerson()

        const section = await compensationSectionViewV1(PROOF, port, NOW)
        expect(section).toMatchObject({ available: true, firstMonthKey: PERIOD_KEY, remainingBudgetKopecks: 500_000 })
        if (!section.available) return
        expect(section.orders).toHaveLength(1)
        const externalOrderId = section.orders[0].externalOrderId

        const idempotencyKey = randomUUID()
        const created = await submitPilotApplicationV1(submitInput(idempotencyKey, externalOrderId), port, NOW)
        expect(created).toMatchObject({ submitted: true, amountKopecks: 30_000, status: 'created' })
        // A repeated tap is stopped by the claimed-order check before C1, so it
        // can neither create a second application nor a second evidence row.
        const repeated = await submitPilotApplicationV1(submitInput(idempotencyKey, externalOrderId), port, NOW)
        expect(repeated).toEqual({ submitted: false, refusal: 'order_already_claimed' })
        expect(await count('CompensationApplication')).toBe(1)

        const bindings = await database.$queryRawUnsafe<Array<{ contactId: string; lineageDigest: string }>>(
            `SELECT "contactId","lineageDigest" FROM "CompensationPersonBinding"`)
        expect(bindings).toEqual([{
            contactId: CONTACT_ID,
            lineageDigest: createHash('sha256').update(CONTACT_ID).digest('hex'),
        }])
        expect(await count('CompensationPilotSubmission')).toBe(1)

        expect(await port.findClaimedOrderIds([CONTACT_ID])).toEqual([externalOrderId])
        expect(await port.findClaimedOrderIds([OTHER_CONTACT_ID])).toEqual([])

        const after = await compensationSectionViewV1(PROOF, port, NOW)
        expect(after.applications).toHaveLength(1)
        expect(after.applications[0]).toMatchObject({ status: 'submitted', externalOrderId })

        const managerRows = await port.findManagerApplications()
        expect(managerRows).toHaveLength(1)
        expect(managerRows[0]).toMatchObject({
            boundContactIds: [CONTACT_ID],
            externalParkId: PARK,
            telegramUserId: TELEGRAM_USER,
            attachmentFileId: 'tg-file-port-1',
            claimedKopecks: 30_000,
            verifiedKopecks: 33_500,
        })
    })

    it('answers a second claim while one is pending with the monetary-core refusal, writing nothing', async () => {
        await seedPerson()
        await ingestCashOrderPageV1([fleetOrder({ id: 'c'.repeat(32), short_id: 3982092 })], CONTEXT, ingestionPort())

        const section = await compensationSectionViewV1(PROOF, port, NOW)
        expect(section.available && section.orders).toHaveLength(2)
        if (!section.available) return
        const [first, second] = section.orders

        expect(await submitPilotApplicationV1(submitInput(randomUUID(), first.externalOrderId), port, NOW))
            .toMatchObject({ submitted: true, status: 'created' })
        expect(await submitPilotApplicationV1(submitInput(randomUUID(), second.externalOrderId), port, NOW))
            .toEqual({ submitted: false, refusal: 'active_pending_exists' })
        expect(await count('CompensationApplication')).toBe(1)
        expect(await count('CompensationPilotSubmission')).toBe(1)
    })

    it('refuses a Contact whose operator confirmation names another Driver, binding nothing', async () => {
        await seedPerson('pilot-port-driver-elsewhere')

        expect(await resolvePilotIdentityV1(PROOF, port)).toEqual({ proven: false, refusal: 'identity_not_proven' })
        const outcome = await submitPilotApplicationV1(submitInput(randomUUID(), 'a'.repeat(32)), port, NOW)
        expect(outcome).toEqual({ submitted: false, refusal: 'identity_not_proven' })
        expect(await count('CompensationPerson')).toBe(0)
        expect(await count('CompensationPersonBinding')).toBe(0)
    })

    it('refuses a person whose lineage carries a merged contact instead of binding both', async () => {
        await seedPerson()
        await database.$executeRawUnsafe(
            `INSERT INTO "Contact" ("id","displayName","customFields","updatedAt")
             VALUES ('pilot-port-contact-merged','Merged away',$1::jsonb,NOW())`,
            JSON.stringify({ mergedIntoContactId: CONTACT_ID }),
        )
        await database.$executeRawUnsafe(
            `INSERT INTO "ContactMerge" ("id","survivorId","mergedId","reason","snapshotBefore")
             VALUES ('pilot-port-merge-1',$1,'pilot-port-contact-merged','manual','{}'::jsonb)`,
            CONTACT_ID,
        )

        expect(await resolvePilotIdentityV1(PROOF, port)).toEqual({ proven: false, refusal: 'identity_needs_review' })
        const outcome = await submitPilotApplicationV1(submitInput(randomUUID(), 'a'.repeat(32)), port, NOW)
        expect(outcome).toEqual({ submitted: false, refusal: 'identity_needs_review' })
        expect(await count('CompensationPersonBinding')).toBe(0)
        expect(await count('CompensationApplication')).toBe(0)
    })

    it('refuses a proof naming a contact that was merged away after authority was proven', async () => {
        await seedPerson()
        await database.$executeRawUnsafe(
            `UPDATE "Contact" SET "customFields" = $1::jsonb WHERE "id" = $2`,
            JSON.stringify({
                driverConfirmations: [{ status: 'confirmed', representativeDriverId: DRIVER_ID }],
                mergedIntoContactId: OTHER_CONTACT_ID,
            }),
            CONTACT_ID,
        )

        expect(await resolvePilotIdentityV1(PROOF, port)).toEqual({ proven: false, refusal: 'identity_not_proven' })
    })

    it('answers a held Contacts ownership fence as retryable rather than unlinked', async () => {
        await seedPerson()
        let release!: () => void
        const released = new Promise<void>((resolve) => { release = resolve })
        let locked!: () => void
        let failed!: (error: unknown) => void
        const holding = new Promise<void>((resolve, reject) => { locked = resolve; failed = reject })
        const holder = database.$transaction(async (transaction) => {
            // The lock function returns void, which a raw query cannot decode.
            await transaction.$executeRawUnsafe(
                'SELECT pg_advisory_xact_lock($1::integer, $2::integer)',
                CONTACT_OWNERSHIP_ADVISORY_CLASS_ID_V1,
                CONTACT_OWNERSHIP_ADVISORY_OBJECT_ID_V1,
            )
            locked()
            await released
        }, { timeout: 20_000 })
        holder.catch(failed)

        try {
            await holding
            expect(await resolvePilotIdentityV1(PROOF, port)).toEqual({ proven: false, refusal: 'identity_busy' })
        } finally {
            release()
            await holder
        }
        expect(await resolvePilotIdentityV1(PROOF, port)).toMatchObject({ proven: true })
    }, 30_000)
})
