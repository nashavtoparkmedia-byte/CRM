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
import { compensationBudgetPeriodIdV1, compensationBudgetPeriodWindowV1 } from './compensation-budget-period'
import { ensureCompensationBudgetPeriodV1, provisionCompensationBudgetPeriodsV1 } from './compensation-budget-period-service'
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

    describe('scheduled create-only provisioning', () => {
        const LATE_OCTOBER = new Date('2026-10-31T10:30:00Z')
        const run = (now: Date, limitKopecks: number | null) => provisionCompensationBudgetPeriodsV1({ now, limitKopecks }, store)

        async function fullRows() {
            return database.$queryRawUnsafe<Array<Record<string, unknown>>>(
                `SELECT * FROM "CompensationBudgetPeriod" ORDER BY "periodKey"`,
            )
        }

        it('opens the current and the next month at the configured limit with the derived windows', async () => {
            const result = await run(LATE_OCTOBER, LIMIT)
            expect(result.months.map((month) => [month.periodKey, month.status])).toEqual([['2026-10', 'created'], ['2026-11', 'created']])

            const rows = await periodRows()
            expect(rows.map((row) => [row.periodKey, row.limitKopecks, row.reservedKopecks, row.settledKopecks, row.state]))
                .toEqual([['2026-10', LIMIT, 0, 0, 'open'], ['2026-11', LIMIT, 0, 0, 'open']])
            const november = compensationBudgetPeriodWindowV1('2026-11')!
            expect(rows[1].periodStartsAt).toEqual(november.periodStartsAt)
            expect(rows[1].periodEndsAt).toEqual(november.periodEndsAt)
            expect(rows[1].submissionClosesAt).toEqual(november.submissionClosesAt)
        })

        it('never raises a stored month and leaves it byte for byte, updatedAt included', async () => {
            await ensure('2026-11', 300_000)
            const before = await fullRows()
            const result = await run(LATE_OCTOBER, 900_000)

            expect(result.months[1]).toMatchObject({ periodKey: '2026-11', status: 'present', limitKopecks: 300_000, limitDiffersFromConfiguration: true })
            expect((await fullRows()).find((row) => row.periodKey === '2026-11')).toEqual(before[0])
        })

        it('re-decides create-only under the row lock, so the race path cannot raise a limit either', async () => {
            await ensure('2026-11', 300_000)
            const window = compensationBudgetPeriodWindowV1('2026-11')!
            const answer = await store.provisionPeriod({ window, id: compensationBudgetPeriodIdV1('2026-11'), limitKopecks: 900_000, createOnly: true })

            expect(answer).toMatchObject({ ok: true, outcome: 'already_configured' })
            expect((await periodRows())[0].limitKopecks).toBe(300_000)
        })

        it('leaves October, its counters and its grace untouched while November and December open', async () => {
            await ensure('2026-10', LIMIT)
            await database.$executeRawUnsafe(
                `UPDATE "CompensationBudgetPeriod" SET "reservedKopecks" = 40000, "settledKopecks" = 10000 WHERE "periodKey" = '2026-10'`,
            )
            const october = (await fullRows())[0]
            const insideGrace = new Date('2026-11-02T10:00:00Z')
            expect(insideGrace.getTime()).toBeLessThan((october.submissionClosesAt as Date).getTime())

            const result = await run(insideGrace, LIMIT)
            expect(result.months.map((month) => [month.periodKey, month.status])).toEqual([['2026-11', 'created'], ['2026-12', 'created']])
            expect((await fullRows())[0]).toEqual(october)
        })

        it('leaves a closed month closed', async () => {
            await ensure('2026-11', LIMIT)
            await database.$executeRawUnsafe(`UPDATE "CompensationBudgetPeriod" SET "state" = 'closed' WHERE "periodKey" = '2026-11'`)
            const before = await fullRows()

            const result = await run(LATE_OCTOBER, LIMIT)
            expect(result.months[1]).toMatchObject({ periodKey: '2026-11', status: 'present', state: 'closed' })
            expect((await fullRows()).find((row) => row.periodKey === '2026-11')).toEqual(before[0])
        })

        it('gives concurrent runs one row per month and exactly one creator each', async () => {
            const results = await Promise.all([run(LATE_OCTOBER, LIMIT), run(LATE_OCTOBER, LIMIT), run(LATE_OCTOBER, LIMIT)])

            expect(results.every((result) => result.ok)).toBe(true)
            for (const periodKey of ['2026-10', '2026-11']) {
                const creators = results.filter((result) => result.months.find((month) => month.periodKey === periodKey)?.status === 'created')
                expect(creators).toHaveLength(1)
            }
            expect((await periodRows()).map((row) => row.periodKey)).toEqual(['2026-10', '2026-11'])
        })

        it('writes nothing without a configured limit and reports the missing months', async () => {
            const result = await run(LATE_OCTOBER, null)

            expect(result).toMatchObject({ ok: false, configuredLimitKopecks: null })
            expect(result.months.map((month) => month.status)).toEqual(['missing_unconfigured', 'missing_unconfigured'])
            expect(await periodRows()).toHaveLength(0)
        })

        it('is idempotent: a repeated run changes no row', async () => {
            await run(LATE_OCTOBER, LIMIT)
            const before = await fullRows()
            const again = await run(LATE_OCTOBER, LIMIT)

            expect(again.months.map((month) => month.status)).toEqual(['present', 'present'])
            expect(await fullRows()).toEqual(before)
        })
    })
})
