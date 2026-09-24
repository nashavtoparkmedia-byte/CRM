/**
 * Budget-period provisioning on real PostgreSQL.
 *
 * The month is a row in the monetary ledger, so every claim here is made
 * against the database: what provisioning writes, what it refuses, what two
 * simultaneous operators get, and that the counters C1 owns are never touched.
 *
 * Gated behind YOKO_COMPENSATION_MONETARY_POSTGRES_PROOF=1 and an isolated
 * DATABASE_URL.
 */

import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
    compensationCalendarMonthV1,
    compensationMonthEndInstantV1,
    compensationMonthStartInstantV1,
    compensationPeriodKeyV1,
} from './compensation-calendar'
import { compensationBudgetPeriodIdV1 } from './compensation-budget-period'
import { ensureCompensationBudgetPeriodV1 } from './compensation-budget-period-service'
import { compensationPeriodSubmissionClosesAtV1 } from './compensation-submission-window'
import { legacyPrismaCompensationBudgetPeriodStoreV1 as store } from './legacy-prisma-compensation-budget-period-adapter'

const proof = process.env.YOKO_COMPENSATION_MONETARY_POSTGRES_PROOF === '1' ? describe : describe.skip

const PERIOD = '2026-11'
const LIMIT = 500_000

let database: PrismaClient

const ensure = (periodKey: unknown, limitKopecks: unknown, dryRun = false) =>
    ensureCompensationBudgetPeriodV1({ periodKey, limitKopecks, dryRun }, store)

async function periodRows() {
    return database.$queryRawUnsafe<Array<{
        id: string; periodKey: string; state: string; limitKopecks: number
        reservedKopecks: number; settledKopecks: number
        periodStartsAt: Date; periodEndsAt: Date; submissionClosesAt: Date; openedAt: Date
    }>>(
        `SELECT "id","periodKey","state","limitKopecks","reservedKopecks","settledKopecks",
                "periodStartsAt","periodEndsAt","submissionClosesAt","openedAt"
         FROM "CompensationBudgetPeriod" ORDER BY "periodKey"`,
    )
}

