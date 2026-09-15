/**
 * Proof that monetary manager actions are attributed to the real signed-in
 * user, on real PostgreSQL.
 *
 * A shared principal would make the money trail unusable: every approval in
 * the park would look like the same person. What has to hold is that two
 * different managers leave two different actors in C1's audit, and that a
 * session which cannot be proven changes no monetary state at all.
 *
 * Gated behind YOKO_COMPENSATION_MONETARY_POSTGRES_PROOF=1 and an isolated
 * DATABASE_URL.
 */

import { createHash, randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
    START_COMPENSATION_PAYOUT_COMMAND_V1,
    SUBMIT_COMPENSATION_APPLICATION_COMMAND_V1,
} from '../../../../contracts/fleet-operations/v1'
import {
    compensationCalendarMonthV1,
    compensationMonthEndInstantV1,
    compensationMonthStartInstantV1,
} from './compensation-calendar'
import { resolveManagerPrincipalV1 } from './compensation-manager-principal'
import {
    startCompensationPayoutV1,
    submitCompensationApplicationV1,
} from './compensation-prisma-adapter'
import { compensationPeriodSubmissionClosesAtV1 } from './compensation-submission-window'

const proof = process.env.YOKO_COMPENSATION_MONETARY_POSTGRES_PROOF === '1' ? describe : describe.skip

const PARK = 'park-attrib-1'
const NOW = new Date()
const CURRENT_MONTH = compensationCalendarMonthV1(NOW)
const MONTH_START = compensationMonthStartInstantV1(CURRENT_MONTH)
const ORDER_ENDED_AT = new Date(Math.max(MONTH_START.getTime() + 3_600_000, NOW.getTime() - 3_600_000))
const PERIOD_KEY = `${CURRENT_MONTH.year}-${String(CURRENT_MONTH.month).padStart(2, '0')}`

const ANNA = { id: 'u1', firstName: 'Анна', lastName: 'Петрова', role: 'Менеджер', status: 'Активен' }
const IVAN = { id: 'u2', firstName: 'Иван', lastName: 'Смирнов', role: 'Руководитель', status: 'Активен' }
const DISABLED = { id: 'u3', firstName: 'Пётр', lastName: 'Кузнецов', role: 'Менеджер', status: 'Отключен' }

let database: PrismaClient

function provenPerson(contactId: string) {
    return {
        canonicalContactId: contactId,
        resolutionStatus: 'live' as const,
        lineage: [contactId],
        lineageDigest: createHash('sha256').update(contactId).digest('hex'),
        evidenceAt: NOW,
    }
}

async function submitOne(contactId: string, externalOrderId: string) {
    return submitCompensationApplicationV1({
        contract: SUBMIT_COMPENSATION_APPLICATION_COMMAND_V1,
        idempotencyKey: randomUUID(),
        person: provenPerson(contactId),
        order: {
            provider: 'yandex_fleet',
            externalParkId: PARK,
            externalOrderId,
            shortOrderIdDisplay: null,
            rawPrice: '335.0000',
            endedAt: ORDER_ENDED_AT,
            verifiedAt: new Date(NOW.getTime() - 7_200_000),
        },
        claimedRubles: 300,
        submittedAt: NOW,
    })
}

/** Approve exactly as the server action does: resolve, then act or refuse. */
async function approveAs(
    user: typeof ANNA | null,
    applicationId: string,
): Promise<{ acted: boolean; refusal?: string }> {
    const acting = resolveManagerPrincipalV1(user)
    if (!acting.resolved) return { acted: false, refusal: acting.refusal }
    await startCompensationPayoutV1({
        contract: START_COMPENSATION_PAYOUT_COMMAND_V1,
        applicationId,
        principal: {
            principalId: acting.principal.principalId,
            principalKind: 'crm_user',
            operatorLabel: acting.principal.operatorLabel,
        },
        startedAt: new Date(),
    })
    return { acted: true }
}

