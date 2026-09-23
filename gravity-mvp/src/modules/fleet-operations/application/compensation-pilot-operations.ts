/**
 * Composition root for the compensation pilot.
 *
 * Both surfaces import from here, so neither picks its own adapter and neither
 * can reach past the service into the monetary core. The Telegram surface also
 * reaches cash-order ingestion only through here, and only through operations
 * that read locally or schedule work without waiting for Yandex.
 */

import { legacyPrismaCompensationPilotPortV1 } from '../internal/compensation/legacy-prisma-compensation-pilot-adapter'
import {
    checkPilotOrderV1,
    compensationSectionViewV1,
    requestPilotRefreshV1,
    submitPilotApplicationV1,
    type CompensationPilotIngestionPortV1,
    type CompensationSectionViewV1,
    type PilotOrderCheckV1,
    type PilotRefreshOutcomeV1,
    type PilotSubmitOutcomeV1,
    type PilotTelegramPersonProofV1,
} from '../internal/compensation/compensation-pilot-service'
import {
    readCashOrderCatalogueFactsV1,
    readCashOrderOrderConfirmationV1,
    requestCashOrderDayConfirmationV1,
    requestCashOrderHotRefreshV1,
} from './cash-order-ingestion-operations'

const pilotIngestionPortV1: CompensationPilotIngestionPortV1 = {
    readCatalogueFacts: (externalParkId) => readCashOrderCatalogueFactsV1(externalParkId),
    requestHotRefresh: (externalParkId) => requestCashOrderHotRefreshV1(externalParkId),
    requestOrderConfirmation: (input) => requestCashOrderDayConfirmationV1({
        externalParkId: input.externalParkId,
        dayKey: input.dayKey,
        order: { externalOrderId: input.externalOrderId, providerBookedAt: input.providerBookedAt },
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
    return compensationSectionViewV1(proof, legacyPrismaCompensationPilotPortV1, pilotIngestionPortV1, now, options)
}

export async function compensationPilotSubmitV1(
    input: Parameters<typeof submitPilotApplicationV1>[0],
    now: Date = new Date(),
): Promise<PilotSubmitOutcomeV1> {
    return submitPilotApplicationV1(input, legacyPrismaCompensationPilotPortV1, pilotIngestionPortV1, now)
}

/** The driver chose an order: whether it may proceed, and whether Yandex is being asked. */
export async function compensationPilotOrderCheckV1(
    input: Parameters<typeof checkPilotOrderV1>[0],
    now: Date = new Date(),
): Promise<PilotOrderCheckV1> {
    return checkPilotOrderV1(input, legacyPrismaCompensationPilotPortV1, pilotIngestionPortV1, now)
}

/** Schedules a hot pass of the driver's selected park; never waits for it. */
export async function compensationPilotRefreshV1(
    proof: PilotTelegramPersonProofV1,
    now: Date = new Date(),
): Promise<PilotRefreshOutcomeV1> {
    return requestPilotRefreshV1(proof, legacyPrismaCompensationPilotPortV1, pilotIngestionPortV1, now)
}
