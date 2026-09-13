/**
 * Prisma implementation of the pilot port.
 *
 * Every monetary write goes through a C1 entry point. Nothing here computes an
 * amount, a deadline or a business day; the reads exist to render screens and
 * the writes exist to call C1.
 */

import { randomUUID } from 'node:crypto'

import { prisma } from '@/lib/prisma'

import {
    FINALIZE_COMPENSATION_PAYOUT_COMMAND_V1,
    REJECT_COMPENSATION_APPLICATION_COMMAND_V1,
    RESOLVE_COMPENSATION_RECONCILIATION_COMMAND_V1,
    START_COMPENSATION_PAYOUT_COMMAND_V1,
    SUBMIT_COMPENSATION_APPLICATION_COMMAND_V1,
} from '../../../../contracts/fleet-operations/v1'
import { compensationLineageDigestForContactV1 } from '../../internal/compensation/compensation-pilot-lineage'
import {
    finalizeCompensationPayoutV1,
    rejectCompensationApplicationV1,
    resolveCompensationReconciliationV1,
    startCompensationPayoutV1,
    submitCompensationApplicationV1,
} from '../../internal/compensation/compensation-prisma-adapter'
import { pilotDriverStatusV1 } from '../../internal/compensation/compensation-pilot-flow'
import type {
    CompensationPilotPortV1,
    ManagerApplicationRowV1,
    PilotApplicationSummaryV1,
} from './compensation-pilot-service'

function principal(principalId: string, operatorLabel: string | null) {
    return { principalId, principalKind: 'crm_user' as const, operatorLabel }
}

/** Shared row shape for both the driver and manager lists. */
const APPLICATION_SELECT = `
    app."id" AS "applicationId", app."status", app."claimedKopecks", app."amountKopecks",
    app."submittedAt", app."rejectionReason",
    vo."externalOrderId", vo."shortOrderIdDisplay", vo."externalParkId",
    vo."amountKopecks" AS "verifiedKopecks",
    pb."contactId" AS "canonicalContactId",
    ps."telegramUserId", ps."attachmentFileId", ps."attachmentKind", ps."supportContactedAt",
    live."id" AS "payoutAuthorizationId", live."authorizationFence",
    (live."id" IS NOT NULL) AS "hasLiveAuthorization",
    (recon."id" IS NOT NULL) AS "hasOpenReconciliation"
`

const APPLICATION_FROM = `
    FROM "CompensationApplication" app
    JOIN "CompensationVerifiedOrder" vo ON vo."id" = app."verifiedOrderId"
    JOIN "CompensationPersonBinding" pb ON pb."compensationPersonId" = app."compensationPersonId"
    LEFT JOIN "CompensationPilotSubmission" ps ON ps."applicationId" = app."id"
    LEFT JOIN LATERAL (
        SELECT pa."id", pa."authorizationFence" FROM "CompensationPayoutAuthorization" pa
        WHERE pa."applicationId" = app."id" AND pa."state" IN ('active','unknown_outcome')
        ORDER BY pa."openedAt" DESC LIMIT 1
    ) live ON true
    LEFT JOIN LATERAL (
        SELECT rt."id" FROM "CompensationReconciliationTask" rt
        JOIN "CompensationPayoutAuthorization" pa2 ON pa2."id" = rt."payoutAuthorizationId"
        WHERE pa2."applicationId" = app."id" AND rt."state" = 'open'
        LIMIT 1
    ) recon ON true
`

function toSummary(row: Record<string, unknown>): PilotApplicationSummaryV1 {
    return {
        applicationId: String(row.applicationId),
        status: pilotDriverStatusV1({
            status: String(row.status),
            hasLiveAuthorization: row.hasLiveAuthorization === true,
        }),
        externalOrderId: String(row.externalOrderId),
        shortOrderIdDisplay: row.shortOrderIdDisplay === null ? null : String(row.shortOrderIdDisplay),
        claimedKopecks: Number(row.claimedKopecks),
        amountKopecks: Number(row.amountKopecks),
        verifiedKopecks: Number(row.verifiedKopecks),
        submittedAt: new Date(row.submittedAt as string),
        rejectionReason: row.rejectionReason === null ? null : String(row.rejectionReason),
    }
}

