/**
 * Composition root for the compensation pilot.
 *
 * Both surfaces import from here, so neither picks its own adapter and neither
 * can reach past the service into the monetary core.
 */

import { legacyPrismaCompensationPilotPortV1 } from '../internal/compensation/legacy-prisma-compensation-pilot-adapter'
import { resolveManagerPrincipalV1 } from '../internal/compensation/compensation-manager-principal'
import type { AuthenticatedCrmUserV1, ManagerPrincipalResolutionV1 } from '../internal/compensation/compensation-manager-principal'
import {
    compensationSectionViewV1,
    performManagerActionV1,
    submitPilotApplicationV1,
    type ManagerActionOutcomeV1,
    type ManagerApplicationRowV1,
    type CompensationSectionViewV1,
    type PilotSubmitOutcomeV1,
} from '../internal/compensation/compensation-pilot-service'

export async function compensationPilotSectionV1(
    telegramUserId: string,
    now: Date = new Date(),
): Promise<CompensationSectionViewV1> {
    return compensationSectionViewV1(telegramUserId, legacyPrismaCompensationPilotPortV1, now)
}

export async function compensationPilotSubmitV1(
    input: Parameters<typeof submitPilotApplicationV1>[0],
    now: Date = new Date(),
): Promise<PilotSubmitOutcomeV1> {
    return submitPilotApplicationV1(input, legacyPrismaCompensationPilotPortV1, now)
}

export async function compensationManagerApplicationsV1(): Promise<ManagerApplicationRowV1[]> {
    return legacyPrismaCompensationPilotPortV1.findManagerApplications()
}

export async function compensationManagerActionV1(
    input: Parameters<typeof performManagerActionV1>[0],
): Promise<ManagerActionOutcomeV1> {
    return performManagerActionV1(input, legacyPrismaCompensationPilotPortV1)
}

/** Resolves the acting manager. Exposed so no surface reads identity itself. */
export function resolveCompensationManagerPrincipalV1(
    user: AuthenticatedCrmUserV1 | null | undefined,
): ManagerPrincipalResolutionV1 {
    return resolveManagerPrincipalV1(user)
}
