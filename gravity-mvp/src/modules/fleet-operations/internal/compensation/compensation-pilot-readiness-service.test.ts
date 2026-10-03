/**
 * The readiness composition, driven through fakes.
 *
 * Two things are proven here that a pure gate test cannot: that the two gates
 * stay separate across a whole population, and that readiness never reaches a
 * write. Every port method that could mutate anything throws if it is called,
 * so a future change that starts submitting or scheduling fails this file
 * rather than production.
 */

import { describe, expect, it, vi } from 'vitest'

import { MAX_COMPENSATION_KOPECKS } from './compensation-money'
import type { PilotCatalogueOrderV1 } from './compensation-pilot-selection'
import type { PilotCandidateDriverV1 } from './compensation-pilot-readiness'
import {
    compensationPilotReadinessReportV1,
    PILOT_READINESS_POPULATION_LIMIT_V1,
    PILOT_READINESS_TELEGRAM_BATCH_V1,
    type CompensationPilotReadinessIngestionPortV1,
    type CompensationPilotReadinessPopulationPortV1,
} from './compensation-pilot-readiness-service'
import type { CompensationPilotPortV1 } from './compensation-pilot-service'
import type { CompensationPilotTelegramLinkReaderV1 } from '../../public/v1/compensation-pilot-telegram-link-reader'

const PARK = 'ext-park-yoko'
const OTHER_PARK = 'ext-park-other'
const HIRE_DATE = new Date('2026-09-10T08:00:00.000Z')
const NOW = new Date('2026-09-20T12:00:00.000Z')
const MINUTE = 60_000

const driverRow = (
    driverId: string,
    overrides: Partial<PilotCandidateDriverV1> = {},
): PilotCandidateDriverV1 => ({
    driverId,
    contactId: `contact-${driverId}`,
    externalParkId: PARK,
    externalDriverProfileId: `profile-${driverId}`,
    facts: { isSelfEmployed: true, employmentType: 'selfemployed', parkHireDate: HIRE_DATE },
    ...overrides,
})

const orderFor = (
    driverId: string,
    overrides: Partial<PilotCatalogueOrderV1> = {},
): PilotCatalogueOrderV1 => ({
    id: `row-${driverId}`,
    provider: 'yandex_fleet',
    externalParkId: PARK,
    externalOrderId: `ext-order-${driverId}`,
    shortOrderIdDisplay: null,
    externalDriverProfileId: `profile-${driverId}`,
    rawPrice: '500',
    amountKopecks: 50_000,
    endedAt: new Date('2026-09-19T10:00:00.000Z'),
    observedAt: new Date(NOW.getTime() - 30 * MINUTE),
    providerBookedAt: null,
    ...overrides,
})

/** Every write, provider call and scheduling entry point fails the test. */
function pilotPort(overrides: Partial<CompensationPilotPortV1> = {}): CompensationPilotPortV1 {
    const forbidden = (name: string) => () => {
        throw new Error(`readiness must not call ${name}`)
    }
    return {
        confirmMainDriver: async () => 'confirmed',
        resolveContactLineage: async (contactId) => ({
            status: 'resolved',
            canonicalContactId: contactId,
            contactIds: [contactId],
        }),
        findDriverFacts: forbidden('findDriverFacts') as never,
        findCashOrders: async () => [],
        findBudgetPeriod: async () => ({
            limitKopecks: MAX_COMPENSATION_KOPECKS,
            reservedKopecks: 0,
            settledKopecks: 0,
        }),
        findClaimedOrderIds: async () => [],
        findDriverApplications: forbidden('findDriverApplications') as never,
        submitApplication: forbidden('submitApplication') as never,
        ...overrides,
    }
}

const populationPort = (drivers: PilotCandidateDriverV1[]): CompensationPilotReadinessPopulationPortV1 => ({
    listPilotCandidateDrivers: async ({ externalParkIds }) =>
        drivers.filter((row) => row.externalParkId !== null && externalParkIds.includes(row.externalParkId)),
})