function toManagerRow(row: Record<string, unknown>): ManagerApplicationRowV1 {
    return {
        ...toSummary(row),
        canonicalContactId: String(row.canonicalContactId),
        externalParkId: String(row.externalParkId),
        telegramUserId: row.telegramUserId === null ? null : String(row.telegramUserId),
        attachmentFileId: row.attachmentFileId === null ? null : String(row.attachmentFileId),
        attachmentKind: row.attachmentKind === null ? null : String(row.attachmentKind),
        supportContactedAt: row.supportContactedAt === null ? null : new Date(row.supportContactedAt as string),
        hasLiveAuthorization: row.hasLiveAuthorization === true,
        hasOpenReconciliation: row.hasOpenReconciliation === true,
        payoutAuthorizationId: row.payoutAuthorizationId === null ? null : String(row.payoutAuthorizationId),
        authorizationFence: row.authorizationFence === null ? null : String(row.authorizationFence),
    }
}

export const legacyPrismaCompensationPilotPortV1: CompensationPilotPortV1 = {
    async findDriverIdentity(telegramUserId) {
        const link = await prisma.driverTelegram.findFirst({
            where: { telegramId: BigInt(telegramUserId) },
            select: { driverId: true },
        })
        if (!link) return null
        const driver = await prisma.driver.findUnique({
            where: { id: link.driverId },
            select: {
                contactId: true,
                externalParkId: true,
                externalDriverProfileId: true,
                yandexDriverId: true,
                isSelfEmployed: true,
                employmentType: true,
                yandexHireDate: true,
            },
        })
        if (!driver) return null
        return {
            telegramUserId,
            canonicalContactId: driver.contactId,
            externalParkId: driver.externalParkId,
            // Falls back to the Yandex id, which is the profile id the orders
            // carry when the profile column was never backfilled.
            externalDriverProfileId: driver.externalDriverProfileId ?? driver.yandexDriverId,
            facts: {
                isSelfEmployed: driver.isSelfEmployed,
                employmentType: driver.employmentType,
                parkHireDate: driver.yandexHireDate,
            },
        }
    },

    async findCashOrders({ externalParkId, externalDriverProfileId }) {
        const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
            `SELECT "id","provider","externalParkId","externalOrderId","shortOrderIdDisplay",
                    "externalDriverProfileId","rawPrice","amountKopecks","endedAt"
             FROM "CompensationCashOrder"
             WHERE "externalParkId" = $1 AND "externalDriverProfileId" = $2
             ORDER BY "endedAt" DESC`,
            externalParkId, externalDriverProfileId,
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
    },

    async findBudgetPeriod(periodKey) {
        const rows = await prisma.$queryRawUnsafe<Array<{
            limitKopecks: number; reservedKopecks: number; settledKopecks: number
        }>>(
            `SELECT "limitKopecks","reservedKopecks","settledKopecks"
             FROM "CompensationBudgetPeriod" WHERE "periodKey" = $1`,
            periodKey,
        )
        return rows[0] ?? null
    },

    async findClaimedOrderIds(canonicalContactId) {
        // A rejected application frees the order for a second attempt, which is
        // C1's rule; only live and paid claims block it.
        const rows = await prisma.$queryRawUnsafe<Array<{ externalOrderId: string }>>(
            `SELECT DISTINCT vo."externalOrderId"
             FROM "CompensationApplication" app
             JOIN "CompensationVerifiedOrder" vo ON vo."id" = app."verifiedOrderId"
             JOIN "CompensationPersonBinding" pb ON pb."compensationPersonId" = app."compensationPersonId"
             WHERE pb."contactId" = $1 AND app."status" IN ('PENDING','PAID')`,
            canonicalContactId,
        )
        return rows.map((row) => row.externalOrderId)
    },

    async findDriverApplications(canonicalContactId) {
        const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
            `SELECT ${APPLICATION_SELECT} ${APPLICATION_FROM}
             WHERE pb."contactId" = $1 ORDER BY app."submittedAt" DESC`,
            canonicalContactId,
        )
        return rows.map(toSummary)
    },

    async findManagerApplications() {
        const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
            `SELECT ${APPLICATION_SELECT} ${APPLICATION_FROM} ORDER BY app."submittedAt" DESC LIMIT 200`,
        )
        return rows.map(toManagerRow)
    },

    async findManagerApplication(applicationId) {
        const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
            `SELECT ${APPLICATION_SELECT} ${APPLICATION_FROM} WHERE app."id" = $1`,
            applicationId,
        )
        return rows[0] ? toManagerRow(rows[0]) : null
    },

    async submitApplication(input) {
        const result = await submitCompensationApplicationV1({
            contract: SUBMIT_COMPENSATION_APPLICATION_COMMAND_V1,
            idempotencyKey: input.idempotencyKey,
            person: {
                canonicalContactId: input.canonicalContactId,
                resolutionStatus: 'live',
                lineage: [input.canonicalContactId],
                lineageDigest: compensationLineageDigestForContactV1(input.canonicalContactId),
                evidenceAt: input.submittedAt,
            },
            order: {
                provider: input.order.provider,
                externalParkId: input.order.externalParkId,
                externalOrderId: input.order.externalOrderId,
                shortOrderIdDisplay: input.order.shortOrderIdDisplay,
                rawPrice: input.order.rawPrice,
                endedAt: input.order.endedAt,
                verifiedAt: input.submittedAt,
            },
            claimedRubles: input.claimedRubles,
            submittedAt: input.submittedAt,
        })

        // Evidence is keyed by application, so a replayed submit keeps one row.
        await prisma.$executeRawUnsafe(
            `INSERT INTO "CompensationPilotSubmission"
               ("id","applicationId","telegramUserId","supportContactedAt","attachmentFileId",
                "attachmentKind","claimedRubles","createdAt")
             VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
             ON CONFLICT ("applicationId") DO NOTHING`,
            randomUUID(), result.applicationId, input.telegramUserId, input.submittedAt,
            input.attachmentFileId, input.attachmentKind, input.claimedRubles,
        )

        return {
            applicationId: result.applicationId,
            amountKopecks: result.amountKopecks,
            status: result.status,
        }
    },

    async startPayout(input) {
        await startCompensationPayoutV1({
            contract: START_COMPENSATION_PAYOUT_COMMAND_V1,
            applicationId: input.applicationId,
            principal: principal(input.principalId, input.operatorLabel),
            startedAt: new Date(),
        })
    },

    async rejectApplication(input) {
        await rejectCompensationApplicationV1({
            contract: REJECT_COMPENSATION_APPLICATION_COMMAND_V1,
            applicationId: input.applicationId,
            rejectionKey: input.rejectionKey,
            reason: input.reason,
            principal: principal(input.principalId, input.operatorLabel),
            rejectedAt: new Date(),
        })
    },

    async finalizePayout(input) {
        await finalizeCompensationPayoutV1({
            contract: FINALIZE_COMPENSATION_PAYOUT_COMMAND_V1,
            payoutAuthorizationId: input.payoutAuthorizationId,
            authorizationFence: input.authorizationFence,
            principal: principal(input.principalId, input.operatorLabel),
            finalizedAt: new Date(),
        })
    },

    async resolveReconciliation(input) {
        const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
            `SELECT rt."id" FROM "CompensationReconciliationTask" rt
             JOIN "CompensationPayoutAuthorization" pa ON pa."id" = rt."payoutAuthorizationId"
             WHERE pa."applicationId" = $1 AND rt."state" = 'open' LIMIT 1`,
            input.applicationId,
        )
        if (!rows[0]) return
        await resolveCompensationReconciliationV1({
            contract: RESOLVE_COMPENSATION_RECONCILIATION_COMMAND_V1,
            reconciliationTaskId: rows[0].id,
            resolution: 'paid',
            resolutionEvidence: 'manager confirmed the manual payout reached the driver',
            principal: principal(input.principalId, input.operatorLabel),
            resolvedAt: new Date(),
        })
    },
}
