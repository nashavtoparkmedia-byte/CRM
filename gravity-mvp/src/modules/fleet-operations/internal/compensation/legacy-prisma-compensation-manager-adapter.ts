/**
 * Prisma implementation of the manager port. Fixed SQL text only.
 *
 * Every statement is a literal with a fixed parameter count, and an absent
 * filter travels as a null parameter rather than as a different query, so the
 * text a reviewer reads is the text that runs.
 *
 * The reads exist to render the manager screens; the writes are C1 entry points
 * called unchanged. A monetary refusal is caught here and returned as its code,
 * because a business rejection is an answer the manager must see, not a fault.
 */

import { prisma } from '@/lib/prisma'

import {
    FINALIZE_COMPENSATION_PAYOUT_COMMAND_V1,
    REJECT_COMPENSATION_APPLICATION_COMMAND_V1,
    RELEASE_COMPENSATION_PAYOUT_COMMAND_V1,
    RESOLVE_COMPENSATION_RECONCILIATION_COMMAND_V1,
    START_COMPENSATION_PAYOUT_COMMAND_V1,
} from '../../../../contracts/fleet-operations/v1'
import {
    CompensationErrorV1,
    finalizeCompensationPayoutV1,
    rejectCompensationApplicationV1,
    releaseCompensationPayoutV1,
    resolveCompensationReconciliationV1,
    startCompensationPayoutV1,
} from './compensation-prisma-adapter'
import type {
    CompensationManagerActionOutcomeV1,
    CompensationManagerPortV1,
    ManagerApplicationDetailFactsV1,
    ManagerApplicationFactsV1,
    ManagerHistoryEntryV1,
    ManagerPrincipalV1,
} from './compensation-manager-service'
import type { ManagerAuthorizationStateV1, ManagerBudgetFactsV1 } from './compensation-manager-view'

/** The manager projection, derived in SQL so the same words can be filtered on. */
const STATE_EXPRESSION = `
    CASE
        WHEN app."status" = 'PAID' THEN 'paid'
        WHEN app."status" = 'REJECTED' THEN 'rejected'
        WHEN live."state" = 'unknown_outcome' AND recon."id" IS NOT NULL THEN 'reconciliation'
        WHEN live."state" = 'active' THEN 'awaiting_payment'
        ELSE 'new'
    END
`

const APPLICATION_SELECT = `
    app."id" AS "applicationId", app."status", app."version", app."submittedAt", app."paidAt",
    app."rejectedAt", app."rejectionReason", app."claimedKopecks", app."amountKopecks",
    period."periodKey",
    vo."provider", vo."externalParkId", vo."externalOrderId", vo."shortOrderIdDisplay",
    vo."rawPrice", vo."amountKopecks" AS "orderAmountKopecks", vo."endedAt" AS "orderEndedAt",
    vo."verifiedAt" AS "orderVerifiedAt",
    connection."name" AS "parkName",
    catalogue."externalDriverProfileId", catalogue."amountKopecks" AS "catalogueAmountKopecks",
    catalogue."observedAt" AS "catalogueObservedAt", catalogue."providerBookedAt" AS "catalogueProviderBookedAt",
    person."displayName" AS "driverName", phone."phone" AS "driverPhone",
    bound."contactIds" AS "boundContactIds",
    ps."telegramUserId", ps."attachmentKind", ps."supportContactedAt",
    (ps."attachmentFileId" IS NOT NULL AND ps."attachmentFileId" <> '') AS "hasAttachment",
    live."id" AS "authorizationId", live."state" AS "authorizationState",
    live."authorizationFence", live."intendedBusinessDay", live."openedAt" AS "authorizationOpenedAt",
    live."expiresAt" AS "authorizationExpiresAt", live."openedByLabel",
    recon."id" AS "reconciliationId", recon."state" AS "reconciliationState",
    recon."reason" AS "reconciliationReason", recon."openedAt" AS "reconciliationOpenedAt",
    settle."id" AS "settlementId", settle."amountKopecks" AS "settlementKopecks",
    settle."businessDay" AS "settlementBusinessDay", settle."settledAt", settle."settledByLabel",
    ${STATE_EXPRESSION} AS "managerState"
`