function ingestionPort(
    overrides: Partial<CompensationPilotReadinessIngestionPortV1> = {},
): CompensationPilotReadinessIngestionPortV1 {
    return {
        parkScope: () => ({ mode: 'write', enabledParks: [PARK], configError: null }),
        readParkAuthority: async () => ({ status: 'authoritative', code: null }),
        readCatalogueFacts: async () => ({
            mode: 'write',
            parkEnabled: true,
            dbNow: NOW,
            lastHotSuccessAt: new Date(NOW.getTime() - MINUTE),
            reconciliationPassStartedAt: null,
            reconciliationFloorBookedAt: null,
            reconciliationCursorBookedAt: null,
            lastReconciliationCompletedAt: new Date(NOW.getTime() - MINUTE),
        }),
        ...overrides,
    }
}

const linkReader = (
    links: Record<string, string | null>,
): CompensationPilotTelegramLinkReaderV1 => async (driverIds) =>
    driverIds
        .filter((driverId) => driverId in links)
        .map((driverId) => ({ driverId, activeParkId: links[driverId] }))

describe('the readiness composition', () => {
    it('reports both gates, and never touches a write or a provider', async () => {
        const report = await compensationPilotReadinessReportV1(
            pilotPort({ findCashOrders: async () => [orderFor('a')] }),
            populationPort([driverRow('a')]),
            ingestionPort(),
            linkReader({ a: PARK }),
            NOW,
        )
        expect(report.pilotCandidateReady).toBe(true)
        expect(report.pilotInputReady).toBe(true)
        expect(report.syncEvidence).toBe('not_persisted')
        expect(report.counts).toMatchObject({ pilotParkDrivers: 1, candidateReady: 1, inputReady: 1 })
    })

    it('keeps the gates separate: candidate-ready while the whole feature is off', async () => {
        const report = await compensationPilotReadinessReportV1(
            pilotPort({ findBudgetPeriod: async () => null }),
            populationPort([driverRow('a')]),
            ingestionPort({
                parkScope: () => ({ mode: 'off', enabledParks: [PARK], configError: null }),
                readCatalogueFacts: async () => ({
                    mode: 'off',
                    parkEnabled: true,
                    dbNow: NOW,
                    lastHotSuccessAt: null,
                    reconciliationPassStartedAt: null,
                    reconciliationFloorBookedAt: null,
                    reconciliationCursorBookedAt: null,
                    lastReconciliationCompletedAt: null,
                }),
            }),
            linkReader({ a: PARK }),
            NOW,
        )
        expect(report.pilotCandidateReady).toBe(true)
        expect(report.pilotInputReady).toBe(false)
        expect(report.mode).toBe('off')
        expect(report.reasons).toEqual([{ gate: 'input', code: 'catalogue_disabled', count: 1 }])
    })

    it('reads no population at all when a configuration fault disables every park', async () => {
        const listPilotCandidateDrivers = vi.fn()
        const report = await compensationPilotReadinessReportV1(
            pilotPort(),
            { listPilotCandidateDrivers } as CompensationPilotReadinessPopulationPortV1,
            ingestionPort({
                parkScope: () => ({ mode: 'off', enabledParks: [PARK], configError: 'scheduled_dry_run_retired' }),
            }),
            linkReader({}),
            NOW,
        )
        expect(listPilotCandidateDrivers).not.toHaveBeenCalled()
        expect(report.pilotParks).toEqual([])
        expect(report.configError).toBe('scheduled_dry_run_retired')
        expect(report.pilotCandidateReady).toBe(false)
    })

    it('asks no other owner about a driver the Driver row already disqualifies', async () => {
        const confirmMainDriver = vi.fn(async () => 'confirmed' as const)
        const readTelegramLinks = vi.fn<CompensationPilotTelegramLinkReaderV1>(async () => [])
        await compensationPilotReadinessReportV1(
            pilotPort({ confirmMainDriver }),
            populationPort([
                driverRow('out-of-scope', { externalParkId: OTHER_PARK }),
                driverRow('not-smz', {
                    facts: { isSelfEmployed: false, employmentType: 'park_employee', parkHireDate: HIRE_DATE },
                }),
            ]),
            ingestionPort(),
            readTelegramLinks,
            NOW,
        )
        expect(confirmMainDriver).not.toHaveBeenCalled()
        // A batch is only asked for when there is a prescreened driver to ask about.
        expect(readTelegramLinks).not.toHaveBeenCalled()
    })

    it('never combines one driver eligibility with another driver order', async () => {
        // `a` is Gate-1 ready but has no order of their own; `b` has the fresh
        // order and no Telegram link. Neither may make the other ready.
        const report = await compensationPilotReadinessReportV1(
            pilotPort({
                findCashOrders: async ({ externalDriverProfileId }) =>
                    externalDriverProfileId === 'profile-b' ? [orderFor('b')] : [],
            }),
            populationPort([driverRow('a'), driverRow('b')]),
            ingestionPort(),
            linkReader({ a: PARK }),
            NOW,
        )
        expect(report.pilotCandidateReady).toBe(true)
        expect(report.pilotInputReady).toBe(false)
        expect(report.counts).toMatchObject({ candidateReady: 1, inputReady: 0 })
        expect(report.reasons).toEqual([
            { gate: 'candidate', code: 'telegram_link_missing', count: 1 },
            { gate: 'input', code: 'no_cash_orders', count: 1 },
        ])
    })

    it('batches the Telegram read inside its own bound', async () => {
        const drivers = Array.from({ length: PILOT_READINESS_TELEGRAM_BATCH_V1 + 1 }, (_, index) =>
            driverRow(`d${String(index).padStart(3, '0')}`))
        const batches: number[] = []
        await compensationPilotReadinessReportV1(
            pilotPort(),
            populationPort(drivers),
            ingestionPort(),
            async (driverIds) => {
                batches.push(driverIds.length)
                return []
            },
            NOW,
        )
        expect(batches).toEqual([PILOT_READINESS_TELEGRAM_BATCH_V1, 1])
        expect(batches.every((size) => size <= PILOT_READINESS_TELEGRAM_BATCH_V1)).toBe(true)
    })

    it('reads park authority and catalogue facts once per park, not once per candidate', async () => {
        const readParkAuthority = vi.fn(async () => ({ status: 'authoritative' as const, code: null }))
        const report = await compensationPilotReadinessReportV1(
            pilotPort(),
            populationPort([driverRow('a'), driverRow('b'), driverRow('c')]),
            ingestionPort({ readParkAuthority }),
            linkReader({ a: PARK, b: PARK, c: PARK }),
            NOW,
        )
        expect(report.counts.candidateReady).toBe(3)
        expect(readParkAuthority).toHaveBeenCalledTimes(1)
        expect(report.parks).toEqual([
            { externalParkId: PARK, parkAuthority: 'authoritative', parkAuthorityCode: null, catalogueStatus: 'ready' },
        ])
    })

    it('carries the park authority refusal code for the operator', async () => {
        const report = await compensationPilotReadinessReportV1(
            pilotPort(),
            populationPort([driverRow('a')]),
            ingestionPort({
                readParkAuthority: async () => ({ status: 'failed', code: 'park_connection_missing' }),
            }),
            linkReader({ a: PARK }),
            NOW,
        )
        expect(report.parks[0]).toMatchObject({
            parkAuthority: 'failed',
            parkAuthorityCode: 'park_connection_missing',
        })
        expect(report.reasons).toEqual([{ gate: 'input', code: 'park_authority_failed', count: 1 }])
    })

    it('is idempotent: the same state read twice gives the same answer', async () => {
        const run = () => compensationPilotReadinessReportV1(
            pilotPort({ findCashOrders: async () => [orderFor('a')] }),
            populationPort([driverRow('a')]),
            ingestionPort(),
            linkReader({ a: PARK }),
            NOW,
        )
        expect(JSON.stringify(await run())).toBe(JSON.stringify(await run()))
    })
})

