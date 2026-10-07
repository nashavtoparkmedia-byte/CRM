/**
 * Isolated-PostgreSQL proof for the cash compensation monetary core.
 *
 * Gated behind YOKO_COMPENSATION_MONETARY_POSTGRES_PROOF=1 and an isolated
 * DATABASE_URL. It never touches a production database.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '@/lib/prisma'
import {
    FINALIZE_COMPENSATION_PAYOUT_COMMAND_V1,
    REJECT_COMPENSATION_APPLICATION_COMMAND_V1,
    RELEASE_COMPENSATION_PAYOUT_COMMAND_V1,
    RESOLVE_COMPENSATION_RECONCILIATION_COMMAND_V1,
    START_COMPENSATION_PAYOUT_COMMAND_V1,
    SUBMIT_COMPENSATION_APPLICATION_COMMAND_V1,
    type SubmitCompensationApplicationCommandV1,
} from '@/contracts/fleet-operations/v1'
import {
    compensationPublicTotalsV1,
    finalizeCompensationPayoutV1,
    rejectCompensationApplicationV1,
    releaseCompensationPayoutV1,
    resolveCompensationReconciliationV1,
    startCompensationPayoutV1,
    submitCompensationApplicationV1,
} from './compensation-prisma-adapter'
import { compensationPeriodSubmissionClosesAtV1 } from './compensation-submission-window'
import {
    compensationBusinessDayKeyV1,
    compensationMonthEndInstantV1,
    compensationMonthStartInstantV1,
} from './compensation-calendar'
import type { ProvenCanonicalPersonV1 } from './compensation-ports'

const proof = process.env.YOKO_COMPENSATION_MONETARY_POSTGRES_PROOF === '1' ? describe : describe.skip

const database = prisma as unknown as {
    $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>
    $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>
}

const PRINCIPAL = { principalId: 'u1', principalKind: 'crm_user' as const, operatorLabel: 'Test Manager' }

// Payout operations are checked against the database clock, so their
// timestamps are anchored to real time rather than to the fixed order dates.
const at = (minutes: number): Date => new Date(Date.now() + minutes * 60_000)
const AUGUST = { year: 2026, month: 8 }
const SEPTEMBER = { year: 2026, month: 9 }

/** The error code is the stable contract; the message is not. */
async function expectCode(operation: Promise<unknown>, code: string): Promise<void> {
    await expect(operation).rejects.toMatchObject({ name: 'CompensationErrorV1', code })
}

let contactSeq = 0
function evidence(lineage: string[] = []): ProvenCanonicalPersonV1 {
    contactSeq += 1
    const canonical = `c_${contactSeq}`
    const ids = [canonical, ...lineage].sort()
    return {
        canonicalContactId: canonical,
        resolutionStatus: lineage.length === 0 ? 'live' : 'merged_into',
        lineage,
        lineageDigest: `d_${ids.join('|')}`,
        evidenceAt: new Date('2026-09-01T00:00:00.000Z'),
    }
}

let orderSeq = 0
function order(overrides: Partial<SubmitCompensationApplicationCommandV1['order']> = {}) {
    orderSeq += 1
    return {
        provider: 'yandex_fleet',
        externalParkId: '3a23295d8d714c03b61a17a6fc86601b',
        externalOrderId: `order${String(orderSeq).padStart(26, '0')}`,
        shortOrderIdDisplay: '3975000',
        rawPrice: '306.0000',
        // 10 Sep 15:00 Yekaterinburg.
        endedAt: new Date('2026-09-10T10:00:00.000Z'),
        verifiedAt: new Date('2026-09-10T10:05:00.000Z'),
        ...overrides,
    }
}

let keySeq = 0
const uuid = (): string => {
    keySeq += 1
    return `00000000-0000-4000-8000-${String(keySeq).padStart(12, '0')}`
}

function submitCommand(
    overrides: Partial<SubmitCompensationApplicationCommandV1> = {},
): SubmitCompensationApplicationCommandV1 {
    return {
        contract: SUBMIT_COMPENSATION_APPLICATION_COMMAND_V1,
        idempotencyKey: uuid(),
        person: evidence(),
        order: order(),
        claimedRubles: 500,
        submittedAt: new Date('2026-09-10T11:00:00.000Z'),
        ...overrides,
    }
}

/* Payout operations, with the manager's instants anchored to real time. */
type Started = { payoutAuthorizationId: string; authorizationFence: string }

const startPayout = (applicationId: string, startedAt: Date = at(0)) => startCompensationPayoutV1({
    contract: START_COMPENSATION_PAYOUT_COMMAND_V1, applicationId, principal: PRINCIPAL, startedAt,
})
const finalizePayout = (started: Started, finalizedAt: Date = at(1)) => finalizeCompensationPayoutV1({
    contract: FINALIZE_COMPENSATION_PAYOUT_COMMAND_V1,
    payoutAuthorizationId: started.payoutAuthorizationId,
    authorizationFence: started.authorizationFence,
    principal: PRINCIPAL,
    finalizedAt,
})
const cancelPayout = (started: Started, releasedAt: Date = at(1)) => releaseCompensationPayoutV1({
    contract: RELEASE_COMPENSATION_PAYOUT_COMMAND_V1,
    payoutAuthorizationId: started.payoutAuthorizationId,
    authorizationFence: started.authorizationFence,
    kind: 'cancel_preparation',
    reason: 'manager did not pay',
    principal: PRINCIPAL,
    releasedAt,
})
const declareOutcomeUnknown = (started: Started, releasedAt: Date = at(1)) => releaseCompensationPayoutV1({
    contract: RELEASE_COMPENSATION_PAYOUT_COMMAND_V1,
    payoutAuthorizationId: started.payoutAuthorizationId,
    authorizationFence: started.authorizationFence,
    kind: 'declare_outcome_unknown',
    reason: 'dispatcher did not confirm',
    principal: PRINCIPAL,
    releasedAt,
})
const reconcile = (reconciliationTaskId: string, resolution: 'paid' | 'not_paid', resolvedAt: Date = at(2)) =>
    resolveCompensationReconciliationV1({
        contract: RESOLVE_COMPENSATION_RECONCILIATION_COMMAND_V1,
        reconciliationTaskId,
        resolution,
        resolutionEvidence: 'dispatcher statement line 42',
        principal: PRINCIPAL,
        resolvedAt,
    })