proof('compensation budget-period provisioning on real PostgreSQL', () => {
    beforeAll(async () => {
        database = new PrismaClient()
        await database.$connect()
    })
    afterAll(async () => {
        await database.$executeRawUnsafe('TRUNCATE TABLE "CompensationBudgetPeriod" CASCADE')
        await database.$disconnect()
    })
    beforeEach(async () => {
        await database.$executeRawUnsafe('TRUNCATE TABLE "CompensationBudgetPeriod" CASCADE')
    })

    it('opens a month that does not exist, with the derived window', async () => {
        const result = await ensure(PERIOD, LIMIT)
        expect(result).toMatchObject({ ok: true, dryRun: false, outcome: 'created', refusal: null })

        const rows = await periodRows()
        expect(rows).toHaveLength(1)
        const month = compensationCalendarMonthV1(rows[0].periodStartsAt)
        expect(compensationPeriodKeyV1(month)).toBe(PERIOD)
        expect(rows[0]).toMatchObject({
            id: compensationBudgetPeriodIdV1(PERIOD),
            periodKey: PERIOD,
            state: 'open',
            limitKopecks: LIMIT,
            reservedKopecks: 0,
            settledKopecks: 0,
        })
        // The window and the deadline are the monetary core's own, not the caller's.
        expect(rows[0].periodStartsAt).toEqual(compensationMonthStartInstantV1(month))
        expect(rows[0].periodEndsAt).toEqual(compensationMonthEndInstantV1(month))
        expect(rows[0].submissionClosesAt).toEqual(compensationPeriodSubmissionClosesAtV1(month))
        expect(result.period).toMatchObject({ remainingKopecks: LIMIT, state: 'open' })
    })

    it('replays an identical request without writing a second month', async () => {
        await ensure(PERIOD, LIMIT)
        const first = await periodRows()

        const replay = await ensure(PERIOD, LIMIT)
        expect(replay).toMatchObject({ ok: true, outcome: 'already_configured' })

        const second = await periodRows()
        expect(second).toHaveLength(1)
        expect(second[0]).toEqual(first[0])
    })

    it('gives two simultaneous operators one month and one authoritative answer', async () => {
        const [left, right] = await Promise.all([ensure(PERIOD, LIMIT), ensure(PERIOD, LIMIT)])

        expect([left.ok, right.ok]).toEqual([true, true])
        const outcomes = [left.outcome, right.outcome].sort()
        expect(outcomes).toEqual(['already_configured', 'created'])
        const rows = await periodRows()
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({ limitKopecks: LIMIT, state: 'open' })
    })

    it('raises a limit and leaves everything else alone', async () => {
        await ensure(PERIOD, LIMIT)
        const before = (await periodRows())[0]

        const raised = await ensure(PERIOD, 900_000)
        expect(raised).toMatchObject({ ok: true, outcome: 'limit_increased' })
        expect(raised.period).toMatchObject({ limitKopecks: 900_000, remainingKopecks: 900_000 })

        const after = (await periodRows())[0]
        expect(after).toMatchObject({
            id: before.id,
            periodKey: before.periodKey,
            state: 'open',
            limitKopecks: 900_000,
            reservedKopecks: before.reservedKopecks,
            settledKopecks: before.settledKopecks,
        })
        expect(after.periodStartsAt).toEqual(before.periodStartsAt)
        expect(after.submissionClosesAt).toEqual(before.submissionClosesAt)
        expect(after.openedAt).toEqual(before.openedAt)
    })

    it('refuses to lower a limit', async () => {
        await ensure(PERIOD, LIMIT)
        expect(await ensure(PERIOD, 100_000)).toMatchObject({ ok: false, refusal: 'limit_below_configured' })
        expect((await periodRows())[0]).toMatchObject({ limitKopecks: LIMIT })
    })

    it('refuses to reopen a closed month', async () => {
        await ensure(PERIOD, LIMIT)
        await database.$executeRawUnsafe(
            `UPDATE "CompensationBudgetPeriod" SET "state" = 'closed', "closedAt" = NOW() WHERE "periodKey" = $1`,
            PERIOD,
        )

        expect(await ensure(PERIOD, 900_000)).toMatchObject({ ok: false, refusal: 'period_not_open' })
        expect(await ensure(PERIOD, LIMIT)).toMatchObject({ ok: false, refusal: 'period_not_open' })
        expect((await periodRows())[0]).toMatchObject({ state: 'closed', limitKopecks: LIMIT })
    })

    it('refuses an unusable period or limit and writes nothing', async () => {
        for (const bad of ['2026-13', '2026-9', 'november', '']) {
            expect(await ensure(bad, LIMIT)).toMatchObject({ ok: false, refusal: 'invalid_period_key' })
        }
        for (const bad of [0, -1, 1.5, '500000']) {
            expect(await ensure(PERIOD, bad)).toMatchObject({ ok: false, refusal: 'invalid_limit' })
        }
        expect(await periodRows()).toEqual([])
    })

    it('never touches the counters the monetary core owns', async () => {
        await ensure(PERIOD, LIMIT)
        // Money already reserved and settled against the month, as C1 would.
        await database.$executeRawUnsafe(
            `UPDATE "CompensationBudgetPeriod"
             SET "reservedKopecks" = 30000, "settledKopecks" = 20000 WHERE "periodKey" = $1`,
            PERIOD,
        )

        expect(await ensure(PERIOD, LIMIT)).toMatchObject({ ok: true, outcome: 'already_configured' })
        expect(await ensure(PERIOD, 900_000)).toMatchObject({ ok: true, outcome: 'limit_increased' })
        expect(await ensure(PERIOD, 100_000)).toMatchObject({ ok: false, refusal: 'limit_below_configured' })

        const after = (await periodRows())[0]
        expect(after).toMatchObject({ reservedKopecks: 30_000, settledKopecks: 20_000, limitKopecks: 900_000 })
        // Remaining stays the core's arithmetic over those untouched counters.
        expect((await ensure(PERIOD, 900_000)).period).toMatchObject({ remainingKopecks: 850_000 })
    })

    it('plans a dry run without writing a month', async () => {
        const planned = await ensure(PERIOD, LIMIT, true)
        expect(planned).toMatchObject({ ok: true, dryRun: true, outcome: 'created', period: null })
        expect(await periodRows()).toEqual([])

        await ensure(PERIOD, LIMIT)
        const stored = (await periodRows())[0]
        const raise = await ensure(PERIOD, 900_000, true)
        expect(raise).toMatchObject({ ok: true, dryRun: true, outcome: 'limit_increased' })
        expect((await periodRows())[0]).toEqual(stored)
    })

    it('keeps one row per month while several months are provisioned', async () => {
        for (const key of ['2026-10', PERIOD, '2026-12']) await ensure(key, LIMIT)
        await ensure(PERIOD, LIMIT)

        const rows = await periodRows()
        expect(rows.map((row) => row.periodKey)).toEqual(['2026-10', '2026-11', '2026-12'])
        expect(new Set(rows.map((row) => row.id)).size).toBe(3)
    })
})