/** Mirrors the adapter's `take: limit`, so truncation behaves as in production. */
const boundedPopulationPort = (drivers: PilotCandidateDriverV1[]): CompensationPilotReadinessPopulationPortV1 => ({
    listPilotCandidateDrivers: async ({ externalParkIds, limit }) =>
        drivers.filter((row) => row.externalParkId !== null && externalParkIds.includes(row.externalParkId))
            .slice(0, limit),
})

/** An eligible driver, so it reaches the Telegram and Contacts reads. */
const eligible = (index: number) => driverRow(`d${String(index).padStart(4, '0')}`)
/** Ineligible on the Driver row alone, so it costs no foreign read. */
const notSelfEmployed = (index: number) => driverRow(`x${String(index).padStart(4, '0')}`, {
    facts: { isSelfEmployed: false, employmentType: 'park_employee', parkHireDate: HIRE_DATE },
})

describe('Gate 2 consumes the admitted identity proof', () => {
    it('asks for claimed orders with exactly the lineage the shared rule admitted', async () => {
        const findClaimedOrderIds = vi.fn(async () => [])
        await compensationPilotReadinessReportV1(
            pilotPort({ findClaimedOrderIds, findCashOrders: async () => [orderFor('a')] }),
            populationPort([driverRow('a')]),
            ingestionPort(),
            linkReader({ a: PARK }),
            NOW,
        )
        // The adapter binds claims by contact-set membership, so a lineage that
        // is not the admitted one would silently widen or narrow the claim scope.
        expect(findClaimedOrderIds).toHaveBeenCalledTimes(1)
        expect(findClaimedOrderIds).toHaveBeenCalledWith(['contact-a'])
    })

    it('carries the canonical contact the rule resolved, not the row it started from', async () => {
        const findClaimedOrderIds = vi.fn(async () => [])
        await compensationPilotReadinessReportV1(
            pilotPort({
                findClaimedOrderIds,
                resolveContactLineage: async (contactId) => ({
                    status: 'resolved', canonicalContactId: contactId, contactIds: [contactId],
                }),
            }),
            populationPort([driverRow('a')]),
            ingestionPort(),
            linkReader({ a: PARK }),
            NOW,
        )
        expect(findClaimedOrderIds).toHaveBeenCalledWith(['contact-a'])
    })
})