const rejectApplication = (applicationId: string, rejectedAt: Date = at(0)) => rejectCompensationApplicationV1({
    contract: REJECT_COMPENSATION_APPLICATION_COMMAND_V1,
    applicationId,
    rejectionKey: uuid(),
    reason: 'no receipt',
    principal: PRINCIPAL,
    rejectedAt,
})

/** Business day of the database clock, read the way the adapter reads it. */
async function databaseDayKey(): Promise<string> {
    const rows = await database.$queryRawUnsafe<Array<{ now: Date }>>('SELECT NOW() AS now')
    return compensationBusinessDayKeyV1(rows[0].now)
}

/**
 * Asserts the exact multiset of slot rows (order day, state). Every read of
 * the authorization table goes through `countRows`, the file's one reviewed
 * raw read site, so no new analyzer site is introduced by these proofs.
 */
async function expectSlotRows(expected: Array<{ intendedBusinessDay: string; state: string }>): Promise<void> {
    expect(await countRows(`SELECT COUNT(*)::bigint AS count FROM "CompensationPayoutAuthorization"`))
        .toBe(expected.length)
    for (const row of expected) {
        expect(await countRows(
            `SELECT COUNT(*)::bigint AS count FROM "CompensationPayoutAuthorization"
             WHERE "intendedBusinessDay" = $1 AND "state" = $2`,
            row.intendedBusinessDay, row.state,
        )).toBe(expected.filter((candidate) =>
            candidate.intendedBusinessDay === row.intendedBusinessDay && candidate.state === row.state).length)
    }
}

/**
 * A finalized slot row written directly, bypassing the adapter. `finalized`
 * sits outside the exclusive-right index, so the only unique index such a row
 * can hit is the person/order-day key the daily limit rests on.
 */
function insertFinalizedSlotRow(
    id: string,
    claim: { applicationId: string; compensationPersonId: string; amountKopecks: number },
    intendedBusinessDay: string,
): Promise<number> {
    return database.$executeRawUnsafe(
        `INSERT INTO "CompensationPayoutAuthorization"
            ("id","applicationId","compensationPersonId","intendedBusinessDay","amountKopecks",
             "state","authorizationFence","openedAt","expiresAt","closedAt","settlementId",
             "openedByPrincipal","createdAt","updatedAt")
         VALUES ($1,$2,$3,$4,$5,'finalized',$6,NOW(),NOW() + INTERVAL '30 minutes',NOW(),$7,'u1',NOW(),NOW())`,
        id, claim.applicationId, claim.compensationPersonId, intendedBusinessDay, claim.amountKopecks,
        'f'.repeat(64), `comp_settle_direct_${id}`,
    )
}

/** PostgreSQL reports a unique violation by its key columns; Prisma relays that detail. */
const PERSON_DAY_KEY_VIOLATION = /23505[\s\S]*\("compensationPersonId", "intendedBusinessDay"\)/

// Two orders on one Yekaterinburg day (10 Sep 15:00 and 17:00) and one on the day before.
const ORDER_DAY_A = { endedAt: new Date('2026-09-10T10:00:00.000Z'), verifiedAt: new Date('2026-09-10T10:05:00.000Z') }
const ORDER_DAY_B = { endedAt: new Date('2026-09-10T12:00:00.000Z'), verifiedAt: new Date('2026-09-10T12:05:00.000Z') }
const PREVIOUS_ORDER_DAY = { endedAt: new Date('2026-09-09T10:00:00.000Z'), verifiedAt: new Date('2026-09-09T10:05:00.000Z') }

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

async function periodRow(key: string) {
    const rows = await database.$queryRawUnsafe<Array<{ reservedKopecks: number; settledKopecks: number; state: string }>>(
        `SELECT "reservedKopecks","settledKopecks","state" FROM "CompensationBudgetPeriod" WHERE "periodKey" = $1`,
        key,
    )
    return rows[0]
}

async function countRows(sql: string, ...values: unknown[]): Promise<number> {
    const rows = await database.$queryRawUnsafe<Array<{ count: bigint }>>(sql, ...values)
    return Number(rows[0].count)
}

async function truncateAll(): Promise<void> {
    await database.$executeRawUnsafe(`TRUNCATE TABLE
        "CompensationAuditEvent","CompensationReconciliationTask","CompensationSettlement",
        "CompensationPayoutAuthorization","CompensationApplication","CompensationOrderClaim",
        "CompensationVerifiedOrder","CompensationPersonBinding","CompensationPerson",
        "CompensationBudgetPeriod" RESTART IDENTITY CASCADE`)
}

