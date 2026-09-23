/**
 * Prisma implementation of the budget-period provisioning port. Fixed SQL only.
 *
 * The month is opened inside one transaction: the row is locked if it exists,
 * inserted otherwise, and the decision is taken again against the row the
 * transaction holds. Two operators provisioning the same month therefore agree
 * — the unique period key admits exactly one row, one caller is told it created
 * the month and the other is told it was already configured.
 *
 * Only `limitKopecks` is ever written after creation. Reserved and settled are
 * the monetary core's counters and are never touched here.
 */

import { prisma } from '@/lib/prisma'

import {
    planCompensationBudgetPeriodV1,
    type CompensationBudgetPeriodRowV1,
} from './compensation-budget-period'
import type { CompensationBudgetPeriodPortV1 } from './compensation-budget-period-service'

const PERIOD_SELECT = `
    SELECT "id","periodKey","state","limitKopecks","reservedKopecks","settledKopecks"
    FROM "CompensationBudgetPeriod"
`

interface PeriodRow {
    id: string
    periodKey: string
    state: string
    limitKopecks: number
    reservedKopecks: number
    settledKopecks: number
}

function toRow(row: PeriodRow | undefined): CompensationBudgetPeriodRowV1 | null {
    if (row === undefined) return null
    return {
        id: String(row.id),
        periodKey: String(row.periodKey),
        state: String(row.state),
        limitKopecks: Number(row.limitKopecks),
        reservedKopecks: Number(row.reservedKopecks),
        settledKopecks: Number(row.settledKopecks),
    }
}

export const legacyPrismaCompensationBudgetPeriodStoreV1: CompensationBudgetPeriodPortV1 = {
    async findPeriod(periodKey) {
        const rows = await prisma.$queryRawUnsafe<PeriodRow[]>(
            `${PERIOD_SELECT} WHERE "periodKey" = $1`,
            periodKey,
        )
        return toRow(rows[0])
    },

    async provisionPeriod({ window, id, limitKopecks }) {
        return prisma.$transaction(async (tx) => {
            const locked = async (): Promise<CompensationBudgetPeriodRowV1 | null> => toRow(
                (await tx.$queryRawUnsafe<PeriodRow[]>(
                    `${PERIOD_SELECT} WHERE "periodKey" = $1 FOR UPDATE`,
                    window.periodKey,
                ))[0],
            )

            let existing = await locked()
            if (existing === null) {
                // The unique period key decides the race; the loser waits on the
                // winner's row lock here and then re-reads it below.
                const inserted = await tx.$executeRawUnsafe(
                    `INSERT INTO "CompensationBudgetPeriod"
                        ("id","periodKey","periodStartsAt","periodEndsAt","submissionClosesAt",
                         "limitKopecks","reservedKopecks","settledKopecks","state","openedAt",
                         "createdAt","updatedAt")
                     VALUES ($1,$2,$3,$4,$5,$6,0,0,'open',NOW(),NOW(),NOW())
                     ON CONFLICT ("periodKey") DO NOTHING`,
                    id, window.periodKey, window.periodStartsAt, window.periodEndsAt,
                    window.submissionClosesAt, limitKopecks,
                )
                const stored = await locked()
                if (stored === null) throw new Error('compensation budget period vanished after insert')
                if (inserted === 1) return { ok: true as const, outcome: 'created' as const, row: stored }
                existing = stored
            }

            const plan = planCompensationBudgetPeriodV1(
                { periodKey: window.periodKey, limitKopecks },
                existing,
            )
            if ('refusal' in plan) return { ok: false as const, refusal: plan.refusal, row: existing }
            if (plan.action === 'none') {
                return { ok: true as const, outcome: 'already_configured' as const, row: existing }
            }

            // Monotonic by construction: the guard refuses to lower a limit even
            // if the row moved between the decision and this statement.
            await tx.$executeRawUnsafe(
                `UPDATE "CompensationBudgetPeriod"
                 SET "limitKopecks" = $2, "updatedAt" = NOW()
                 WHERE "id" = $1 AND "state" = 'open' AND "limitKopecks" < $2`,
                existing.id, limitKopecks,
            )
            const raised = await locked()
            if (raised === null) throw new Error('compensation budget period vanished after update')
            return { ok: true as const, outcome: 'limit_increased' as const, row: raised }
        })
    },
}
