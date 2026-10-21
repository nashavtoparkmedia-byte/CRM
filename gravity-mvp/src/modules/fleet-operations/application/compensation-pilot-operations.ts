/**
 * Composition root for the compensation pilot.
 *
 * Both surfaces import from here, so neither picks its own adapter and neither
 * can reach past the service into the monetary core. The Telegram surface also
 * reaches cash-order ingestion only through here, and only through operations
 * that read locally or schedule work without waiting for Yandex.
 *
 * Owner pilot admissions (YOKO_CASH_PILOT_ADMISSIONS) are applied here, on the
 * driver facts read, so the Telegram surface and readiness see one rule.
 */

import { legacyPrismaCompensationPilotPortV1 } from '../internal/compensation/legacy-prisma-compensation-pilot-adapter'
import { legacyPrismaCompensationPilotReadinessPortV1 } from '../internal/compensation/legacy-prisma-compensation-pilot-readiness-adapter'
import {
    compensationPilotReadinessReportV1,
    withOwnerPilotAdmissionPopulationPortV1,
    type CompensationPilotReadinessIngestionPortV1,
    type PilotReadinessReportV1,
} from '../internal/compensation/compensation-pilot-readiness-service'
import { parseOwnerPilotAdmissionsV1 } from '../internal/compensation/compensation-eligibility'
import { requireCompensationPilotTelegramLinkReaderV1 } from '../public/v1/compensation-pilot-telegram-link-reader'
import {
    checkPilotOrderV1,
    compensationSectionViewV1,
    requestPilotRefreshV1,
    submitPilotApplicationV1,
    withOwnerPilotAdmissionPortV1,
    type CompensationPilotIngestionPortV1,
    type CompensationSectionViewV1,
    type PilotOrderCheckV1,
    type PilotRefreshOutcomeV1,
    type PilotSubmitOutcomeV1,
    type PilotTelegramPersonProofV1,
} from '../internal/compensation/compensation-pilot-service'
import {
    cashOrderPilotParkScopeV1,
    readCashOrderCatalogueFactsV1,
    readCashOrderOrderConfirmationV1,
    readCashOrderParkAuthorityV1,
    requestCashOrderDayConfirmationV1,
    requestCashOrderHotRefreshV1,
} from './cash-order-ingestion-operations'

// Parsed once at load, like the ingestion configuration, and against the same
// enabled-park list, so an admission can never name a park outside the pilot.
const ownerPilotAdmissionsV1 = parseOwnerPilotAdmissionsV1(
    process.env.YOKO_CASH_PILOT_ADMISSIONS,
    cashOrderPilotParkScopeV1().enabledParks,
)
if (ownerPilotAdmissionsV1.error !== null || ownerPilotAdmissionsV1.admissions.length > 0) {
    // A count and a code only: the admitted profiles are never logged.
    console[ownerPilotAdmissionsV1.error === null ? 'info' : 'warn'](JSON.stringify({
        event: 'compensation_pilot_owner_admissions',
        count: ownerPilotAdmissionsV1.admissions.length,
        error: ownerPilotAdmissionsV1.error,
    }))
}

const pilotPortV1 = withOwnerPilotAdmissionPortV1(
    legacyPrismaCompensationPilotPortV1,
    ownerPilotAdmissionsV1.admissions,
)

const pilotIngestionPortV1: CompensationPilotIngestionPortV1 = {
    readCatalogueFacts: (externalParkId) => readCashOrderCatalogueFactsV1(externalParkId),
    requestHotRefresh: (externalParkId) => requestCashOrderHotRefreshV1(externalParkId),
    requestOrderConfirmation: (input) => requestCashOrderDayConfirmationV1({
        externalParkId: input.externalParkId,
        dayKey: input.dayKey,
        order: { externalOrderId: input.externalOrderId, providerBookedAt: input.providerBookedAt, endedAt: input.endedAt },
    }),
    async readOrderConfirmation(input) {
        const confirmation = readCashOrderOrderConfirmationV1(input)
        return {
            state: confirmation.state,
            startedAt: confirmation.startedAt,
            endedAt: confirmation.endedAt,
            code: confirmation.code,
        }
    },
}

/**
 * The driver's section. The caller must already hold Telegram channel
 * authority for the proof, including the selected park it read with it; the
 * service re-checks the person through Contacts.
 */
export async function compensationPilotSectionV1(
    proof: PilotTelegramPersonProofV1,
    options: { search?: string | null } = {},
    now: Date = new Date(),
): Promise<CompensationSectionViewV1> {
    return compensationSectionViewV1(proof, pilotPortV1, pilotIngestionPortV1, now, options)
}

export async function compensationPilotSubmitV1(
    input: Parameters<typeof submitPilotApplicationV1>[0],
    now: Date = new Date(),
): Promise<PilotSubmitOutcomeV1> {
    return submitPilotApplicationV1(input, pilotPortV1, pilotIngestionPortV1, now)
}

/** The driver chose an order: whether it may proceed, and whether Yandex is being asked. */
export async function compensationPilotOrderCheckV1(
    input: Parameters<typeof checkPilotOrderV1>[0],
    now: Date = new Date(),
): Promise<PilotOrderCheckV1> {
    return checkPilotOrderV1(input, pilotPortV1, pilotIngestionPortV1, now)
}

/** Schedules a hot pass of the driver's selected park; never waits for it. */
export async function compensationPilotRefreshV1(
    proof: PilotTelegramPersonProofV1,
    now: Date = new Date(),
): Promise<PilotRefreshOutcomeV1> {
    return requestPilotRefreshV1(proof, pilotPortV1, pilotIngestionPortV1, now)
}

/**
 * Read-only readiness for the production pilot, as two separate gates.
 *
 * Everything it reaches is a read that already exists, and it writes nothing.
 * The Telegram link reader must have been registered by the composition that
 * runs this; without it the proof fails closed rather than reporting every
 * candidate as unlinked.
 */
const readinessIngestionPortV1: CompensationPilotReadinessIngestionPortV1 = {
    parkScope: () => cashOrderPilotParkScopeV1(),
    async readParkAuthority(externalParkId) {
        const authority = await readCashOrderParkAuthorityV1(externalParkId)
        // The connection id stays inside ingestion; readiness needs the verdict.
        return authority.status === 'authoritative'
            ? { status: 'authoritative', code: null }
            : { status: 'failed', code: authority.code }
    },
    readCatalogueFacts: (externalParkId) => readCashOrderCatalogueFactsV1(externalParkId),
}

export async function compensationPilotReadinessV1(
    now: Date = new Date(),
): Promise<PilotReadinessReportV1> {
    return compensationPilotReadinessReportV1(
        pilotPortV1,
        withOwnerPilotAdmissionPopulationPortV1(
            legacyPrismaCompensationPilotReadinessPortV1,
            ownerPilotAdmissionsV1.admissions,
        ),
        readinessIngestionPortV1,
        requireCompensationPilotTelegramLinkReaderV1(),
        now,
    )
}