proof('compensation monetary core on real PostgreSQL', () => {
    beforeAll(async () => {
        await prisma.$connect()
    })
    afterAll(async () => {
        await truncateAll()
        await prisma.$disconnect()
    })
    beforeEach(async () => {
        await truncateAll()
        await openPeriod(AUGUST)
        await openPeriod(SEPTEMBER)
    })

    it('charges a 31 August order submitted 2 September to the August period', async () => {
        const result = await submitCompensationApplicationV1(submitCommand({
            // 31 Aug 18:00 Yekaterinburg.
            order: order({ endedAt: new Date('2026-08-31T13:00:00.000Z'), verifiedAt: new Date('2026-08-31T13:05:00.000Z') }),
            submittedAt: new Date('2026-09-02T09:00:00.000Z'),
        }))
        expect(result.budgetPeriodKey).toBe('2026-08')
        expect(result.amountKopecks).toBe(30_600)
        expect((await periodRow('2026-08')).reservedKopecks).toBe(30_600)
        expect((await periodRow('2026-09')).reservedKopecks).toBe(0)
    })

    it('refuses an individually expired order even though its period still accepts work', async () => {
        // Mid-month August order: its deadline was the end of August.
        await expectCode(
            submitCompensationApplicationV1(submitCommand({
                order: order({ endedAt: new Date('2026-08-10T10:00:00.000Z'), verifiedAt: new Date('2026-08-10T10:05:00.000Z') }),
                submittedAt: new Date('2026-09-02T09:00:00.000Z'),
            })),
            'submission_window_closed',
        )
        expect((await periodRow('2026-08')).reservedKopecks).toBe(0)
    })

    it('replays the same logical submit and rejects a reused key with a different intent', async () => {
        const command = submitCommand()
        const first = await submitCompensationApplicationV1(command)
        const replay = await submitCompensationApplicationV1(command)
        expect(replay.status).toBe('replayed')
        expect(replay.applicationId).toBe(first.applicationId)
        expect((await periodRow('2026-09')).reservedKopecks).toBe(first.amountKopecks)

        await expectCode(
            submitCompensationApplicationV1({ ...command, claimedRubles: 400 }),
            'idempotency_conflict',
        )
    })

    it('allows one active PENDING per canonical person', async () => {
        const person = evidence()
        await submitCompensationApplicationV1(submitCommand({ person }))
        await expectCode(
            submitCompensationApplicationV1(submitCommand({ person })),
            'active_pending_exists',
        )
    })

    it('keeps the monetary identity across a contact merge', async () => {
        const first = evidence()
        const created = await submitCompensationApplicationV1(submitCommand({ person: first }))
        const merged: ProvenCanonicalPersonV1 = {
            canonicalContactId: 'c_survivor',
            resolutionStatus: 'merged_into',
            lineage: [first.canonicalContactId],
            lineageDigest: `d_merged_${first.canonicalContactId}`,
            evidenceAt: new Date('2026-09-11T00:00:00.000Z'),
        }
        // Same monetary person, so the active PENDING slot is still taken.
        await expectCode(
            submitCompensationApplicationV1(submitCommand({ person: merged })),
            'active_pending_exists',
        )
        const bindings = await database.$queryRawUnsafe<Array<{ compensationPersonId: string }>>(
            `SELECT DISTINCT "compensationPersonId" FROM "CompensationPersonBinding"`,
        )
        expect(bindings).toHaveLength(1)
        expect(created.compensationPersonId).toBe(bindings[0].compensationPersonId)
    })

    it('settles a payout exactly once and moves reserved to settled', async () => {
        const submitted = await submitCompensationApplicationV1(submitCommand())
        const started = await startCompensationPayoutV1({
            contract: START_COMPENSATION_PAYOUT_COMMAND_V1,
            applicationId: submitted.applicationId,
            principal: PRINCIPAL,
            startedAt: at(0),
        })
        expect(started.status).toBe('opened')
        expect(started.amountKopecks).toBe(submitted.amountKopecks)

        const finalizeCommand = {
            contract: FINALIZE_COMPENSATION_PAYOUT_COMMAND_V1,
            payoutAuthorizationId: started.payoutAuthorizationId,
            authorizationFence: started.authorizationFence,
            principal: PRINCIPAL,
            finalizedAt: at(2),
        } as const
        const settled = await finalizeCompensationPayoutV1(finalizeCommand)
        expect(settled.status).toBe('settled')

        const replay = await finalizeCompensationPayoutV1(finalizeCommand)
        expect(replay.status).toBe('replayed')
        expect(replay.settlementId).toBe(settled.settlementId)

        const period = await periodRow('2026-09')
        expect(period.reservedKopecks).toBe(0)
        expect(period.settledKopecks).toBe(submitted.amountKopecks)
        expect(await countRows(`SELECT COUNT(*)::bigint AS count FROM "CompensationSettlement"`)).toBe(1)
        expect(await compensationPublicTotalsV1()).toEqual({
            totalKopecks: submitted.amountKopecks,
            paidCount: 1,
        })
    })

    it('keys the payout slot by the order day, which neither the caller nor the clock can choose', async () => {
        const submitted = await submitCompensationApplicationV1(submitCommand())
        const started = await startPayout(submitted.applicationId)
        // The default order ended 10 Sep 15:00 Yekaterinburg; the manager pays today.
        expect(started.intendedBusinessDay).toBe('2026-09-10')
        expect(started.intendedBusinessDay).not.toBe(compensationBusinessDayKeyV1(new Date()))

        // Settle it so the person's active-PENDING slot is free; the order-day
        // slot stays consumed by the finalized authorization.
        await finalizePayout(started)

        // The caller's instant still has to agree with the database clock: it
        // stamps the preparation's expiry and its unaided-recall age.
        const second = await submitCompensationApplicationV1(submitCommand())
        await database.$executeRawUnsafe(
            `UPDATE "CompensationApplication" SET "compensationPersonId" = $2 WHERE "id" = $1`,
            second.applicationId, submitted.compensationPersonId,
        )
        await expectCode(
            startPayout(second.applicationId, new Date(Date.now() + 26 * 60 * 60 * 1000)),
            'payout_clock_skew',
        )
        // An honest preparation for another order of the same order day is
        // refused by the slot.
        await expectCode(startPayout(second.applicationId), 'daily_limit_reached')
    })

    it('settles on the database clock day, independent of the order-day slot the authorization holds', async () => {
        const submitted = await submitCompensationApplicationV1(submitCommand())
        const started = await startPayout(submitted.applicationId)
        expect(started.intendedBusinessDay).toBe('2026-09-10')
        const window = [await databaseDayKey()]
        const finalizedAt = at(1)
        const settled = await finalizePayout(started, finalizedAt)
        window.push(await databaseDayKey())
        // The payout day comes from the database clock: never from the slot,
        // which is an order day weeks ago, and never from the caller.
        expect(window).toContain(settled.businessDay)
        expect(settled.businessDay).not.toBe('2026-09-10')
        // The stored row agrees with the result, the slot is untouched, and
        // `settledAt` keeps the caller's instant, as before.
        expect(await countRows(
            `SELECT COUNT(*)::bigint AS count
             FROM "CompensationSettlement" s
             JOIN "CompensationPayoutAuthorization" a ON a."id" = s."payoutAuthorizationId"
             WHERE s."id" = $1 AND s."businessDay" = $2 AND a."intendedBusinessDay" = $3 AND s."settledAt" = $4`,
            settled.settlementId, settled.businessDay, '2026-09-10', finalizedAt,
        )).toBe(1)
        const replay = await finalizePayout(started, at(2))
        expect(replay.status).toBe('replayed')
        expect(replay.businessDay).toBe(settled.businessDay)
    })

    it('lets a released preparation be prepared again instead of bricking the application', async () => {
        const submitted = await submitCompensationApplicationV1(submitCommand())
        const first = await startCompensationPayoutV1({
            contract: START_COMPENSATION_PAYOUT_COMMAND_V1,
            applicationId: submitted.applicationId,
            principal: PRINCIPAL,
            startedAt: at(0),
        })
        await releaseCompensationPayoutV1({
            contract: RELEASE_COMPENSATION_PAYOUT_COMMAND_V1,
            payoutAuthorizationId: first.payoutAuthorizationId,
            authorizationFence: first.authorizationFence,
            kind: 'cancel_preparation',
            reason: 'manager did not pay',
            principal: PRINCIPAL,
            releasedAt: at(1),
        })
        const second = await startCompensationPayoutV1({
            contract: START_COMPENSATION_PAYOUT_COMMAND_V1,
            applicationId: submitted.applicationId,
            principal: PRINCIPAL,
            startedAt: at(1),
        })
        expect(second.status).toBe('opened')
        expect(second.payoutAuthorizationId).not.toBe(first.payoutAuthorizationId)
        // The superseded preparation no longer finalizes.
        await expectCode(
            finalizeCompensationPayoutV1({
                contract: FINALIZE_COMPENSATION_PAYOUT_COMMAND_V1,
                payoutAuthorizationId: first.payoutAuthorizationId,
                authorizationFence: first.authorizationFence,
                principal: PRINCIPAL,
                finalizedAt: at(2),
            }),
            'authorization_released',
        )
        const settled = await finalizeCompensationPayoutV1({
            contract: FINALIZE_COMPENSATION_PAYOUT_COMMAND_V1,
            payoutAuthorizationId: second.payoutAuthorizationId,
            authorizationFence: second.authorizationFence,
            principal: PRINCIPAL,
            finalizedAt: at(2),
        })
        expect(settled.status).toBe('settled')
    })

    it('resolves a reconciliation opened more than a day earlier', async () => {
        const submitted = await submitCompensationApplicationV1(submitCommand())
        const started = await startCompensationPayoutV1({
            contract: START_COMPENSATION_PAYOUT_COMMAND_V1,
            applicationId: submitted.applicationId,
            principal: PRINCIPAL,
            startedAt: at(0),
        })
        const released = await releaseCompensationPayoutV1({
            contract: RELEASE_COMPENSATION_PAYOUT_COMMAND_V1,
            payoutAuthorizationId: started.payoutAuthorizationId,
            authorizationFence: started.authorizationFence,
            kind: 'declare_outcome_unknown',
            reason: 'dispatcher did not confirm',
            principal: PRINCIPAL,
            releasedAt: at(1),
        })
        // Age the preparation past the unaided-recall cut-off. Reconciliation
        // carries evidence, so it is deliberately not subject to that gate.
        await database.$executeRawUnsafe(
            `UPDATE "CompensationPayoutAuthorization" SET "openedAt" = NOW() - INTERVAL '3 days' WHERE "id" = $1`,
            started.payoutAuthorizationId,
        )
        const resolved = await resolveCompensationReconciliationV1({
            contract: RESOLVE_COMPENSATION_RECONCILIATION_COMMAND_V1,
            reconciliationTaskId: released.reconciliationTaskId as string,
            resolution: 'paid',
            resolutionEvidence: 'dispatcher statement line 42',
            principal: PRINCIPAL,
            resolvedAt: at(2),
        })
        expect(resolved.status).toBe('settled')
        const period = await periodRow('2026-09')
        expect(period.reservedKopecks).toBe(0)
        expect(period.settledKopecks).toBe(submitted.amountKopecks)
    })

    it('keeps separate verified-order evidence for a second attempt at a different price', async () => {
        const person = evidence()
        const sharedOrder = order({ rawPrice: '100.0000' })
        const first = await submitCompensationApplicationV1(submitCommand({
            person, order: sharedOrder, claimedRubles: 900,
        }))
        expect(first.amountKopecks).toBe(10_000)
        await rejectCompensationApplicationV1({
            contract: REJECT_COMPENSATION_APPLICATION_COMMAND_V1,
            applicationId: first.applicationId,
            rejectionKey: uuid(),
            reason: 'wrong amount',
            principal: PRINCIPAL,
            rejectedAt: at(0),
        })
        const second = await submitCompensationApplicationV1(submitCommand({
            person, order: { ...sharedOrder, rawPrice: '500.0000' }, claimedRubles: 900,
        }))
        expect(second.amountKopecks).toBe(50_000)

        // Each application points at evidence that proves its own amount.
        const evidenceRows = await database.$queryRawUnsafe<Array<{ verifiedKopecks: number; appAmount: number }>>(
            `SELECT v."amountKopecks" AS "verifiedKopecks", a."amountKopecks" AS "appAmount"
             FROM "CompensationApplication" a
             JOIN "CompensationVerifiedOrder" v ON v."id" = a."verifiedOrderId"
             ORDER BY a."attemptNo"`,
        )
        expect(evidenceRows).toHaveLength(2)
        for (const row of evidenceRows) {
            expect(row.appAmount).toBeLessThanOrEqual(row.verifiedKopecks)
        }
    })

    it('forbids rejection while a payout authorization is unresolved', async () => {
        const submitted = await submitCompensationApplicationV1(submitCommand())
        const started = await startCompensationPayoutV1({
            contract: START_COMPENSATION_PAYOUT_COMMAND_V1,
            applicationId: submitted.applicationId,
            principal: PRINCIPAL,
            startedAt: at(0),
        })
        await expectCode(
            rejectCompensationApplicationV1({
                contract: REJECT_COMPENSATION_APPLICATION_COMMAND_V1,
                applicationId: submitted.applicationId,
                rejectionKey: uuid(),
                reason: 'no receipt',
                principal: PRINCIPAL,
                rejectedAt: at(1),
            }),
            'payout_authorization_active',
        )

        await releaseCompensationPayoutV1({
            contract: RELEASE_COMPENSATION_PAYOUT_COMMAND_V1,
            payoutAuthorizationId: started.payoutAuthorizationId,
            authorizationFence: started.authorizationFence,
            kind: 'cancel_preparation',
            reason: 'manager did not pay',
            principal: PRINCIPAL,
            releasedAt: at(1),
        })
        const rejected = await rejectCompensationApplicationV1({
            contract: REJECT_COMPENSATION_APPLICATION_COMMAND_V1,
            applicationId: submitted.applicationId,
            rejectionKey: uuid(),
            reason: 'no receipt',
            principal: PRINCIPAL,
            rejectedAt: at(2),
        })
        expect(rejected.status).toBe('rejected')
        expect((await periodRow('2026-09')).reservedKopecks).toBe(0)
    })

    it('holds every lock while the external outcome is unknown, then settles on reconciliation', async () => {
        const submitted = await submitCompensationApplicationV1(submitCommand())
        const started = await startCompensationPayoutV1({
            contract: START_COMPENSATION_PAYOUT_COMMAND_V1,
            applicationId: submitted.applicationId,
            principal: PRINCIPAL,
            startedAt: at(0),
        })
        const released = await releaseCompensationPayoutV1({
            contract: RELEASE_COMPENSATION_PAYOUT_COMMAND_V1,
            payoutAuthorizationId: started.payoutAuthorizationId,
            authorizationFence: started.authorizationFence,
            kind: 'declare_outcome_unknown',
            reason: 'dispatcher did not confirm',
            principal: PRINCIPAL,
            releasedAt: at(1),
        })
        expect(released.status).toBe('reconciliation_opened')
        expect(released.reconciliationTaskId).not.toBeNull()

        // The reservation stays reserved and rejection stays forbidden.
        expect((await periodRow('2026-09')).reservedKopecks).toBe(submitted.amountKopecks)
        await expectCode(
            rejectCompensationApplicationV1({
                contract: REJECT_COMPENSATION_APPLICATION_COMMAND_V1,
                applicationId: submitted.applicationId,
                rejectionKey: uuid(),
                reason: 'attempted while unresolved',
                principal: PRINCIPAL,
                rejectedAt: at(1),
            }),
            'payout_authorization_active',
        )

        const resolved = await resolveCompensationReconciliationV1({
            contract: RESOLVE_COMPENSATION_RECONCILIATION_COMMAND_V1,
            reconciliationTaskId: released.reconciliationTaskId as string,
            resolution: 'paid',
            resolutionEvidence: 'dispatcher statement line 42',
            principal: PRINCIPAL,
            resolvedAt: at(3),
        })
        expect(resolved.status).toBe('settled')
        const period = await periodRow('2026-09')
        expect(period.reservedKopecks).toBe(0)
        expect(period.settledKopecks).toBe(submitted.amountKopecks)
    })

    it('allows a second attempt only after rejection, on the original deadline', async () => {
        const person = evidence()
        const sharedOrder = order()
        const first = await submitCompensationApplicationV1(submitCommand({ person, order: sharedOrder }))
        await rejectCompensationApplicationV1({
            contract: REJECT_COMPENSATION_APPLICATION_COMMAND_V1,
            applicationId: first.applicationId,
            rejectionKey: uuid(),
            reason: 'photo unreadable',
            principal: PRINCIPAL,
            rejectedAt: at(0),
        })
        const second = await submitCompensationApplicationV1(submitCommand({ person, order: sharedOrder }))
        expect(second.attemptNo).toBe(2)

        await rejectCompensationApplicationV1({
            contract: REJECT_COMPENSATION_APPLICATION_COMMAND_V1,
            applicationId: second.applicationId,
            rejectionKey: uuid(),
            reason: 'still unreadable',
            principal: PRINCIPAL,
            rejectedAt: at(2),
        })
        await expectCode(
            submitCompensationApplicationV1(submitCommand({ person, order: sharedOrder })),
            'max_attempts_reached',
        )
    })

    it('treats one order id in two parks as two different orders', async () => {
        const sharedId = order().externalOrderId
        const parkA = await submitCompensationApplicationV1(submitCommand({
            order: order({ externalOrderId: sharedId, externalParkId: '3a23295d8d714c03b61a17a6fc86601b' }),
        }))
        const parkB = await submitCompensationApplicationV1(submitCommand({
            order: order({ externalOrderId: sharedId, externalParkId: '45e30e9d6b824c608e5d28719cb19a6e' }),
        }))
        expect(parkA.applicationId).not.toBe(parkB.applicationId)
        expect(await countRows(
            `SELECT COUNT(*)::bigint AS count FROM "CompensationOrderClaim" WHERE "externalOrderId" = $1`,
            sharedId,
        )).toBe(2)
    })

    it('refuses a submission the budget cannot cover and leaves the period untouched', async () => {
        await database.$executeRawUnsafe(
            `UPDATE "CompensationBudgetPeriod" SET "limitKopecks" = 10000 WHERE "periodKey" = '2026-09'`,
        )
        await expectCode(
            submitCompensationApplicationV1(submitCommand({ claimedRubles: 500 })),
            'budget_exhausted',
        )
        expect((await periodRow('2026-09')).reservedKopecks).toBe(0)
    })

    it('refuses a submission into a closed period', async () => {
        await database.$executeRawUnsafe(
            `UPDATE "CompensationBudgetPeriod" SET "state" = 'closed', "closedAt" = NOW() WHERE "periodKey" = '2026-09'`,
        )
        await expectCode(submitCompensationApplicationV1(submitCommand()), 'period_not_open')
    })

    it('still finalizes a timely PENDING after its period closed', async () => {
        const submitted = await submitCompensationApplicationV1(submitCommand())
        const started = await startCompensationPayoutV1({
            contract: START_COMPENSATION_PAYOUT_COMMAND_V1,
            applicationId: submitted.applicationId,
            principal: PRINCIPAL,
            startedAt: at(0),
        })
        await database.$executeRawUnsafe(
            `UPDATE "CompensationBudgetPeriod" SET "state" = 'closed', "closedAt" = NOW() WHERE "periodKey" = '2026-09'`,
        )
        const settled = await finalizeCompensationPayoutV1({
            contract: FINALIZE_COMPENSATION_PAYOUT_COMMAND_V1,
            payoutAuthorizationId: started.payoutAuthorizationId,
            authorizationFence: started.authorizationFence,
            principal: PRINCIPAL,
            finalizedAt: at(2),
        })
        expect(settled.status).toBe('settled')
    })

    it('lets the database refuse an overspent period', async () => {
        await expect(database.$executeRawUnsafe(
            `UPDATE "CompensationBudgetPeriod" SET "reservedKopecks" = "limitKopecks" + 1 WHERE "periodKey" = '2026-09'`,
        )).rejects.toThrowError(/CompensationBudgetPeriod_capacity_check/)
    })

    it('lets the database refuse a fourth application status', async () => {
        const submitted = await submitCompensationApplicationV1(submitCommand())
        await expect(database.$executeRawUnsafe(
            `UPDATE "CompensationApplication" SET "status" = 'PAYING' WHERE "id" = $1`,
            submitted.applicationId,
        )).rejects.toThrowError(/CompensationApplication_status_check/)
    })

    it('serialises concurrent starts so only one payout right is granted', async () => {
        const submitted = await submitCompensationApplicationV1(submitCommand())
        const start = () => startCompensationPayoutV1({
            contract: START_COMPENSATION_PAYOUT_COMMAND_V1,
            applicationId: submitted.applicationId,
            principal: PRINCIPAL,
            startedAt: at(0),
        })
        const results = await Promise.allSettled([start(), start(), start()])
        const granted = results.filter((entry) => entry.status === 'fulfilled')
        expect(granted.length).toBeGreaterThanOrEqual(1)
        const ids = new Set(granted.map((entry) =>
            (entry as PromiseFulfilledResult<{ payoutAuthorizationId: string }>).value.payoutAuthorizationId))
        expect(ids.size).toBe(1)
        expect(await countRows(
            `SELECT COUNT(*)::bigint AS count FROM "CompensationPayoutAuthorization"
             WHERE "state" IN ('active','unknown_outcome')`,
        )).toBe(1)
    })

    it('serialises concurrent submits so only one PENDING survives', async () => {
        const person = evidence()
        const results = await Promise.allSettled([
            submitCompensationApplicationV1(submitCommand({ person })),
            submitCompensationApplicationV1(submitCommand({ person })),
            submitCompensationApplicationV1(submitCommand({ person })),
        ])
        expect(await countRows(
            `SELECT COUNT(*)::bigint AS count FROM "CompensationApplication" WHERE "status" = 'PENDING'`,
        )).toBe(1)
        expect(results.filter((entry) => entry.status === 'fulfilled').length).toBeGreaterThanOrEqual(1)
    })

    it('writes an audit row inside the same transaction as every state change', async () => {
        const submitted = await submitCompensationApplicationV1(submitCommand())
        const started = await startCompensationPayoutV1({
            contract: START_COMPENSATION_PAYOUT_COMMAND_V1,
            applicationId: submitted.applicationId,
            principal: PRINCIPAL,
            startedAt: at(0),
        })
        await finalizeCompensationPayoutV1({
            contract: FINALIZE_COMPENSATION_PAYOUT_COMMAND_V1,
            payoutAuthorizationId: started.payoutAuthorizationId,
            authorizationFence: started.authorizationFence,
            principal: PRINCIPAL,
            finalizedAt: at(2),
        })
        const audit = await database.$queryRawUnsafe<Array<{ action: string; principalId: string; operatorLabel: string | null }>>(
            `SELECT "action","principalId","operatorLabel" FROM "CompensationAuditEvent" ORDER BY "occurredAt","id"`,
        )
        expect(audit.map((row) => row.action)).toEqual(['submit', 'payout_authorization_opened', 'payout_finalized'])
        expect(audit[2].principalId).toBe('u1')
        expect(audit[2].operatorLabel).toBe('Test Manager')
    })

    describe('one compensated cash order per person per ORDER business day', () => {
        it('refuses a second order of the same order day once the first is paid, whatever day the manager pays on', async () => {
            const person = evidence()
            const first = await submitCompensationApplicationV1(submitCommand({ person, order: order(ORDER_DAY_A) }))
            const started = await startPayout(first.applicationId)
            expect(started.intendedBusinessDay).toBe('2026-09-10')
            expect((await finalizePayout(started)).status).toBe('settled')

            // Submission never consumes the slot: the second claim is accepted
            // and reserved, and only the payout start is refused.
            const second = await submitCompensationApplicationV1(submitCommand({ person, order: order(ORDER_DAY_B) }))
            expect(second.status).toBe('created')
            await expectCode(startPayout(second.applicationId, at(2)), 'daily_limit_reached')
            await expectSlotRows([{ intendedBusinessDay: '2026-09-10', state: 'finalized' }])
            expect((await periodRow('2026-09')).reservedKopecks).toBe(second.amountKopecks)
        })

        it('pays two orders of different order days on one manager day', async () => {
            const person = evidence()
            const window = [await databaseDayKey()]
            const earlier = await submitCompensationApplicationV1(submitCommand({ person, order: order(PREVIOUS_ORDER_DAY) }))
            const earlierStarted = await startPayout(earlier.applicationId)
            expect(earlierStarted.intendedBusinessDay).toBe('2026-09-09')
            const earlierSettled = await finalizePayout(earlierStarted)
            const later = await submitCompensationApplicationV1(submitCommand({ person, order: order(ORDER_DAY_A) }))
            const laterStarted = await startPayout(later.applicationId, at(2))
            expect(laterStarted.intendedBusinessDay).toBe('2026-09-10')
            const laterSettled = await finalizePayout(laterStarted, at(3))
            window.push(await databaseDayKey())
            expect([earlierSettled.status, laterSettled.status]).toEqual(['settled', 'settled'])
            await expectSlotRows([
                { intendedBusinessDay: '2026-09-09', state: 'finalized' },
                { intendedBusinessDay: '2026-09-10', state: 'finalized' },
            ])
            // Both were paid today: the settlement day is the payout day, not the slot.
            expect(window).toContain(earlierSettled.businessDay)
            expect(window).toContain(laterSettled.businessDay)
        })

        it('releases the order-day slot when the preparation is cancelled', async () => {
            const person = evidence()
            const first = await submitCompensationApplicationV1(submitCommand({ person, order: order(ORDER_DAY_A) }))
            const started = await startPayout(first.applicationId)
            expect((await cancelPayout(started)).status).toBe('cancelled')
            // Rejection frees the person's single PENDING; it never touches the slot.
            await rejectApplication(first.applicationId, at(2))
            const second = await submitCompensationApplicationV1(submitCommand({ person, order: order(ORDER_DAY_B) }))
            const again = await startPayout(second.applicationId, at(3))
            expect(again.status).toBe('opened')
            expect(again.intendedBusinessDay).toBe('2026-09-10')
            await expectSlotRows([
                { intendedBusinessDay: '2026-09-10', state: 'cancelled' },
                { intendedBusinessDay: '2026-09-10', state: 'active' },
            ])
        })

        it('releases the order-day slot when reconciliation finds the money never left', async () => {
            const person = evidence()
            const first = await submitCompensationApplicationV1(submitCommand({ person, order: order(ORDER_DAY_A) }))
            const started = await startPayout(first.applicationId)
            const unknown = await declareOutcomeUnknown(started)
            const resolved = await reconcile(unknown.reconciliationTaskId as string, 'not_paid')
            expect(resolved.status).toBe('released')
            await rejectApplication(first.applicationId, at(3))
            const second = await submitCompensationApplicationV1(submitCommand({ person, order: order(ORDER_DAY_B) }))
            const again = await startPayout(second.applicationId, at(4))
            expect(again.status).toBe('opened')
            expect(again.intendedBusinessDay).toBe('2026-09-10')
            await expectSlotRows([
                { intendedBusinessDay: '2026-09-10', state: 'cancelled' },
                { intendedBusinessDay: '2026-09-10', state: 'active' },
            ])
        })

        it('keeps the order-day slot when reconciliation finds the money was paid', async () => {
            const person = evidence()
            const first = await submitCompensationApplicationV1(submitCommand({ person, order: order(ORDER_DAY_A) }))
            const started = await startPayout(first.applicationId)
            const unknown = await declareOutcomeUnknown(started)
            const window = [await databaseDayKey()]
            const resolved = await reconcile(unknown.reconciliationTaskId as string, 'paid')
            window.push(await databaseDayKey())
            expect(resolved.status).toBe('settled')
            // The reconciliation settlement records the payout day from the
            // database clock exactly like the manager's own confirmation.
            const settlement = await database.$queryRawUnsafe<Array<{ businessDay: string }>>(
                `SELECT "businessDay" FROM "CompensationSettlement" WHERE "id" = $1`,
                resolved.settlementId,
            )
            expect(window).toContain(settlement[0].businessDay)
            const second = await submitCompensationApplicationV1(submitCommand({ person, order: order(ORDER_DAY_B) }))
            await expectCode(startPayout(second.applicationId, at(3)), 'daily_limit_reached')
            await expectSlotRows([{ intendedBusinessDay: '2026-09-10', state: 'finalized' }])
        })

        it('consumes no slot when an application is rejected without a payout', async () => {
            const person = evidence()
            const first = await submitCompensationApplicationV1(submitCommand({ person, order: order(ORDER_DAY_A) }))
            await rejectApplication(first.applicationId)
            await expectSlotRows([])
            const second = await submitCompensationApplicationV1(submitCommand({ person, order: order(ORDER_DAY_B) }))
            const started = await startPayout(second.applicationId, at(1))
            expect(started.status).toBe('opened')
            expect(started.intendedBusinessDay).toBe('2026-09-10')
        })

        it('keeps the same order-day key for a second attempt after rejection', async () => {
            const person = evidence()
            const sharedOrder = order(ORDER_DAY_A)
            const first = await submitCompensationApplicationV1(submitCommand({ person, order: sharedOrder }))
            await rejectApplication(first.applicationId)
            const second = await submitCompensationApplicationV1(submitCommand({ person, order: sharedOrder }))
            expect(second.attemptNo).toBe(2)
            const started = await startPayout(second.applicationId, at(1))
            expect(started.intendedBusinessDay).toBe('2026-09-10')
            expect((await finalizePayout(started, at(2))).status).toBe('settled')
            // The paid second attempt holds the order day like any other payout.
            const other = await submitCompensationApplicationV1(submitCommand({ person, order: order(ORDER_DAY_B) }))
            await expectCode(startPayout(other.applicationId, at(3)), 'daily_limit_reached')
        })

        it('consumes no additional slot on an idempotent replay of start or finalize', async () => {
            const submitted = await submitCompensationApplicationV1(submitCommand({ order: order(ORDER_DAY_A) }))
            const started = await startPayout(submitted.applicationId)
            const replayedStart = await startPayout(submitted.applicationId)
            expect(replayedStart.status).toBe('replayed')
            expect(replayedStart.payoutAuthorizationId).toBe(started.payoutAuthorizationId)
            expect(replayedStart.intendedBusinessDay).toBe('2026-09-10')
            const settled = await finalizePayout(started)
            const replayedFinalize = await finalizePayout(started)
            expect(replayedFinalize.status).toBe('replayed')
            expect(replayedFinalize.businessDay).toBe(settled.businessDay)
            await expectSlotRows([{ intendedBusinessDay: '2026-09-10', state: 'finalized' }])
            expect(await countRows(`SELECT COUNT(*)::bigint AS count FROM "CompensationSettlement"`)).toBe(1)
        })

        it('holds the order-day slot while the external outcome is unknown', async () => {
            const person = evidence()
            const first = await submitCompensationApplicationV1(submitCommand({ person, order: order(ORDER_DAY_A) }))
            const started = await startPayout(first.applicationId)
            await declareOutcomeUnknown(started)
            // The holder cannot be prepared again until reconciliation decides.
            await expectCode(startPayout(first.applicationId, at(2)), 'reconciliation_required')
            // While it is unresolved the claim stays the person's single PENDING,
            // so no second claim can even be submitted, and rejection is barred.
            await expectCode(
                submitCompensationApplicationV1(submitCommand({ person, order: order(ORDER_DAY_B) })),
                'active_pending_exists',
            )
            await expectCode(rejectApplication(first.applicationId, at(2)), 'payout_authorization_active')
            // The slot itself is held at the index: a second holder of the same
            // order day is refused, another order day of the same person is not.
            await expect(insertFinalizedSlotRow('comp_auth_direct_same_day', first, '2026-09-10'))
                .rejects.toThrowError(PERSON_DAY_KEY_VIOLATION)
            await insertFinalizedSlotRow('comp_auth_direct_other_day', first, '2026-09-09')
            await expectSlotRows([
                { intendedBusinessDay: '2026-09-10', state: 'unknown_outcome' },
                { intendedBusinessDay: '2026-09-09', state: 'finalized' },
            ])
        })

        it('splits order days at Yekaterinburg midnight and pays both sides on one manager day', async () => {
            const person = evidence()
            const beforeMidnight = await submitCompensationApplicationV1(submitCommand({
                person,
                order: order({ endedAt: new Date('2026-09-10T18:59:00.000Z'), verifiedAt: new Date('2026-09-10T18:59:30.000Z') }),
            }))
            const first = await startPayout(beforeMidnight.applicationId)
            expect(first.intendedBusinessDay).toBe('2026-09-10')
            expect((await finalizePayout(first)).status).toBe('settled')
            const afterMidnight = await submitCompensationApplicationV1(submitCommand({
                person,
                order: order({ endedAt: new Date('2026-09-10T19:00:00.000Z'), verifiedAt: new Date('2026-09-10T19:00:30.000Z') }),
            }))
            const second = await startPayout(afterMidnight.applicationId, at(2))
            expect(second.intendedBusinessDay).toBe('2026-09-11')
            expect((await finalizePayout(second, at(3))).status).toBe('settled')
        })

        it('keeps the last-day order key for a 31 August order submitted on 2 September', async () => {
            const submitted = await submitCompensationApplicationV1(submitCommand({
                order: order({ endedAt: new Date('2026-08-31T13:00:00.000Z'), verifiedAt: new Date('2026-08-31T13:05:00.000Z') }),
                submittedAt: new Date('2026-09-02T09:00:00.000Z'),
            }))
            expect(submitted.budgetPeriodKey).toBe('2026-08')
            const started = await startPayout(submitted.applicationId)
            expect(started.intendedBusinessDay).toBe('2026-08-31')
            const window = [await databaseDayKey()]
            const settled = await finalizePayout(started)
            window.push(await databaseDayKey())
            expect(settled.status).toBe('settled')
            expect(window).toContain(settled.businessDay)
            expect(settled.businessDay).not.toBe('2026-08-31')
        })

        it('lets the database refuse a second slot holder for one person and order day', async () => {
            // The enforcement is the partial unique index itself, with exactly
            // these columns and exactly the three slot-holding states.
            expect(await countRows(
                `SELECT COUNT(*)::bigint AS count FROM pg_indexes
                 WHERE indexname = $1 AND indexdef LIKE 'CREATE UNIQUE INDEX%'
                   AND strpos(indexdef, $2) > 0 AND strpos(indexdef, 'WHERE') > 0
                   AND strpos(indexdef, $3) > 0 AND strpos(indexdef, $4) > 0 AND strpos(indexdef, $5) > 0`,
                'CompensationPayoutAuthorization_person_day_key',
                '("compensationPersonId", "intendedBusinessDay")',
                "'active'", "'unknown_outcome'", "'finalized'",
            )).toBe(1)

            const submitted = await submitCompensationApplicationV1(submitCommand({ order: order(ORDER_DAY_A) }))
            const started = await startPayout(submitted.applicationId)
            expect((await finalizePayout(started)).status).toBe('settled')
            await expect(insertFinalizedSlotRow('comp_auth_direct_same_day', submitted, '2026-09-10'))
                .rejects.toThrowError(PERSON_DAY_KEY_VIOLATION)
            // The same row on another order day is accepted: the day key is what refuses.
            await insertFinalizedSlotRow('comp_auth_direct_other_day', submitted, '2026-09-11')
            await expectSlotRows([
                { intendedBusinessDay: '2026-09-10', state: 'finalized' },
                { intendedBusinessDay: '2026-09-11', state: 'finalized' },
            ])
        })
    })
})
