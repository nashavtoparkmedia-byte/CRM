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

/** One application with its history and the actions it is open to. */
export async function compensationManagerApplicationV1(
    applicationId: string,
    now: Date = new Date(),
): Promise<ManagerApplicationDetailV1 | null> {
    return readManagerApplicationV1(applicationId, legacyPrismaCompensationManagerStoreV1, now)
}

/** The month as the dashboard shows it, from the monetary core's own ledger. */
export async function compensationManagerBudgetV1(periodKey: string): Promise<ManagerBudgetViewV1> {
    return readManagerBudgetV1(periodKey, legacyPrismaCompensationManagerStoreV1)
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