describe('a bounded population never passes off an unknown as a negative', () => {
    it('6. a complete population with no ready candidate is a proven negative', async () => {
        const report = await compensationPilotReadinessReportV1(
            pilotPort(),
            boundedPopulationPort([notSelfEmployed(1), notSelfEmployed(2), notSelfEmployed(3)]),
            ingestionPort(),
            linkReader({}),
            NOW,
        )
        expect(report.counts.populationTruncated).toBe(false)
        expect(report.pilotCandidateReady).toBe(false)
        expect(report.pilotCandidateProofComplete).toBe(true)
        expect(report.proofIncompleteReason).toBeNull()
    })

    it('7. a complete population with a candidate but no input is a proven negative', async () => {
        const report = await compensationPilotReadinessReportV1(
            pilotPort({ findCashOrders: async () => [] }),
            boundedPopulationPort([eligible(0)]),
            ingestionPort(),
            linkReader({ d0000: PARK }),
            NOW,
        )
        expect(report.counts.populationTruncated).toBe(false)
        expect(report.pilotCandidateReady).toBe(true)
        expect(report.pilotInputReady).toBe(false)
        expect(report.pilotInputProofComplete).toBe(true)
        expect(report.proofIncompleteReason).toBeNull()
    })

    it('8. a truncated population with no candidate found is NOT a proven negative', async () => {
        const drivers = Array.from({ length: PILOT_READINESS_POPULATION_LIMIT_V1 + 1 }, (_, i) => notSelfEmployed(i))
        const report = await compensationPilotReadinessReportV1(
            pilotPort(), boundedPopulationPort(drivers), ingestionPort(), linkReader({}), NOW,
        )
        expect(report.counts.pilotParkDrivers).toBe(PILOT_READINESS_POPULATION_LIMIT_V1)
        expect(report.counts.populationTruncated).toBe(true)
        expect(report.pilotCandidateReady).toBe(false)
        expect(report.pilotCandidateProofComplete).toBe(false)
        expect(report.pilotInputProofComplete).toBe(false)
        expect(report.proofIncompleteReason).toBe('population_truncated_proof_incomplete')
    })

    it('9. a truncated population that DID find a candidate proves the gate', async () => {
        const drivers = [
            eligible(0),
            ...Array.from({ length: PILOT_READINESS_POPULATION_LIMIT_V1 }, (_, i) => notSelfEmployed(i)),
        ]
        const report = await compensationPilotReadinessReportV1(
            pilotPort({ findCashOrders: async () => [] }),
            boundedPopulationPort(drivers), ingestionPort(), linkReader({ d0000: PARK }), NOW,
        )
        expect(report.counts.populationTruncated).toBe(true)
        expect(report.pilotCandidateReady).toBe(true)
        // Existential: one hit proves it however much was left unread.
        expect(report.pilotCandidateProofComplete).toBe(true)
        // But the input gate found nothing in a truncated scan, so it is unproven.
        expect(report.pilotInputReady).toBe(false)
        expect(report.pilotInputProofComplete).toBe(false)
        expect(report.proofIncompleteReason).toBe('population_truncated_proof_incomplete')
    })

    it('10. a truncated population with a candidate but no input leaves input unproven', async () => {
        const drivers = [
            eligible(0),
            ...Array.from({ length: PILOT_READINESS_POPULATION_LIMIT_V1 }, (_, i) => notSelfEmployed(i)),
        ]
        const report = await compensationPilotReadinessReportV1(
            pilotPort({ findCashOrders: async () => [], findBudgetPeriod: async () => null }),
            boundedPopulationPort(drivers), ingestionPort(), linkReader({ d0000: PARK }), NOW,
        )
        expect(report.counts.populationTruncated).toBe(true)
        expect(report.pilotInputReady).toBe(false)
        expect(report.pilotInputProofComplete).toBe(false)
        expect(report.proofIncompleteReason).toBe('population_truncated_proof_incomplete')
    })

    it('11. a truncated population that DID find a ready input proves both gates', async () => {
        const drivers = [
            eligible(0),
            ...Array.from({ length: PILOT_READINESS_POPULATION_LIMIT_V1 }, (_, i) => notSelfEmployed(i)),
        ]
        const report = await compensationPilotReadinessReportV1(
            pilotPort({ findCashOrders: async () => [orderFor('d0000')] }),
            boundedPopulationPort(drivers), ingestionPort(), linkReader({ d0000: PARK }), NOW,
        )
        expect(report.counts.populationTruncated).toBe(true)
        expect(report.pilotCandidateReady).toBe(true)
        expect(report.pilotInputReady).toBe(true)
        expect(report.pilotCandidateProofComplete).toBe(true)
        expect(report.pilotInputProofComplete).toBe(true)
        expect(report.proofIncompleteReason).toBeNull()
    })
})

