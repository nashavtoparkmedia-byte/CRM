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
    contactOwnershipBusyResultV1,
    isContactConfirmedMainDriverV1,
    resolveContactLineageV1,
} from '@/modules/contacts/public/v1'

import { SUBMIT_COMPENSATION_APPLICATION_COMMAND_V1 } from '../../../../contracts/fleet-operations/v1'
import { compensationLineageDigestV1 } from './compensation-pilot-lineage'
import { CompensationErrorV1, submitCompensationApplicationV1 } from './compensation-prisma-adapter'
import { pilotDriverStatusV1 } from './compensation-pilot-flow'
import type { CompensationPilotPortV1, PilotApplicationSummaryV1 } from './compensation-pilot-service'

/** A person's applications, found through any contact bound to it. */
const BOUND_TO_LINEAGE = `
    EXISTS (
        SELECT 1 FROM "CompensationPersonBinding" pb
        WHERE pb."compensationPersonId" = app."compensationPersonId"
          AND pb."contactId" = ANY($1::text[])
    )
`

/** Shared row shape for both the driver and manager lists. */
const APPLICATION_SELECT = `
    app."id" AS "applicationId", app."status", app."claimedKopecks", app."amountKopecks",
    app."submittedAt", app."rejectionReason",
    vo."externalOrderId", vo."shortOrderIdDisplay",
    vo."amountKopecks" AS "verifiedKopecks",
    (live."id" IS NOT NULL) AS "hasLiveAuthorization"
`

const APPLICATION_FROM = `
    FROM "CompensationApplication" app
    JOIN "CompensationVerifiedOrder" vo ON vo."id" = app."verifiedOrderId"
    LEFT JOIN LATERAL (
        SELECT pa."id" FROM "CompensationPayoutAuthorization" pa
        WHERE pa."applicationId" = app."id" AND pa."state" IN ('active','unknown_outcome')
        ORDER BY pa."openedAt" DESC LIMIT 1
    ) live ON true
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

export const legacyPrismaCompensationPilotPortV1: CompensationPilotPortV1 = {
    async confirmMainDriver(contactId, driverId) {
        try {
            return await isContactConfirmedMainDriverV1(contactId, driverId) ? 'confirmed' : 'not_confirmed'
        } catch (error) {
            // Contacts' ownership fence was held; the answer is unknown, not no.
            if (contactOwnershipBusyResultV1(error)) return 'busy'
            throw error
        }
    },

    async resolveContactLineage(contactId) {
        try {
            const lineage = await resolveContactLineageV1(contactId)
            if (!lineage) return { status: 'missing' }
            return {
                status: 'resolved',
                canonicalContactId: lineage.canonicalContactId,
                contactIds: lineage.contactIds,
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : ''
            if (message.startsWith('CONTACT_MERGE_REDIRECT_')) return { status: 'unresolvable' }
            throw error
        }
    },

    async findDriverFacts(driverId) {
        // Driver.contactId is a Fleet projection, never the person; the person
        // was proven through Contacts above.
        const driver = await prisma.driver.findUnique({
            where: { id: driverId },
            select: {
                externalParkId: true,
                externalDriverProfileId: true,
                isSelfEmployed: true,
                employmentType: true,
                yandexHireDate: true,
            },
        })
        if (!driver) return null
        return {
            externalParkId: driver.externalParkId,
            externalDriverProfileId: driver.externalDriverProfileId,
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
                    "externalDriverProfileId","rawPrice","amountKopecks","endedAt",
                    "observedAt","providerBookedAt"
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
            observedAt: new Date(row.observedAt as string),
            providerBookedAt: row.providerBookedAt === null ? null : new Date(row.providerBookedAt as string),
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

    async findClaimedOrderIds(lineage) {
        // A rejected application frees the order for a second attempt, which is
        // C1's rule; only live and paid claims block it.
        const rows = await prisma.$queryRawUnsafe<Array<{ externalOrderId: string }>>(
            `SELECT DISTINCT vo."externalOrderId"
             FROM "CompensationApplication" app
             JOIN "CompensationVerifiedOrder" vo ON vo."id" = app."verifiedOrderId"
             WHERE ${BOUND_TO_LINEAGE} AND app."status" IN ('PENDING','PAID')`,
            [...lineage],
        )
        return rows.map((row) => row.externalOrderId)
    },

    async findDriverApplications(lineage) {
        const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
            `SELECT ${APPLICATION_SELECT} ${APPLICATION_FROM}
             WHERE ${BOUND_TO_LINEAGE} ORDER BY app."submittedAt" DESC`,
            [...lineage],
        )
        return rows.map(toSummary)
    },

    async submitApplication(input) {
        let result: Awaited<ReturnType<typeof submitCompensationApplicationV1>>
        try {
            result = await submitCompensationApplicationV1({
                contract: SUBMIT_COMPENSATION_APPLICATION_COMMAND_V1,
                idempotencyKey: input.idempotencyKey,
                person: {
                    canonicalContactId: input.canonicalContactId,
                    resolutionStatus: 'live',
                    lineage: [...input.lineage],
                    lineageDigest: compensationLineageDigestV1(input.lineage),
                    evidenceAt: input.submittedAt,
                },
                order: {
                    provider: input.order.provider,
                    externalParkId: input.order.externalParkId,
                    externalOrderId: input.order.externalOrderId,
                    shortOrderIdDisplay: input.order.shortOrderIdDisplay,
                    rawPrice: input.order.rawPrice,
                    endedAt: input.order.endedAt,
                    // When Yandex last confirmed the order, not when the driver
                    // pressed submit: the gate only lets a recent one through.
                    verifiedAt: input.order.observedAt,
                },
                claimedRubles: input.claimedRubles,
                submittedAt: input.submittedAt,
            })
        } catch (error) {
            // A C1 refusal is an answer for the driver, not an outage; nothing
            // was written, so no evidence row follows it.
            if (error instanceof CompensationErrorV1) return { refusal: error.code }
            throw error
        }

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
    }
}
