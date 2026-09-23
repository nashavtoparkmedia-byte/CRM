/**
 * The manager workflow on real PostgreSQL.
 *
 * The projection, the budget dashboard and every monetary action a manager can
 * take, against the monetary core itself. The races are real: two actions are
 * started at once and the database decides, so what is proved here is that the
 * core serialises them and that the manager seam reports whatever the core
 * decided, never a belief of its own.
 *
 * Gated behind YOKO_COMPENSATION_MONETARY_POSTGRES_PROOF=1 and an isolated
 * DATABASE_URL. Nothing here moves money; it records that a human did.
 */

import { createHash, randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { SUBMIT_COMPENSATION_APPLICATION_COMMAND_V1 } from '../../../../contracts/fleet-operations/v1'
import {
    compensationCalendarMonthV1,
    compensationMonthEndInstantV1,
    compensationMonthStartInstantV1,
} from './compensation-calendar'
import {
    listManagerApplicationsV1,
    managerRejectionKeyV1,
    performManagerActionV1,
    readManagerApplicationV1,
    readManagerBudgetV1,
    type ManagerActionResultV1,
    type ManagerPrincipalV1,
} from './compensation-manager-service'
import { submitCompensationApplicationV1 } from './compensation-prisma-adapter'
import { compensationPeriodSubmissionClosesAtV1 } from './compensation-submission-window'
import { legacyPrismaCompensationManagerStoreV1 as store } from './legacy-prisma-compensation-manager-adapter'

const proof = process.env.YOKO_COMPENSATION_MONETARY_POSTGRES_PROOF === '1' ? describe : describe.skip

const PARK = 'park-yoko-1'
const OTHER_PARK = 'park-yoko-2'
const PROFILE = 'b'.repeat(32)

// C1 refuses a payout whose caller clock disagrees with the database clock, so
// the fixture runs in real time and builds the month around it.
const NOW = new Date()
const CURRENT_MONTH = compensationCalendarMonthV1(NOW)
const MONTH_START = compensationMonthStartInstantV1(CURRENT_MONTH)
const ORDER_ENDED_AT = new Date(Math.max(MONTH_START.getTime() + 3_600_000, NOW.getTime() - 3_600_000))
const PERIOD_KEY = `${CURRENT_MONTH.year}-${String(CURRENT_MONTH.month).padStart(2, '0')}`

const MANAGER: ManagerPrincipalV1 = { principalId: 'manager-1', operatorLabel: 'Менеджер Аня' }
const SECOND_MANAGER: ManagerPrincipalV1 = { principalId: 'manager-2', operatorLabel: 'Менеджер Борис' }

let database: PrismaClient
let orderSequence = 0

function provenPerson(contactId: string) {
    return {
        canonicalContactId: contactId,
        resolutionStatus: 'live' as const,
        lineage: [contactId],
        lineageDigest: createHash('sha256').update(contactId).digest('hex'),
        evidenceAt: NOW,
    }
}

async function seedContact(contactId: string, displayName: string, phone: string | null): Promise<void> {
    await database.$executeRawUnsafe(
        `INSERT INTO "Contact" ("id","displayName","updatedAt") VALUES ($1,$2,NOW())
         ON CONFLICT ("id") DO NOTHING`,
        contactId, displayName,
    )
    if (phone === null) return
    await database.$executeRawUnsafe(
        `INSERT INTO "ContactPhone" ("id","contactId","phone","isPrimary","isActive")
         VALUES ($1,$2,$3,true,true) ON CONFLICT ("id") DO NOTHING`,
        `phone_${contactId}`, contactId, phone,
    )
}

/** A park connection, so the list can name the park the order belongs to. */
async function seedConnection(externalParkId: string, name: string): Promise<void> {
    await database.$executeRawUnsafe(
        `INSERT INTO "ApiConnection" ("id","clid","apiKey","parkId","name")
         VALUES ($1,$2,'',$3,$4) ON CONFLICT ("id") DO NOTHING`,
        `conn_${externalParkId}`, externalParkId, externalParkId, name,
    )
}

async function openPeriod(limitKopecks = 500_000): Promise<void> {
    await database.$executeRawUnsafe(
        `INSERT INTO "CompensationBudgetPeriod"
            ("id","periodKey","periodStartsAt","periodEndsAt","submissionClosesAt","limitKopecks",
             "reservedKopecks","settledKopecks","state","openedAt","createdAt","updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,0,0,'open',NOW(),NOW(),NOW())
         ON CONFLICT ("periodKey") DO NOTHING`,
        `period_${PERIOD_KEY}`, PERIOD_KEY,
        MONTH_START, compensationMonthEndInstantV1(CURRENT_MONTH),
        compensationPeriodSubmissionClosesAtV1(CURRENT_MONTH), limitKopecks,
    )
}

interface SeededApplication {
    applicationId: string
    externalOrderId: string
    contactId: string
}

/**
 * One submitted claim, exactly as the Telegram pilot leaves it: an ingested
 * cash order, a C1 application against it, and the support screenshot the
 * driver attached.
 */
async function seedApplication(options: {
    contactId?: string
    displayName?: string
    phone?: string | null
    externalParkId?: string
    claimedRubles?: number
    rawPrice?: string
    attachmentFileId?: string | null
    endedAt?: Date
} = {}): Promise<SeededApplication> {
    orderSequence += 1
    const contactId = options.contactId ?? `contact-${orderSequence}`
    const externalParkId = options.externalParkId ?? PARK
    const externalOrderId = `${String(orderSequence).padStart(2, '0')}${'c'.repeat(30)}`
    const rawPrice = options.rawPrice ?? '335.0000'
    const endedAt = options.endedAt ?? ORDER_ENDED_AT
    const observedAt = new Date(NOW.getTime() - 300_000)

    await seedContact(contactId, options.displayName ?? `Водитель ${orderSequence}`, options.phone ?? '+79990000001')
    await seedConnection(externalParkId, externalParkId === PARK ? 'Парк Йоко' : 'Второй парк')
    await database.$executeRawUnsafe(
        `INSERT INTO "CompensationCashOrder"
           ("id","provider","externalParkId","externalOrderId","shortOrderIdDisplay",
            "externalDriverProfileId","rawPrice","amountKopecks","endedAt","observedAt",
            "providerBookedAt","createdAt","updatedAt")
         VALUES ($1,'yandex_fleet',$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),NOW())
         ON CONFLICT ("provider","externalParkId","externalOrderId") DO NOTHING`,
        randomUUID(), externalParkId, externalOrderId, String(3982000 + orderSequence),
        PROFILE, rawPrice, Math.round(Number(rawPrice) * 100), endedAt, observedAt,
        new Date(endedAt.getTime() - 600_000),
    )

    const submitted = await submitCompensationApplicationV1({
        contract: SUBMIT_COMPENSATION_APPLICATION_COMMAND_V1,
        idempotencyKey: randomUUID(),
        person: provenPerson(contactId),
        order: {
            provider: 'yandex_fleet',
            externalParkId,
            externalOrderId,
            shortOrderIdDisplay: String(3982000 + orderSequence),
            rawPrice,
            endedAt,
            verifiedAt: observedAt,
        },
        claimedRubles: options.claimedRubles ?? 300,
        submittedAt: new Date(),
    })

    const fileId = options.attachmentFileId === undefined ? `tg-file-${orderSequence}` : options.attachmentFileId
    if (fileId !== null) {
        await database.$executeRawUnsafe(
            `INSERT INTO "CompensationPilotSubmission"
               ("id","applicationId","telegramUserId","supportContactedAt","attachmentFileId",
                "attachmentKind","claimedRubles","createdAt")
             VALUES ($1,$2,$3,$4,$5,'photo',$6,NOW())
             ON CONFLICT ("applicationId") DO NOTHING`,
            randomUUID(), submitted.applicationId, `77700${orderSequence}`, NOW,
            fileId, options.claimedRubles ?? 300,
        )
    }

    return { applicationId: submitted.applicationId, externalOrderId, contactId }
}

const act = (
    applicationId: string,
    action: Parameters<typeof performManagerActionV1>[0]['action'],
    over: Partial<Parameters<typeof performManagerActionV1>[0]> = {},
): Promise<ManagerActionResultV1> => performManagerActionV1(
    { applicationId, action, principal: MANAGER, ...over }, store,
)

/** Approve one claim the way the screens do: the screenshot is fetched first. */
const approve = (applicationId: string, principal: ManagerPrincipalV1 = MANAGER) =>
    performManagerActionV1({ applicationId, action: 'approve', principal, evidenceProven: true }, store)

async function applicationRow(applicationId: string) {
    const rows = await database.$queryRawUnsafe<Array<{
        status: string; version: number; rejectionKey: string | null; rejectionReason: string | null
    }>>(
        `SELECT "status","version","rejectionKey","rejectionReason" FROM "CompensationApplication" WHERE "id" = $1`,
        applicationId,
    )
    return { ...rows[0], version: Number(rows[0].version) }
}

async function authorizationRows(applicationId: string) {
    return database.$queryRawUnsafe<Array<{ id: string; state: string; authorizationFence: string }>>(
        `SELECT "id","state","authorizationFence" FROM "CompensationPayoutAuthorization"
         WHERE "applicationId" = $1 ORDER BY "openedAt" ASC`,
        applicationId,
    )
}

async function count(table: string, where = '', ...args: unknown[]): Promise<number> {
    const rows = await database.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT COUNT(*)::bigint AS count FROM "${table}" ${where}`, ...args,
    )
    return Number(rows[0].count)
}

async function truncateAll(): Promise<void> {
    await database.$executeRawUnsafe(`TRUNCATE TABLE
        "CompensationPilotSubmission","CompensationAuditEvent","CompensationReconciliationTask",
        "CompensationSettlement","CompensationPayoutAuthorization","CompensationApplication",
        "CompensationOrderClaim","CompensationVerifiedOrder","CompensationPersonBinding",
        "CompensationPerson","CompensationBudgetPeriod","CompensationCashOrder",
        "ContactPhone","Contact","ApiConnection"
        RESTART IDENTITY CASCADE`)
}

proof('the manager workflow on real PostgreSQL', () => {
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
        await openPeriod()
    })

    describe('what the list and the detail show', () => {
        it('names the person, the park and the order, and says a screenshot is there', async () => {
            const seeded = await seedApplication({ displayName: 'Иванов Иван', phone: '+79990000777' })

            const list = await listManagerApplicationsV1({}, store)
            expect(list.rows).toHaveLength(1)
            expect(list.rows[0]).toMatchObject({
                applicationId: seeded.applicationId,
                state: 'new',
                driverName: 'Иванов Иван',
                parkName: 'Парк Йоко',
                externalParkId: PARK,
                periodKey: PERIOD_KEY,
                requestedKopecks: 30_000,
                orderAmountKopecks: 33_500,
                payableKopecks: 30_000,
                evidence: 'present',
            })

            const detail = await readManagerApplicationV1(seeded.applicationId, store, new Date())
            expect(detail).toMatchObject({
                status: 'PENDING',
                driverPhone: '+79990000777',
                externalDriverProfileId: PROFILE,
                boundContactIds: [seeded.contactId],
                attachmentKind: 'photo',
                allowedActions: ['approve', 'reject'],
            })
            expect(detail!.snapshot).toMatchObject({ rawPrice: '335.0000', amountKopecks: 33_500 })
            expect(detail!.catalogue).toMatchObject({ present: true, amountKopecks: 33_500 })
        })

        it('says the screenshot is missing when the driver never attached one', async () => {
            const seeded = await seedApplication({ attachmentFileId: null })
            const detail = await readManagerApplicationV1(seeded.applicationId, store, new Date())
            expect(detail!.evidence).toBe('missing')
            // A claim nobody can see the support reply for may only be refused.
            expect(detail!.allowedActions).toEqual(['reject'])
        })

        it('keeps the screenshot id server-side, out of everything a screen receives', async () => {
            const seeded = await seedApplication()
            const detail = await readManagerApplicationV1(seeded.applicationId, store, new Date())
            expect(JSON.stringify(detail)).not.toContain('tg-file-')

            // The transport asks for it by application, and only the server can.
            expect(await store.findEvidenceSource(seeded.applicationId))
                .toMatchObject({ kind: 'photo' })
            expect((await store.findEvidenceSource(seeded.applicationId))!.fileId).toMatch(/^tg-file-/u)
        })

        it('walks one claim from new to paid, showing each state and the settlement', async () => {
            const seeded = await seedApplication()

            expect(await approve(seeded.applicationId)).toMatchObject({
                code: 'performed', state: 'awaiting_payment',
            })
            const authorised = await readManagerApplicationV1(seeded.applicationId, store, new Date())
            expect(authorised!.authorization).toMatchObject({ state: 'active', openedByLabel: 'Менеджер Аня' })
            expect(authorised!.authorization!.age.beyondUnaidedRecall).toBe(false)

            expect(await act(seeded.applicationId, 'mark_paid')).toMatchObject({
                code: 'performed', state: 'paid',
            })
            const paid = await readManagerApplicationV1(seeded.applicationId, store, new Date())
            expect(paid!.status).toBe('PAID')
            expect(paid!.settlement).toMatchObject({ amountKopecks: 30_000, settledByLabel: 'Менеджер Аня' })
            expect(paid!.allowedActions).toEqual([])
            // The history is the core's own record, oldest first.
            expect(paid!.history.map((entry) => entry.action)).toEqual([
                'submit', 'payout_authorization_opened', 'payout_finalized',
            ])
            expect(paid!.history.at(-1)).toMatchObject({ actorLabel: 'Менеджер Аня', amountKopecks: 30_000 })
        })

        it('shows a rejected claim with the reason the manager gave', async () => {
            const seeded = await seedApplication()
            expect(await act(seeded.applicationId, 'reject', { reason: 'Скриншот не подтверждает оплату' }))
                .toMatchObject({ code: 'performed', state: 'rejected' })

            const detail = await readManagerApplicationV1(seeded.applicationId, store, new Date())
            expect(detail).toMatchObject({
                status: 'REJECTED',
                rejectionReason: 'Скриншот не подтверждает оплату',
                allowedActions: [],
            })
            expect(detail!.rejectedAt).not.toBeNull()
        })

        it('puts a payout of unknown outcome into reconciliation and back out again', async () => {
            const seeded = await seedApplication()
            await approve(seeded.applicationId)

            expect(await act(seeded.applicationId, 'declare_outcome_unknown', { reason: 'Перевод не виден в банке' }))
                .toMatchObject({ code: 'performed', state: 'reconciliation' })
            const open = await readManagerApplicationV1(seeded.applicationId, store, new Date())
            expect(open!.reconciliation).toMatchObject({ state: 'open', reason: 'Перевод не виден в банке' })
            expect(open!.allowedActions).toEqual(['reconcile_paid', 'reconcile_not_paid'])

            expect(await act(seeded.applicationId, 'reconcile_paid', { reason: 'Выписка подтверждает перевод' }))
                .toMatchObject({ code: 'performed', state: 'paid' })
            expect(await count('CompensationSettlement')).toBe(1)
        })

        it('returns a claim to new when reconciliation says the money never left', async () => {
            const seeded = await seedApplication()
            await approve(seeded.applicationId)
            await act(seeded.applicationId, 'declare_outcome_unknown')

            expect(await act(seeded.applicationId, 'reconcile_not_paid')).toMatchObject({
                code: 'performed', state: 'new',
            })
            expect(await count('CompensationSettlement')).toBe(0)
            const back = await readManagerApplicationV1(seeded.applicationId, store, new Date())
            expect(back!.status).toBe('PENDING')
            expect(back!.allowedActions).toEqual(['approve', 'reject'])
        })

        it('refuses to pay an approval older than a day, and reconciliation still can', async () => {
            const seeded = await seedApplication()
            await approve(seeded.applicationId)
            // The payout right is aged past the unaided-recall window in place,
            // which is the one fact the manager screen cannot fake.
            await database.$executeRawUnsafe(
                `UPDATE "CompensationPayoutAuthorization"
                 SET "openedAt" = NOW() - interval '25 hours', "expiresAt" = NOW() - interval '24 hours'`,
            )

            expect(await act(seeded.applicationId, 'mark_paid')).toMatchObject({
                code: 'authorization_too_old_reconcile', state: 'awaiting_payment',
            })
            expect(await count('CompensationSettlement')).toBe(0)

            const aged = await readManagerApplicationV1(seeded.applicationId, store, new Date())
            expect(aged!.authorization!.age).toMatchObject({ beyondUnaidedRecall: true, stale: true })

            // The way out is the process the refusal names.
            await act(seeded.applicationId, 'declare_outcome_unknown', { reason: 'Одобрение старше суток' })
            expect(await act(seeded.applicationId, 'reconcile_paid', { reason: 'Выписка подтверждает перевод' }))
                .toMatchObject({ code: 'performed', state: 'paid' })
            expect(await count('CompensationSettlement')).toBe(1)
        })

        it('returns a claim to new when the manager cancels the approval', async () => {
            const seeded = await seedApplication()
            await approve(seeded.applicationId)
            expect(await act(seeded.applicationId, 'cancel_approval', { reason: 'Одобрено по ошибке' }))
                .toMatchObject({ code: 'performed', state: 'new' })
            expect(await count('CompensationSettlement')).toBe(0)
        })

        it('is absent for an application id nobody has', async () => {
            expect(await readManagerApplicationV1(randomUUID(), store, new Date())).toBeNull()
            expect(await act(randomUUID(), 'approve', { evidenceProven: true }))
                .toMatchObject({ code: 'application_not_found', state: null })
        })
    })

    describe('filtering and paging the list', () => {
        it('filters by state, by park and by month', async () => {
            const first = await seedApplication()
            const second = await seedApplication({ externalParkId: OTHER_PARK })
            await approve(second.applicationId)

            const awaiting = await listManagerApplicationsV1({ state: 'awaiting_payment' }, store)
            expect(awaiting.rows.map((row) => row.applicationId)).toEqual([second.applicationId])

            const byPark = await listManagerApplicationsV1({ externalParkId: PARK }, store)
            expect(byPark.rows.map((row) => row.applicationId)).toEqual([first.applicationId])

            const thisMonth = await listManagerApplicationsV1({ periodKey: PERIOD_KEY }, store)
            expect(thisMonth.rows).toHaveLength(2)
            expect((await listManagerApplicationsV1({ periodKey: '2000-01' }, store)).rows).toEqual([])
        })

        it('pages through every row exactly once, newest first', async () => {
            const seeded = []
            for (let index = 0; index < 5; index += 1) seeded.push(await seedApplication())

            const seen: string[] = []
            let cursor: string | null = null
            let pages = 0
            do {
                const page: Awaited<ReturnType<typeof listManagerApplicationsV1>> =
                    await listManagerApplicationsV1({ limit: 2, cursor }, store)
                seen.push(...page.rows.map((row) => row.applicationId))
                cursor = page.nextCursor
                pages += 1
            } while (cursor !== null && pages < 10)

            expect(seen).toHaveLength(5)
            expect(new Set(seen).size).toBe(5)
            expect(new Set(seen)).toEqual(new Set(seeded.map((row) => row.applicationId)))
        })

        it('does not repeat a row when one is decided between two pages', async () => {
            const seeded = []
            for (let index = 0; index < 4; index += 1) seeded.push(await seedApplication())

            const first = await listManagerApplicationsV1({ limit: 2 }, store)
            // The manager rejects a row from the page they are looking at; the
            // cursor is the sort key, so the next page is unaffected by it.
            await act(first.rows[0].applicationId, 'reject', { reason: 'Дубль' })
            const second = await listManagerApplicationsV1({ limit: 2, cursor: first.nextCursor }, store)

            const seen = [...first.rows, ...second.rows].map((row) => row.applicationId)
            expect(new Set(seen).size).toBe(4)
        })
    })

    describe('the budget dashboard', () => {
        it('counts the month the way the ledger does', async () => {
            const first = await seedApplication()
            const second = await seedApplication()
            const third = await seedApplication()
            await approve(second.applicationId)
            await act(third.applicationId, 'reject', { reason: 'Нет подтверждения' })

            const budget = await readManagerBudgetV1(PERIOD_KEY, store)
            expect(budget).toMatchObject({
                periodKey: PERIOD_KEY,
                state: 'open',
                limitKopecks: 500_000,
                reservedKopecks: 60_000,
                settledKopecks: 0,
                remainingKopecks: 440_000,
                awaitingPaymentKopecks: 30_000,
                ledgerConsistent: true,
            })
            expect(budget.counts).toEqual({
                new: 1, awaiting_payment: 1, reconciliation: 0, paid: 0, rejected: 1,
            })
            expect(budget.applicationCount).toBe(3)
            expect(first.applicationId).not.toBe(second.applicationId)
        })

        it('moves money from reserved to settled when a payout is confirmed', async () => {
            const seeded = await seedApplication()
            await approve(seeded.applicationId)
            await act(seeded.applicationId, 'mark_paid')

            const budget = await readManagerBudgetV1(PERIOD_KEY, store)
            expect(budget).toMatchObject({
                reservedKopecks: 0,
                settledKopecks: 30_000,
                remainingKopecks: 470_000,
                awaitingPaymentKopecks: 0,
                paidCount: 1,
                ledgerConsistent: true,
            })
            expect(budget.counts.paid).toBe(1)
        })

        it('reports a month that has no ledger row at all', async () => {
            expect(await readManagerBudgetV1('2000-01', store)).toMatchObject({
                state: 'missing', limitKopecks: 0, remainingKopecks: 0,
            })
        })

        it('shows a ledger that drifted from its applications without repairing it', async () => {
            await seedApplication()
            await database.$executeRawUnsafe(
                `UPDATE "CompensationBudgetPeriod" SET "reservedKopecks" = "reservedKopecks" + 1 WHERE "periodKey" = $1`,
                PERIOD_KEY,
            )
            const budget = await readManagerBudgetV1(PERIOD_KEY, store)
            expect(budget.ledgerConsistent).toBe(false)
            expect(budget.reservedKopecks).toBe(30_001)
        })

        it('refuses a claim once the month is spent, and says so in the manager\'s words', async () => {
            await truncateAll()
            await openPeriod(30_000)
            const first = await seedApplication()
            await approve(first.applicationId)
            await act(first.applicationId, 'mark_paid')

            // The month is fully settled; a second claim cannot even be filed.
            await expect(seedApplication()).rejects.toMatchObject({ code: 'budget_exhausted' })
            expect(await readManagerBudgetV1(PERIOD_KEY, store)).toMatchObject({
                remainingKopecks: 0, settledKopecks: 30_000,
            })
        })
    })

    describe('two managers acting at once', () => {
        it('opens exactly one payout right when both approve', async () => {
            const seeded = await seedApplication()
            const [left, right] = await Promise.all([
                approve(seeded.applicationId, MANAGER),
                approve(seeded.applicationId, SECOND_MANAGER),
            ])

            // Whether the loser is refused before the core (its read already
            // showed the payout right) or replayed by it, one right exists.
            expect([left.code, right.code]).toContain('performed')
            expect([left.code, right.code].filter((code) => code === 'performed')).toHaveLength(1)
            expect([left.code, right.code].find((code) => code !== 'performed'))
                .toMatch(/^(already_done|already_approved)$/u)
            expect(left.state).toBe('awaiting_payment')
            expect(right.state).toBe('awaiting_payment')
            expect(await count('CompensationPayoutAuthorization')).toBe(1)
        })

        it('lets exactly one of an approval and a rejection through', async () => {
            const seeded = await seedApplication()
            const [approved, rejected] = await Promise.all([
                approve(seeded.applicationId, MANAGER),
                performManagerActionV1({
                    applicationId: seeded.applicationId,
                    action: 'reject',
                    reason: 'Не подтверждено',
                    principal: SECOND_MANAGER,
                }, store),
            ])

            const performed = [approved, rejected].filter((result) => result.code === 'performed')
            expect(performed).toHaveLength(1)
            const detail = await readManagerApplicationV1(seeded.applicationId, store, new Date())
            if (performed[0] === approved) {
                // The rejection lost: the core refuses to reject funded money.
                expect(rejected.code).toBe('payout_authorization_active')
                expect(detail!.state).toBe('awaiting_payment')
            } else {
                expect(approved.code).toBe('already_rejected')
                expect(detail!.state).toBe('rejected')
            }
            expect(await count('CompensationSettlement')).toBe(0)
        })

        it('never pays and rejects the same claim', async () => {
            const seeded = await seedApplication()
            await approve(seeded.applicationId)

            const [paid, rejected] = await Promise.all([
                act(seeded.applicationId, 'mark_paid'),
                performManagerActionV1({
                    applicationId: seeded.applicationId,
                    action: 'reject',
                    reason: 'Передумали',
                    principal: SECOND_MANAGER,
                }, store),
            ])

            expect(paid.code).toBe('performed')
            expect(rejected.code).not.toBe('performed')
            expect(await count('CompensationSettlement')).toBe(1)
            expect(await count('CompensationApplication', 'WHERE "status" = $1', 'PAID')).toBe(1)
        })

        it('settles or cancels a payout right, never both', async () => {
            const seeded = await seedApplication()
            await approve(seeded.applicationId)

            const [finalized, cancelled] = await Promise.all([
                act(seeded.applicationId, 'mark_paid'),
                performManagerActionV1({
                    applicationId: seeded.applicationId,
                    action: 'cancel_approval',
                    principal: SECOND_MANAGER,
                }, store),
            ])

            const winners = [finalized, cancelled].filter((result) => result.code === 'performed')
            expect(winners).toHaveLength(1)
            const settlements = await count('CompensationSettlement')
            if (winners[0] === finalized) {
                expect(settlements).toBe(1)
                expect(finalized.state).toBe('paid')
            } else {
                expect(settlements).toBe(0)
                expect(cancelled.state).toBe('new')
            }
        })

        it('resolves a reconciliation once, however many managers answer it', async () => {
            const seeded = await seedApplication()
            await approve(seeded.applicationId)
            await act(seeded.applicationId, 'declare_outcome_unknown')

            const [left, right] = await Promise.all([
                performManagerActionV1({
                    applicationId: seeded.applicationId, action: 'reconcile_paid', principal: MANAGER,
                }, store),
                performManagerActionV1({
                    applicationId: seeded.applicationId, action: 'reconcile_paid', principal: SECOND_MANAGER,
                }, store),
            ])

            expect([left, right].filter((result) => result.code === 'performed')).toHaveLength(1)
            expect(await count('CompensationSettlement')).toBe(1)
            expect(await count('CompensationReconciliationTask', `WHERE "state" = 'open'`)).toBe(0)
        })

        it('answers a manager whose screen was stale with the state, not with a stale echo', async () => {
            const seeded = await seedApplication()
            // The first manager pays while the second still has 'new' on screen.
            await approve(seeded.applicationId)
            await act(seeded.applicationId, 'mark_paid')

            const late = await performManagerActionV1({
                applicationId: seeded.applicationId,
                action: 'approve',
                principal: SECOND_MANAGER,
                evidenceProven: true,
            }, store)
            expect(late).toMatchObject({ code: 'already_paid', state: 'paid' })
        })
    })

    describe('retrying an action', () => {
        it('replays one rejection instead of writing a second', async () => {
            const seeded = await seedApplication()
            const first = await act(seeded.applicationId, 'reject', { reason: 'Дубль заявки' })
            const second = await act(seeded.applicationId, 'reject', { reason: 'Дубль заявки' })

            expect(first.code).toBe('performed')
            // The second attempt sees a settled application, not a second write.
            expect(second).toMatchObject({ code: 'already_rejected', state: 'rejected' })
            expect(await count('CompensationApplication', 'WHERE "status" = $1', 'REJECTED')).toBe(1)
        })

        it('refuses to pay a claim whose payout right was already released', async () => {
            const seeded = await seedApplication()
            await approve(seeded.applicationId)
            await act(seeded.applicationId, 'cancel_approval')

            expect(await act(seeded.applicationId, 'mark_paid')).toMatchObject({
                code: 'state_changed', state: 'new',
            })
            expect(await count('CompensationSettlement')).toBe(0)
        })
    })

    describe('resolving a reconciliation as not paid', () => {
        // Before cfc36f50 this path was unreachable: the resolution asked the
        // shared release body to cancel an unknown_outcome authorization, the
        // cancel rule refused it with reconciliation_required, and the task could
        // never close. This walks the exact chain through the real core.
        it('takes an unknown outcome through reconciliation back to NEW', async () => {
            const seeded = await seedApplication()
            await approve(seeded.applicationId)
            const before = await applicationRow(seeded.applicationId)

            expect(await act(seeded.applicationId, 'declare_outcome_unknown', { reason: 'Перевод не виден' }))
                .toMatchObject({ code: 'performed', state: 'reconciliation' })
            const unknown = await authorizationRows(seeded.applicationId)
            expect(unknown).toEqual([expect.objectContaining({ state: 'unknown_outcome' })])
            expect(await count('CompensationReconciliationTask', `WHERE "state" = 'open'`)).toBe(1)

            expect(await act(seeded.applicationId, 'reconcile_not_paid', { reason: 'Банк вернул перевод' }))
                .toMatchObject({ code: 'performed', state: 'new' })

            // The payout right is released, the task is closed as not paid, and
            // the claim is PENDING again with its money still reserved.
            expect(await authorizationRows(seeded.applicationId))
                .toEqual([expect.objectContaining({ state: 'cancelled' })])
            const tasks = await database.$queryRawUnsafe<Array<{ state: string; resolution: string }>>(
                `SELECT "state","resolution" FROM "CompensationReconciliationTask"`,
            )
            expect(tasks).toEqual([{ state: 'resolved', resolution: 'not_paid' }])
            const after = await applicationRow(seeded.applicationId)
            expect(after).toMatchObject({ status: 'PENDING', version: before.version + 1 })
            expect(await count('CompensationSettlement')).toBe(0)
            expect(await readManagerBudgetV1(PERIOD_KEY, store)).toMatchObject({
                reservedKopecks: 30_000, settledKopecks: 0, ledgerConsistent: true,
            })
            const actions = (await database.$queryRawUnsafe<Array<{ action: string }>>(
                `SELECT "action" FROM "CompensationAuditEvent" ORDER BY "occurredAt" ASC, "id" ASC`,
            )).map((row) => row.action)
            // Both rows carry the resolution time, so their mutual order is not
            // a fact; that both exist, last, is.
            expect([...actions.slice(-2)].sort()).toEqual(['payout_authorization_cancelled', 'reconciliation_resolved'])

            // And the claim is genuinely payable again: a fresh payout right
            // opens under a new identity, beside the released one.
            expect(await approve(seeded.applicationId)).toMatchObject({ code: 'performed', state: 'awaiting_payment' })
            const rights = await authorizationRows(seeded.applicationId)
            expect(rights.map((row) => row.state).sort()).toEqual(['active', 'cancelled'])
            expect(new Set(rights.map((row) => row.id)).size).toBe(2)
        })

        it('still refuses a plain cancel of an unknown outcome outside reconciliation', async () => {
            const seeded = await seedApplication()
            await approve(seeded.applicationId)
            await act(seeded.applicationId, 'declare_outcome_unknown')
            const [right] = await authorizationRows(seeded.applicationId)

            // The manager screen never offers this, so it is asked of the port
            // directly: the relaxed rule belongs to reconciliation alone.
            expect(await store.releasePayout({
                payoutAuthorizationId: right.id,
                authorizationFence: right.authorizationFence,
                kind: 'cancel_preparation',
                reason: 'Попытка отменить в обход сверки',
                principal: MANAGER,
            })).toEqual({ ok: false, code: 'reconciliation_required', replayed: false })
            expect(await authorizationRows(seeded.applicationId))
                .toEqual([expect.objectContaining({ state: 'unknown_outcome' })])
        })
    })

    describe('the rejection key', () => {
        // The key is sha256(applicationId | CompensationApplication.version),
        // truncated. version is C1's own counter of settled application
        // transitions: inserted as 0 and advanced only by finalize, by releasing
        // a preparation and by reject. It is not a CAS version; no command takes it.

        it('is derived from the id and the version C1 holds, and is stored exactly', async () => {
            const seeded = await seedApplication()
            const read = await applicationRow(seeded.applicationId)
            expect(read.version).toBe(0)

            await act(seeded.applicationId, 'reject', { reason: 'Нет чека' })
            const stored = await applicationRow(seeded.applicationId)
            expect(stored.rejectionKey).toBe(managerRejectionKeyV1(seeded.applicationId, 0))
            // The rejection itself advances the version, which is what keeps any
            // later rejection attempt from ever computing the stored key again.
            expect(stored.version).toBe(1)
        })

        it('replays a retried rejection instead of writing a second one', async () => {
            const seeded = await seedApplication()
            const key = managerRejectionKeyV1(seeded.applicationId, 0)
            const reject = () => store.rejectApplication({
                applicationId: seeded.applicationId, reason: 'Нет чека', rejectionKey: key, principal: MANAGER,
            })

            // A lost response retried from the same read presents the same key.
            expect(await reject()).toEqual({ ok: true, code: null, replayed: false })
            expect(await reject()).toEqual({ ok: true, code: null, replayed: true })
            expect(await count('CompensationAuditEvent', `WHERE "action" = 'reject'`)).toBe(1)
            expect(await readManagerBudgetV1(PERIOD_KEY, store)).toMatchObject({ reservedKopecks: 0 })
        })

        it('turns two simultaneous rejections into one', async () => {
            const seeded = await seedApplication()
            const [left, right] = await Promise.all([
                act(seeded.applicationId, 'reject', { reason: 'Нет чека' }),
                performManagerActionV1({
                    applicationId: seeded.applicationId, action: 'reject', reason: 'Нет чека', principal: SECOND_MANAGER,
                }, store),
            ])
            expect([left.code, right.code]).toContain('performed')
            expect([left.code, right.code].find((code) => code !== 'performed'))
                .toMatch(/^(already_done|already_rejected)$/u)
            expect(await count('CompensationAuditEvent', `WHERE "action" = 'reject'`)).toBe(1)
            expect((await applicationRow(seeded.applicationId)).rejectionKey)
                .toBe(managerRejectionKeyV1(seeded.applicationId, 0))
        })

        it('does not treat a later rejection attempt as a replay of the stored one', async () => {
            const seeded = await seedApplication()
            await act(seeded.applicationId, 'reject', { reason: 'Нет чека' })
            // A reader after the rejection sees version 1 and would compute this:
            const laterKey = managerRejectionKeyV1(seeded.applicationId, 1)
            expect(await store.rejectApplication({
                applicationId: seeded.applicationId, reason: 'Другая причина', rejectionKey: laterKey, principal: SECOND_MANAGER,
            })).toEqual({ ok: false, code: 'not_pending', replayed: false })
            expect((await applicationRow(seeded.applicationId)).rejectionReason).toBe('Нет чека')
        })

        it('is moved by a C1 transition and by nothing else', async () => {
            const seeded = await seedApplication()
            const keyOf = async () => {
                const facts = await store.findApplication(seeded.applicationId)
                return managerRejectionKeyV1(facts!.applicationId, facts!.version)
            }
            const initial = await keyOf()

            // Timestamps, the catalogue observation, the person's name and phone,
            // the screenshot row and an opened-then-still-active payout right do
            // not touch the inputs.
            await database.$executeRawUnsafe(
                `UPDATE "CompensationApplication" SET "updatedAt" = NOW() + interval '1 hour' WHERE "id" = $1`,
                seeded.applicationId,
            )
            await database.$executeRawUnsafe(
                `UPDATE "CompensationCashOrder" SET "observedAt" = NOW(), "updatedAt" = NOW()`,
            )
            await database.$executeRawUnsafe(
                `UPDATE "Contact" SET "displayName" = 'Переименован', "updatedAt" = NOW() WHERE "id" = $1`,
                seeded.contactId,
            )
            await database.$executeRawUnsafe(
                `UPDATE "CompensationPilotSubmission" SET "supportContactedAt" = NOW() WHERE "applicationId" = $1`,
                seeded.applicationId,
            )
            await approve(seeded.applicationId)
            expect(await keyOf()).toBe(initial)

            // Releasing the preparation is a settled transition: the key moves,
            // and the rejection that follows stores the new one.
            await act(seeded.applicationId, 'cancel_approval')
            const moved = await keyOf()
            expect(moved).not.toBe(initial)
            expect(moved).toBe(managerRejectionKeyV1(seeded.applicationId, 1))
            await act(seeded.applicationId, 'reject', { reason: 'Нет чека' })
            expect((await applicationRow(seeded.applicationId)).rejectionKey).toBe(moved)
        })
    })
})