describe('the Telegram read stays complete above the owner contract cap', () => {
    /** The published contract accepts at most 500 ids in one query. */
    const OWNER_CAP = 500

    async function askedIds(count: number) {
        const drivers = Array.from({ length: count }, (_, i) => eligible(i))
        const batches: string[][] = []
        const report = await compensationPilotReadinessReportV1(
            pilotPort(),
            populationPort(drivers),
            ingestionPort(),
            async (driverIds) => {
                batches.push([...driverIds])
                return []
            },
            NOW,
        )
        return { drivers, batches, report }
    }

    it('12. asks about all 500 candidates, in batches inside the owner cap', async () => {
        const { drivers, batches } = await askedIds(500)
        const asked = batches.flat()
        expect(asked).toEqual(drivers.map((d) => d.driverId))
        expect(new Set(asked).size).toBe(500)
        expect(batches.every((b) => b.length <= OWNER_CAP)).toBe(true)
        expect(batches.map((b) => b.length)).toEqual([100, 100, 100, 100, 100])
    })

    it('13. asks about all 501 candidates, omitting none', async () => {
        const { drivers, batches } = await askedIds(501)
        const asked = batches.flat()
        // Completeness is the invariant: every prescreened driver is asked about
        // exactly once, so absence from the answer can only mean "no link".
        expect(asked).toEqual(drivers.map((d) => d.driverId))
        expect(new Set(asked).size).toBe(501)
        expect(batches.map((b) => b.length)).toEqual([100, 100, 100, 100, 100, 1])
        expect(batches.every((b) => b.length <= OWNER_CAP)).toBe(true)
    })

    it('14. finds a candidate whose only usable link sits past the 500th driver', async () => {
        const drivers = Array.from({ length: 501 }, (_, i) => eligible(i))
        const last = drivers[500].driverId
        expect(last).toBe('d0500')
        const report = await compensationPilotReadinessReportV1(
            pilotPort({ findCashOrders: async () => [] }),
            populationPort(drivers),
            ingestionPort(),
            // Only the 501st driver has a link, and it is on the right park.
            linkReader({ [last]: PARK }),
            NOW,
        )
        expect(report.counts.factsGatePassed).toBe(501)
        expect(report.pilotCandidateReady).toBe(true)
        expect(report.counts.candidateReady).toBe(1)
        expect(report.candidates[0]).toMatchObject({ driverId: last, pilotCandidateReady: true })
        expect(report.counts.populationTruncated).toBe(false)
        expect(report.pilotCandidateProofComplete).toBe(true)
    })
})