const APPLICATION_FROM = `
    FROM "CompensationApplication" app
    JOIN "CompensationVerifiedOrder" vo ON vo."id" = app."verifiedOrderId"
    JOIN "CompensationBudgetPeriod" period ON period."id" = app."budgetPeriodId"
    LEFT JOIN "CompensationPilotSubmission" ps ON ps."applicationId" = app."id"
    LEFT JOIN LATERAL (
        SELECT pa."id", pa."state", pa."authorizationFence", pa."intendedBusinessDay",
               pa."openedAt", pa."expiresAt", pa."openedByLabel"
        FROM "CompensationPayoutAuthorization" pa
        WHERE pa."applicationId" = app."id" AND pa."state" IN ('active','unknown_outcome')
        ORDER BY pa."openedAt" DESC LIMIT 1
    ) live ON true
    LEFT JOIN LATERAL (
        SELECT rt."id", rt."state", rt."reason", rt."openedAt"
        FROM "CompensationReconciliationTask" rt
        WHERE rt."payoutAuthorizationId" = live."id" AND rt."state" = 'open'
        ORDER BY rt."openedAt" DESC LIMIT 1
    ) recon ON true
    LEFT JOIN LATERAL (
        SELECT s."id", s."amountKopecks", s."businessDay", s."settledAt", s."settledByLabel"
        FROM "CompensationSettlement" s WHERE s."applicationId" = app."id" LIMIT 1
    ) settle ON true
    LEFT JOIN LATERAL (
        SELECT array_agg(pb."contactId" ORDER BY pb."contactId") AS "contactIds"
        FROM "CompensationPersonBinding" pb
        WHERE pb."compensationPersonId" = app."compensationPersonId"
    ) bound ON true
    -- The person is named through the contact the compensation person is
    -- bound to. The driver profile row carries the same name, but only behind
    -- columns that exist in no migration, so it cannot be relied on here.
    LEFT JOIN LATERAL (
        SELECT c."id", c."displayName"
        FROM "CompensationPersonBinding" pb
        JOIN "Contact" c ON c."id" = pb."contactId"
        WHERE pb."compensationPersonId" = app."compensationPersonId"
        ORDER BY pb."contactId" ASC LIMIT 1
    ) person ON true
    LEFT JOIN LATERAL (
        SELECT cp."phone" FROM "ContactPhone" cp
        WHERE cp."contactId" = person."id" AND cp."isActive" = true
        ORDER BY cp."isPrimary" DESC, cp."createdAt" ASC LIMIT 1
    ) phone ON true
    LEFT JOIN LATERAL (
        SELECT co."externalDriverProfileId", co."amountKopecks", co."observedAt", co."providerBookedAt"
        FROM "CompensationCashOrder" co
        WHERE co."provider" = vo."provider" AND co."externalParkId" = vo."externalParkId"
          AND co."externalOrderId" = vo."externalOrderId"
        LIMIT 1
    ) catalogue ON true
    LEFT JOIN LATERAL (
        SELECT c."name" FROM "ApiConnection" c
        WHERE c."parkId" = vo."externalParkId" ORDER BY c."createdAt" ASC LIMIT 1
    ) connection ON true
`

const text = (value: unknown): string | null => (value === null || value === undefined ? null : String(value))
const date = (value: unknown): Date => new Date(value as string)
const nullableDate = (value: unknown): Date | null => (value === null || value === undefined ? null : new Date(value as string))