async function auditActors(applicationId: string) {
    return database.$queryRawUnsafe<Array<{ action: string; principalId: string; operatorLabel: string | null }>>(
        `SELECT ae."action", ae."principalId", ae."operatorLabel"
         FROM "CompensationAuditEvent" ae
         WHERE ae."subjectId" = $1 OR ae."payoutAuthorizationId" IN (
            SELECT pa."id" FROM "CompensationPayoutAuthorization" pa WHERE pa."applicationId" = $1
         )
         ORDER BY ae."occurredAt"`,
        applicationId,
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
        MONTH_START,
        compensationMonthEndInstantV1(CURRENT_MONTH),
        compensationPeriodSubmissionClosesAtV1(CURRENT_MONTH),
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

proof('manager attribution on real PostgreSQL', () => {
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

    it('records two different managers as two different audit actors', async () => {
        const first = await submitOne('contact-a', 'a'.repeat(32))
        const second = await submitOne('contact-b', 'b'.repeat(32))

        expect(await approveAs(ANNA, first.applicationId)).toEqual({ acted: true })
        expect(await approveAs(IVAN, second.applicationId)).toEqual({ acted: true })

        const firstActors = await auditActors(first.applicationId)
        const secondActors = await auditActors(second.applicationId)

        const annaPrincipals = new Set(firstActors.map((row) => row.principalId))
        const ivanPrincipals = new Set(secondActors.map((row) => row.principalId))

        expect(annaPrincipals.has('crm_user:u1')).toBe(true)
        expect(ivanPrincipals.has('crm_user:u2')).toBe(true)
        // The decisive property: the two trails cannot be confused.
        expect([...annaPrincipals]).not.toContain('crm_user:u2')
        expect([...ivanPrincipals]).not.toContain('crm_user:u1')
    })

    it('keeps the acting manager on the authorization itself', async () => {
        const application = await submitOne('contact-c', 'c'.repeat(32))
        await approveAs(IVAN, application.applicationId)

        const rows = await database.$queryRawUnsafe<Array<{ openedByPrincipal: string; openedByLabel: string | null }>>(
            `SELECT "openedByPrincipal","openedByLabel" FROM "CompensationPayoutAuthorization"
             WHERE "applicationId" = $1`,
            application.applicationId,
        )
        expect(rows[0].openedByPrincipal).toBe('crm_user:u2')
        expect(rows[0].openedByLabel).toBe('Иван Смирнов')
    })

    it('changes no monetary state for an anonymous session', async () => {
        const application = await submitOne('contact-d', 'd'.repeat(32))
        const before = await database.$queryRawUnsafe<Array<{ count: bigint }>>(
            'SELECT count(*) AS count FROM "CompensationPayoutAuthorization"')

        expect(await approveAs(null, application.applicationId))
            .toEqual({ acted: false, refusal: 'not_authenticated' })

        const after = await database.$queryRawUnsafe<Array<{ count: bigint }>>(
            'SELECT count(*) AS count FROM "CompensationPayoutAuthorization"')
        expect(Number(after[0].count)).toBe(Number(before[0].count))
        expect(Number(after[0].count)).toBe(0)
    })

    it('changes no monetary state for a disabled account', async () => {
        const application = await submitOne('contact-e', 'e'.repeat(32))

        expect(await approveAs(DISABLED, application.applicationId))
            .toEqual({ acted: false, refusal: 'user_disabled' })

        const authorizations = await database.$queryRawUnsafe<Array<{ count: bigint }>>(
            'SELECT count(*) AS count FROM "CompensationPayoutAuthorization"')
        expect(Number(authorizations[0].count)).toBe(0)
        // The reservation from the submit is untouched; nothing was released
        // or spent by a refused action.
        const period = await database.$queryRawUnsafe<Array<{ reservedKopecks: number }>>(
            `SELECT "reservedKopecks" FROM "CompensationBudgetPeriod" WHERE "periodKey" = $1`, PERIOD_KEY)
        expect(period[0].reservedKopecks).toBe(30_000)
    })

    it('writes no audit row at all when the principal is refused', async () => {
        const application = await submitOne('contact-f', 'f'.repeat(32))
        const before = await auditActors(application.applicationId)

        await approveAs(null, application.applicationId)
        await approveAs(DISABLED, application.applicationId)

        const after = await auditActors(application.applicationId)
        expect(after.length).toBe(before.length)
        expect(after.every((row) => !/^(manager|admin|system|crm_manager)$/.test(row.principalId))).toBe(true)
    })

    it('never attributes a monetary action to a shared principal', async () => {
        const application = await submitOne('contact-g', 'g'.repeat(32))
        await approveAs(ANNA, application.applicationId)

        const rows = await auditActors(application.applicationId)
        expect(rows.length).toBeGreaterThan(0)
        for (const row of rows) {
            expect(row.principalId).not.toBe('manager')
            expect(row.principalId).not.toBe('admin')
            expect(row.principalId).not.toBe('crm_manager')
        }
    })
})
