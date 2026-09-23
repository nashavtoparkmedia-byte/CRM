/**
 * Composition root for the manager side of cash compensation.
 *
 * The manager screens reach the monetary core only through here, so no surface
 * picks its own adapter and none of them can reach past the service into C1.
 *
 * The support screenshot is deliberately absent from this composition: the file
 * belongs to the Telegram bot account, and fleet_operations may not reach the
 * Telegram channel. What this module exposes is the reference the trusted
 * server transport needs, and a flag on the approve action saying whether that
 * transport actually produced the file.
 */

import { legacyPrismaCompensationManagerStoreV1 } from '../internal/compensation/legacy-prisma-compensation-manager-adapter'
import { resolveManagerPrincipalV1 } from '../internal/compensation/compensation-manager-principal'
import type { AuthenticatedCrmUserV1, ManagerPrincipalResolutionV1 } from '../internal/compensation/compensation-manager-principal'
import {
    listManagerApplicationsV1,
    performManagerActionV1,
    readManagerApplicationV1,
    readManagerBudgetV1,
    type ManagerActionResultV1,
    type ManagerApplicationDetailV1,
    type ManagerApplicationListV1,
} from '../internal/compensation/compensation-manager-service'
import { managerCurrentPeriodKeyV1 } from '../internal/compensation/compensation-manager-view'
import type { ManagerBudgetViewV1, ManagerListFilterInputV1 } from '../internal/compensation/compensation-manager-view'

/** One page of applications for the manager list, newest first. */
export async function compensationManagerApplicationsV1(
    filter: ManagerListFilterInputV1 = {},
): Promise<ManagerApplicationListV1> {
    return listManagerApplicationsV1(filter, legacyPrismaCompensationManagerStoreV1)
}

/**
 * One application with its history and the actions it is open to.
 *
 * The answer is assembled here field by field rather than handed on, so what
 * leaves this composition root is a stated projection and never a value that
 * could carry a persistence handle with it.
 */
export async function compensationManagerApplicationV1(
    applicationId: string,
    now: Date = new Date(),
): Promise<ManagerApplicationDetailV1 | null> {
    const detail = await readManagerApplicationV1(applicationId, legacyPrismaCompensationManagerStoreV1, now)
    if (detail === null) return null
    return {
        applicationId: detail.applicationId,
        state: detail.state,
        status: detail.status,
        submittedAt: detail.submittedAt,
        periodKey: detail.periodKey,
        externalParkId: detail.externalParkId,
        parkName: detail.parkName,
        driverName: detail.driverName,
        driverPhone: detail.driverPhone,
        externalDriverProfileId: detail.externalDriverProfileId,
        boundContactIds: [...detail.boundContactIds],
        telegramUserId: detail.telegramUserId,
        order: { ...detail.order },
        requestedKopecks: detail.requestedKopecks,
        orderAmountKopecks: detail.orderAmountKopecks,
        payableKopecks: detail.payableKopecks,
        evidence: detail.evidence,
        attachmentKind: detail.attachmentKind,
        supportContactedAt: detail.supportContactedAt,
        rejectionReason: detail.rejectionReason,
        paidAt: detail.paidAt,
        rejectedAt: detail.rejectedAt,
        snapshot: { ...detail.snapshot },
        catalogue: { ...detail.catalogue },
        authorization: detail.authorization === null
            ? null
            : { ...detail.authorization, age: { ...detail.authorization.age } },
        reconciliation: detail.reconciliation === null ? null : { ...detail.reconciliation },
        settlement: detail.settlement === null ? null : { ...detail.settlement },
        history: detail.history.map((entry) => ({ ...entry })),
        allowedActions: [...detail.allowedActions],
    }
}

/** The month as the dashboard shows it, from the monetary core's own ledger. */
export async function compensationManagerBudgetV1(periodKey: string): Promise<ManagerBudgetViewV1> {
    const budget = await readManagerBudgetV1(periodKey, legacyPrismaCompensationManagerStoreV1)
    return {
        periodKey: budget.periodKey,
        state: budget.state,
        limitKopecks: budget.limitKopecks,
        reservedKopecks: budget.reservedKopecks,
        settledKopecks: budget.settledKopecks,
        remainingKopecks: budget.remainingKopecks,
        awaitingPaymentKopecks: budget.awaitingPaymentKopecks,
        applicationCount: budget.applicationCount,
        paidCount: budget.paidCount,
        counts: { ...budget.counts },
        ledgerConsistent: budget.ledgerConsistent,
    }
}

/**
 * Performs one manager action and answers with the state storage holds
 * afterwards. Every monetary refusal comes back as a code; nothing throws for a
 * business decision.
 */
export async function compensationManagerActionV1(
    input: Parameters<typeof performManagerActionV1>[0],
): Promise<ManagerActionResultV1> {
    return performManagerActionV1(input, legacyPrismaCompensationManagerStoreV1)
}

/**
 * The stored evidence reference, for a trusted server caller that will fetch
 * the file through the Telegram channel. Never part of a browser DTO.
 */
export async function compensationManagerEvidenceSourceV1(
    applicationId: string,
): Promise<{ fileId: string; kind: string | null } | null> {
    const source = await legacyPrismaCompensationManagerStoreV1.findEvidenceSource(applicationId)
    return source === null ? null : { fileId: source.fileId, kind: source.kind }
}

/** The budget month of an instant, on the monetary core's own calendar. */
export function compensationManagerPeriodKeyV1(now: Date = new Date()): string {
    return managerCurrentPeriodKeyV1(now)
}

/** Resolves the acting manager. Exposed so no surface reads identity itself. */
export function resolveCompensationManagerPrincipalV1(
    user: AuthenticatedCrmUserV1 | null | undefined,
): ManagerPrincipalResolutionV1 {
    return resolveManagerPrincipalV1(user)
}