function toFacts(row: Record<string, unknown>): ManagerApplicationFactsV1 {
    const authorizationId = text(row.authorizationId)
    const reconciliationId = text(row.reconciliationId)
    const settlementId = text(row.settlementId)
    return {
        applicationId: String(row.applicationId),
        status: String(row.status),
        version: Number(row.version),
        periodKey: String(row.periodKey),
        submittedAt: date(row.submittedAt),
        paidAt: nullableDate(row.paidAt),
        rejectedAt: nullableDate(row.rejectedAt),
        rejectionReason: text(row.rejectionReason),
        requestedKopecks: Number(row.claimedKopecks),
        payableKopecks: Number(row.amountKopecks),
        orderAmountKopecks: Number(row.orderAmountKopecks),
        provider: String(row.provider),
        externalParkId: String(row.externalParkId),
        parkName: text(row.parkName),
        externalOrderId: String(row.externalOrderId),
        shortOrderIdDisplay: text(row.shortOrderIdDisplay),
        orderEndedAt: date(row.orderEndedAt),
        orderRawPrice: String(row.rawPrice),
        orderVerifiedAt: date(row.orderVerifiedAt),
        driverName: text(row.driverName),
        driverPhone: text(row.driverPhone),
        externalDriverProfileId: text(row.externalDriverProfileId),
        boundContactIds: Array.isArray(row.boundContactIds) ? row.boundContactIds.map(String) : [],
        telegramUserId: text(row.telegramUserId),
        attachmentKind: text(row.attachmentKind),
        hasAttachment: row.hasAttachment === true,
        supportContactedAt: nullableDate(row.supportContactedAt),
        authorization: authorizationId === null ? null : {
            id: authorizationId,
            state: String(row.authorizationState) as ManagerAuthorizationStateV1,
            authorizationFence: String(row.authorizationFence),
            intendedBusinessDay: String(row.intendedBusinessDay),
            openedAt: date(row.authorizationOpenedAt),
            expiresAt: date(row.authorizationExpiresAt),
            openedByLabel: text(row.openedByLabel),
        },
        reconciliation: reconciliationId === null ? null : {
            id: reconciliationId,
            state: String(row.reconciliationState),
            reason: String(row.reconciliationReason),
            openedAt: date(row.reconciliationOpenedAt),
        },
        settlement: settlementId === null ? null : {
            id: settlementId,
            amountKopecks: Number(row.settlementKopecks),
            businessDay: String(row.settlementBusinessDay),
            settledAt: date(row.settledAt),
            settledByLabel: text(row.settledByLabel),
        },
        catalogue: row.catalogueObservedAt === null || row.catalogueObservedAt === undefined ? null : {
            amountKopecks: Number(row.catalogueAmountKopecks),
            observedAt: date(row.catalogueObservedAt),
            providerBookedAt: nullableDate(row.catalogueProviderBookedAt),
        },
    }
}

function toHistory(row: Record<string, unknown>): ManagerHistoryEntryV1 {
    return {
        occurredAt: date(row.occurredAt),
        action: String(row.action),
        actorLabel: text(row.operatorLabel) ?? String(row.principalId),
        previousState: text(row.previousState),
        nextState: text(row.nextState),
        amountKopecks: row.amountKopecks === null || row.amountKopecks === undefined ? null : Number(row.amountKopecks),
        reason: text(row.reason),
    }
}

/** Runs one C1 entry point, turning its refusal into a code the manager sees. */
async function monetary(
    operation: () => Promise<{ status: string }>,
): Promise<CompensationManagerActionOutcomeV1> {
    try {
        const result = await operation()
        return { ok: true, code: null, replayed: result.status === 'replayed' }
    } catch (error) {
        if (error instanceof CompensationErrorV1) return { ok: false, code: error.code, replayed: false }
        throw error
    }
}

export const legacyPrismaCompensationManagerStoreV1: CompensationManagerPortV1 = {
    async findApplications(filter) {
        const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
            `SELECT ${APPLICATION_SELECT} ${APPLICATION_FROM}
             WHERE ($1::text IS NULL OR period."periodKey" = $1)
               AND ($2::text IS NULL OR vo."externalParkId" = $2)
               AND ($3::text IS NULL OR ${STATE_EXPRESSION} = $3)
               AND ($4::timestamptz IS NULL
                    OR (app."submittedAt", app."id") < ($4::timestamptz, $5::text))
             ORDER BY app."submittedAt" DESC, app."id" DESC
             LIMIT $6`,
            filter.periodKey,
            filter.externalParkId,
            filter.state,
            filter.cursor === null ? null : filter.cursor.submittedAt,
            filter.cursor === null ? null : filter.cursor.applicationId,
            filter.limit + 1,
        )
        const page = rows.slice(0, filter.limit)
        return { rows: page.map(toFacts), hasMore: rows.length > filter.limit }
    },

    async findApplication(applicationId): Promise<ManagerApplicationDetailFactsV1 | null> {
        const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
            `SELECT ${APPLICATION_SELECT} ${APPLICATION_FROM} WHERE app."id" = $1`,
            applicationId,
        )
        if (rows.length === 0) return null
        // Everything C1 recorded about this application and about every payout
        // right it ever held, in the order it happened.
        const history = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
            `SELECT ae."occurredAt", ae."action", ae."principalId", ae."operatorLabel",
                    ae."previousState", ae."nextState", ae."amountKopecks", ae."reason"
             FROM "CompensationAuditEvent" ae
             WHERE (ae."subjectType" = 'CompensationApplication' AND ae."subjectId" = $1)
                OR ae."payoutAuthorizationId" IN (
                    SELECT pa."id" FROM "CompensationPayoutAuthorization" pa WHERE pa."applicationId" = $1
                )
             ORDER BY ae."occurredAt" ASC, ae."id" ASC`,
            applicationId,
        )
        return { ...toFacts(rows[0]), history: history.map(toHistory) }
    },

    async findBudget(periodKey): Promise<ManagerBudgetFactsV1 | null> {
        const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
            `SELECT period."periodKey", period."state", period."limitKopecks",
                    period."reservedKopecks", period."settledKopecks",
                    COALESCE(applications."pendingSum", 0) AS "pendingSum",
                    COALESCE(applications."awaitingSum", 0) AS "awaitingSum",
                    COALESCE(applications."newCount", 0) AS "newCount",
                    COALESCE(applications."awaitingCount", 0) AS "awaitingCount",
                    COALESCE(applications."reconciliationCount", 0) AS "reconciliationCount",
                    COALESCE(applications."paidCount", 0) AS "paidCount",
                    COALESCE(applications."rejectedCount", 0) AS "rejectedCount",
                    COALESCE(settlements."settlementSum", 0) AS "settlementSum",
                    COALESCE(settlements."settlementCount", 0) AS "settlementCount"
             FROM "CompensationBudgetPeriod" period
             -- One row per application of the month, stated in exactly the words
             -- the list filters on: the latest live payout right and the open
             -- reconciliation task on that right, as in the list projection.
             LEFT JOIN (
                SELECT app."budgetPeriodId",
                    SUM(app."amountKopecks") FILTER (WHERE app."status" = 'PENDING') AS "pendingSum",
                    SUM(app."amountKopecks") FILTER (WHERE app."status" = 'PENDING' AND live."state" = 'active') AS "awaitingSum",
                    COUNT(*) FILTER (WHERE ${STATE_EXPRESSION} = 'new') AS "newCount",
                    COUNT(*) FILTER (WHERE ${STATE_EXPRESSION} = 'awaiting_payment') AS "awaitingCount",
                    COUNT(*) FILTER (WHERE ${STATE_EXPRESSION} = 'reconciliation') AS "reconciliationCount",
                    COUNT(*) FILTER (WHERE ${STATE_EXPRESSION} = 'paid') AS "paidCount",
                    COUNT(*) FILTER (WHERE ${STATE_EXPRESSION} = 'rejected') AS "rejectedCount"
                FROM "CompensationApplication" app
                JOIN "CompensationBudgetPeriod" app_period ON app_period."id" = app."budgetPeriodId"
                LEFT JOIN (
                    SELECT DISTINCT ON (pa."applicationId") pa."applicationId", pa."id", pa."state"
                    FROM "CompensationPayoutAuthorization" pa
                    WHERE pa."state" IN ('active','unknown_outcome')
                    ORDER BY pa."applicationId", pa."openedAt" DESC
                ) live ON live."applicationId" = app."id"
                LEFT JOIN (
                    SELECT DISTINCT ON (rt."payoutAuthorizationId") rt."payoutAuthorizationId", rt."id"
                    FROM "CompensationReconciliationTask" rt
                    WHERE rt."state" = 'open'
                    ORDER BY rt."payoutAuthorizationId", rt."openedAt" DESC
                ) recon ON recon."payoutAuthorizationId" = live."id"
                WHERE app_period."periodKey" = $1
                GROUP BY app."budgetPeriodId"
             ) applications ON applications."budgetPeriodId" = period."id"
             LEFT JOIN (
                SELECT s."budgetPeriodId", SUM(s."amountKopecks") AS "settlementSum", COUNT(*) AS "settlementCount"
                FROM "CompensationSettlement" s
                GROUP BY s."budgetPeriodId"
             ) settlements ON settlements."budgetPeriodId" = period."id"
             WHERE period."periodKey" = $1`,
            periodKey,
        )
        const row = rows[0]
        if (!row) return null
        return {
            periodKey: String(row.periodKey),
            state: String(row.state),
            limitKopecks: Number(row.limitKopecks),
            reservedKopecks: Number(row.reservedKopecks),
            settledKopecks: Number(row.settledKopecks),
            pendingSumKopecks: Number(row.pendingSum),
            awaitingPaymentKopecks: Number(row.awaitingSum),
            settlementSumKopecks: Number(row.settlementSum),
            counts: {
                new: Number(row.newCount),
                awaiting_payment: Number(row.awaitingCount),
                reconciliation: Number(row.reconciliationCount),
                paid: Number(row.paidCount),
                rejected: Number(row.rejectedCount),
            },
            paidCount: Number(row.settlementCount),
        }
    },

    async findEvidenceSource(applicationId) {
        const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
            `SELECT ps."attachmentFileId", ps."attachmentKind"
             FROM "CompensationPilotSubmission" ps WHERE ps."applicationId" = $1`,
            applicationId,
        )
        const fileId = rows[0] === undefined ? null : text(rows[0].attachmentFileId)
        return fileId === null || fileId === '' ? null : { fileId, kind: text(rows[0].attachmentKind) }
    },

    async startPayout({ applicationId, principal }) {
        return monetary(() => startCompensationPayoutV1({
            contract: START_COMPENSATION_PAYOUT_COMMAND_V1,
            applicationId,
            principal: toPrincipal(principal),
            startedAt: new Date(),
        }))
    },

    async rejectApplication({ applicationId, reason, rejectionKey, principal }) {
        return monetary(() => rejectCompensationApplicationV1({
            contract: REJECT_COMPENSATION_APPLICATION_COMMAND_V1,
            applicationId,
            rejectionKey,
            reason,
            principal: toPrincipal(principal),
            rejectedAt: new Date(),
        }))
    },

    async finalizePayout({ payoutAuthorizationId, authorizationFence, principal }) {
        return monetary(() => finalizeCompensationPayoutV1({
            contract: FINALIZE_COMPENSATION_PAYOUT_COMMAND_V1,
            payoutAuthorizationId,
            authorizationFence,
            principal: toPrincipal(principal),
            finalizedAt: new Date(),
        }))
    },

    async releasePayout({ payoutAuthorizationId, authorizationFence, kind, reason, principal }) {
        return monetary(() => releaseCompensationPayoutV1({
            contract: RELEASE_COMPENSATION_PAYOUT_COMMAND_V1,
            payoutAuthorizationId,
            authorizationFence,
            kind,
            reason,
            principal: toPrincipal(principal),
            releasedAt: new Date(),
        }))
    },

    async resolveReconciliation({ reconciliationTaskId, resolution, resolutionEvidence, principal }) {
        return monetary(() => resolveCompensationReconciliationV1({
            contract: RESOLVE_COMPENSATION_RECONCILIATION_COMMAND_V1,
            reconciliationTaskId,
            resolution,
            resolutionEvidence,
            principal: toPrincipal(principal),
            resolvedAt: new Date(),
        }))
    },
}

function toPrincipal(principal: ManagerPrincipalV1) {
    return {
        principalId: principal.principalId,
        principalKind: 'crm_user' as const,
        operatorLabel: principal.operatorLabel,
    }
}
