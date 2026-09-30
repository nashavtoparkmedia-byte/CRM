/**
 * The pilot readiness acceptance matrix.
 *
 * Each case is a fact that must be able to fail on its own, because the whole
 * point of the proof is that it tells an operator which one is missing. The two
 * gates are exercised separately, and the boundary the product actually cares
 * about — 45 < age <= 60 minutes, stale for an order check but still fresh for a
 * submission — is asserted rather than assumed.
 */

import { describe, expect, it } from 'vitest'

import { KOPECKS_PER_RUBLE, MAX_COMPENSATION_KOPECKS } from './compensation-money'
import { PILOT_FRESHNESS_V1, type PilotCatalogueOrderV1 } from './compensation-pilot-selection'
import {
    pilotCandidateFactsGateV1,
    pilotCandidateGateV1,
    pilotInputGateV1,
    type PilotCandidateDriverV1,
    type PilotCandidateIdentityReadV1,
    type PilotCandidateV1,
    type PilotInputReadV1,
} from './compensation-pilot-readiness'
import {
    admitPilotContactLineageV1,
    type PilotContactLineageReadV1,
} from './compensation-pilot-lineage'
import {
    resolvePilotIdentityV1,
    type CompensationPilotPortV1,
} from './compensation-pilot-service'

const PARK = 'ext-park-yoko'
const OTHER_PARK = 'ext-park-other'
const PROFILE = 'driver-profile-1'
const OTHER_PROFILE = 'driver-profile-2'
const DRIVER = 'driver-1'
const CONTACT = 'contact-1'
const PILOT_PARKS = [PARK]

/** Hired mid-September; "now" sits inside that same Yekaterinburg month. */
const HIRE_DATE = new Date('2026-09-10T08:00:00.000Z')
const NOW = new Date('2026-09-20T12:00:00.000Z')
const FIRST_MONTH_KEY = '2026-09'
const MINUTE = 60_000

const driver = (overrides: Partial<PilotCandidateDriverV1> = {}): PilotCandidateDriverV1 => ({
    driverId: DRIVER,
    contactId: CONTACT,
    externalParkId: PARK,
    externalDriverProfileId: PROFILE,
    facts: { isSelfEmployed: true, employmentType: 'selfemployed', parkHireDate: HIRE_DATE },
    ...overrides,
})

const identity = (overrides: Partial<PilotCandidateIdentityReadV1> = {}): PilotCandidateIdentityReadV1 => ({
    telegramLink: { activeParkId: PARK },
    mainDriverConfirmation: 'confirmed',
    lineage: { status: 'resolved', canonicalContactId: CONTACT, contactIds: [CONTACT] },
    ...overrides,
})

function prescreen(overrides: Partial<PilotCandidateDriverV1> = {}) {
    const gate = pilotCandidateFactsGateV1(driver(overrides), PILOT_PARKS, NOW)
    if (!gate.passed) throw new Error(`expected prescreen to pass, got ${gate.reason}`)
    return gate
}

function candidate(): PilotCandidateV1 {
    const gate = pilotCandidateGateV1(prescreen(), identity())
    if (!gate.ready) throw new Error(`expected candidate gate to pass, got ${gate.reason}`)
    return gate.candidate
}

const order = (overrides: Partial<PilotCatalogueOrderV1> = {}): PilotCatalogueOrderV1 => ({
    id: 'order-row-1',
    provider: 'yandex_fleet',
    externalParkId: PARK,
    externalOrderId: 'ext-order-1',
    shortOrderIdDisplay: '1234',
    externalDriverProfileId: PROFILE,
    rawPrice: '500',
    amountKopecks: 50_000,
    endedAt: new Date('2026-09-19T10:00:00.000Z'),
    observedAt: new Date(NOW.getTime() - 30 * MINUTE),
    providerBookedAt: null,
    ...overrides,
})

const input = (overrides: Partial<PilotInputReadV1> = {}): PilotInputReadV1 => ({
    parkAuthority: 'authoritative',
    catalogueStatus: 'ready',
    dbNow: NOW,
    orders: [order()],
    claimedOrderIds: [],
    budgetPeriod: { limitKopecks: MAX_COMPENSATION_KOPECKS, reservedKopecks: 0, settledKopecks: 0 },
    ...overrides,
})

describe('Gate 1: PILOT CANDIDATE READY', () => {
    it('1. refuses when the Yandex facts were never populated', () => {
        const gate = pilotCandidateFactsGateV1(
            driver({
                externalDriverProfileId: null,
                facts: { isSelfEmployed: null, employmentType: null, parkHireDate: null },
            }),
            PILOT_PARKS,
            NOW,
        )
        expect(gate.passed).toBe(false)
        expect(gate.passed === false && gate.reason).toBe('driver_profile_id_missing')
    })

    it('2. refuses a driver in a park outside the pilot scope', () => {
        const gate = pilotCandidateFactsGateV1(driver({ externalParkId: OTHER_PARK }), PILOT_PARKS, NOW)
        expect(gate.passed === false && gate.reason).toBe('pilot_park_out_of_scope')
    })

    it('2b. refuses a driver with no park at all', () => {
        const gate = pilotCandidateFactsGateV1(driver({ externalParkId: null }), PILOT_PARKS, NOW)
        expect(gate.passed === false && gate.reason).toBe('pilot_park_out_of_scope')
    })

    it('3. refuses when isSelfEmployed is null: unknown is never a yes', () => {
        const gate = pilotCandidateFactsGateV1(
            driver({ facts: { isSelfEmployed: null, employmentType: 'selfemployed', parkHireDate: HIRE_DATE } }),
            PILOT_PARKS,
            NOW,
        )
        expect(gate.passed === false && gate.reason).toBe('self_employment_unknown')
    })

    it('4. refuses when isSelfEmployed is false', () => {
        const gate = pilotCandidateFactsGateV1(
            driver({ facts: { isSelfEmployed: false, employmentType: 'selfemployed', parkHireDate: HIRE_DATE } }),
            PILOT_PARKS,
            NOW,
        )
        expect(gate.passed === false && gate.reason).toBe('not_self_employed')
    })

    it('5. keeps the boolean decisive when employmentType says selfemployed', () => {
        for (const isSelfEmployed of [null, false] as const) {
            const gate = pilotCandidateFactsGateV1(
                driver({ facts: { isSelfEmployed, employmentType: 'selfemployed', parkHireDate: HIRE_DATE } }),
                PILOT_PARKS,
                NOW,
            )
            expect(gate.passed).toBe(false)
        }
        // And an entrepreneur with the boolean set is admitted on the boolean,
        // exactly as the eligibility authority already decides it.
        expect(pilotCandidateFactsGateV1(
            driver({ facts: { isSelfEmployed: true, employmentType: 'individual_entrepreneur', parkHireDate: HIRE_DATE } }),
            PILOT_PARKS,
            NOW,
        ).passed).toBe(true)
    })

    it('6. refuses a missing hire date', () => {
        const gate = pilotCandidateFactsGateV1(
            driver({ facts: { isSelfEmployed: true, employmentType: 'selfemployed', parkHireDate: null } }),
            PILOT_PARKS,
            NOW,
        )
        expect(gate.passed === false && gate.reason).toBe('hire_date_unknown')
    })

    it('7. refuses outside the first calendar month, and still reports the month', () => {
        const gate = pilotCandidateFactsGateV1(driver(), PILOT_PARKS, new Date('2026-10-05T12:00:00.000Z'))
        expect(gate.passed === false && gate.reason).toBe('outside_first_calendar_month')
        expect(gate.passed === false && gate.firstMonthKey).toBe(FIRST_MONTH_KEY)
    })

    it('8. refuses an eligible driver with no Telegram link', () => {
        const gate = pilotCandidateGateV1(prescreen(), identity({ telegramLink: null }))
        expect(gate.ready === false && gate.reason).toBe('telegram_link_missing')
    })

    it('9. refuses a link whose activeParkId is null', () => {
        const gate = pilotCandidateGateV1(prescreen(), identity({ telegramLink: { activeParkId: null } }))
        expect(gate.ready === false && gate.reason).toBe('telegram_park_missing')
    })

    it('10. refuses a link on a different park', () => {
        const gate = pilotCandidateGateV1(prescreen(), identity({ telegramLink: { activeParkId: OTHER_PARK } }))
        expect(gate.ready === false && gate.reason).toBe('telegram_park_mismatch')
    })

    it('11. refuses when Contacts does not confirm the main driver', () => {
        const gate = pilotCandidateGateV1(prescreen(), identity({ mainDriverConfirmation: 'not_confirmed' }))
        expect(gate.ready === false && gate.reason).toBe('contact_not_confirmed')
    })

    it('12. fails closed on a held Contacts fence and on an unresolved lineage', () => {
        expect(pilotCandidateGateV1(prescreen(), identity({ mainDriverConfirmation: 'busy' })))
            .toMatchObject({ ready: false, reason: 'contact_busy' })
        expect(pilotCandidateGateV1(prescreen(), identity({ lineage: { status: 'unresolvable' } })))
            .toMatchObject({ ready: false, reason: 'contact_lineage_unresolvable' })
        expect(pilotCandidateGateV1(prescreen(), identity({ lineage: { status: 'missing' } })))
            .toMatchObject({ ready: false, reason: 'contact_lineage_missing' })
        // Resolved, but not to this contact alone.
        expect(pilotCandidateGateV1(prescreen(), identity({
            lineage: { status: 'resolved', canonicalContactId: CONTACT, contactIds: [CONTACT, 'contact-2'] },
        }))).toMatchObject({ ready: false, reason: 'contact_lineage_ambiguous' })
        expect(pilotCandidateGateV1(prescreen(), identity({
            lineage: { status: 'resolved', canonicalContactId: 'contact-9', contactIds: ['contact-9'] },
        }))).toMatchObject({ ready: false, reason: 'contact_lineage_ambiguous' })
    })

    it('12b. refuses a driver with no contact id before asking any other owner', () => {
        const gate = pilotCandidateFactsGateV1(driver({ contactId: null }), PILOT_PARKS, NOW)
        expect(gate.passed === false && gate.reason).toBe('contact_missing')
    })

    it('13. is ready on the Gate-1 facts alone, with no budget, mode, catalogue or order', () => {
        const gate = pilotCandidateGateV1(prescreen(), identity())
        expect(gate.ready).toBe(true)
        expect(gate.ready === true && gate.candidate).toMatchObject({
            driverId: DRIVER,
            externalParkId: PARK,
            externalDriverProfileId: PROFILE,
            canonicalContactId: CONTACT,
            lineage: [CONTACT],
            firstMonthKey: FIRST_MONTH_KEY,
        })
    })
})

describe('Gate 2: PILOT INPUT READY', () => {
    it('14. a ready candidate with ingestion off is candidate-ready and input-refused', () => {
        const gate = pilotInputGateV1(candidate(), input({ catalogueStatus: 'disabled' }), NOW)
        expect(gate.ready === false && gate.reason).toBe('catalogue_disabled')
    })

    it('15. refuses a partial catalogue', () => {
        expect(pilotInputGateV1(candidate(), input({ catalogueStatus: 'partial' }), NOW))
            .toMatchObject({ ready: false, reason: 'catalogue_partial' })
    })

    it('16. refuses a stale catalogue', () => {
        expect(pilotInputGateV1(candidate(), input({ catalogueStatus: 'stale' }), NOW))
            .toMatchObject({ ready: false, reason: 'catalogue_stale' })
    })

    it('17. distinguishes a ready-but-empty catalogue from an unavailable one', () => {
        const gate = pilotInputGateV1(candidate(), input({ orders: [] }), NOW)
        expect(gate.ready === false && gate.reason).toBe('no_cash_orders')
        expect(gate.counts.catalogueOrderCount).toBe(0)
    })

    it('17b. refuses a failed park authority before anything about orders', () => {
        expect(pilotInputGateV1(candidate(), input({ parkAuthority: 'failed', orders: [] }), NOW))
            .toMatchObject({ ready: false, reason: 'park_authority_failed' })
    })

    it('18. never counts an order from another park', () => {
        const gate = pilotInputGateV1(
            candidate(),
            input({ orders: [order({ externalParkId: OTHER_PARK, externalOrderId: 'ext-order-other-park' })] }),
            NOW,
        )
        expect(gate.counts.catalogueOrderCount).toBe(0)
        expect(gate.ready === false && gate.reason).toBe('no_cash_orders')
    })

    it('19. never counts an order from another driver profile', () => {
        const gate = pilotInputGateV1(
            candidate(),
            input({ orders: [order({ externalDriverProfileId: OTHER_PROFILE, externalOrderId: 'ext-order-other-profile' })] }),
            NOW,
        )
        expect(gate.counts.catalogueOrderCount).toBe(0)
        expect(gate.ready === false && gate.reason).toBe('no_cash_orders')
    })

    it('19b. never counts an order outside the first calendar month', () => {
        const gate = pilotInputGateV1(
            candidate(),
            input({ orders: [order({ endedAt: new Date('2026-08-20T10:00:00.000Z') })] }),
            NOW,
        )
        expect(gate.counts.catalogueOrderCount).toBe(0)
    })

    it('20. an order aged at most 45 minutes is fresh for submission', () => {
        const observedAt = new Date(NOW.getTime() - PILOT_FRESHNESS_V1.ORDER_CHECK_MAX_AGE_MS)
        const gate = pilotInputGateV1(candidate(), input({ orders: [order({ observedAt })] }), NOW)
        expect(gate.ready).toBe(true)
        expect(gate.counts.freshOrderCount).toBe(1)
    })

    it('21. an order aged over 45 and up to 60 minutes is still fresh for submission', () => {
        for (const ageMs of [
            PILOT_FRESHNESS_V1.ORDER_CHECK_MAX_AGE_MS + MINUTE,
            PILOT_FRESHNESS_V1.SUBMISSION_MAX_AGE_MS,
        ]) {
            const gate = pilotInputGateV1(
                candidate(),
                input({ orders: [order({ observedAt: new Date(NOW.getTime() - ageMs) })] }),
                NOW,
            )
            expect(gate.ready).toBe(true)
            expect(gate.counts.freshOrderCount).toBe(1)
        }
    })

    it('22. an order older than the submission threshold is not a ready input', () => {
        const observedAt = new Date(NOW.getTime() - (PILOT_FRESHNESS_V1.SUBMISSION_MAX_AGE_MS + MINUTE))
        const gate = pilotInputGateV1(candidate(), input({ orders: [order({ observedAt })] }), NOW)
        expect(gate.ready === false && gate.reason).toBe('no_fresh_submission_orders')
        expect(gate.counts.catalogueOrderCount).toBe(1)
        expect(gate.counts.freshOrderCount).toBe(0)
    })

    it('23. a claimed fresh order does not count, unless another usable one exists', () => {
        const claimed = pilotInputGateV1(candidate(), input({ claimedOrderIds: ['ext-order-1'] }), NOW)
        expect(claimed.ready === false && claimed.reason).toBe('all_fresh_orders_claimed')
        expect(claimed.counts.freshUnclaimedOrderCount).toBe(0)

        const withSpare = pilotInputGateV1(
            candidate(),
            input({
                orders: [order(), order({ id: 'order-row-2', externalOrderId: 'ext-order-2' })],
                claimedOrderIds: ['ext-order-1'],
            }),
            NOW,
        )
        expect(withSpare.ready).toBe(true)
        expect(withSpare.counts.freshUnclaimedOrderCount).toBe(1)
    })

    it('24. a missing budget period is reported as missing, not as exhausted', () => {
        const gate = pilotInputGateV1(candidate(), input({ budgetPeriod: null }), NOW)
        expect(gate.ready === false && gate.reason).toBe('budget_period_missing')
        expect(gate.counts.remainingBudgetKopecks).toBe(0)
    })

    it('25. refuses when the remaining budget cannot cover even the smallest claim', () => {
        const gate = pilotInputGateV1(
            candidate(),
            input({
                budgetPeriod: {
                    limitKopecks: MAX_COMPENSATION_KOPECKS,
                    reservedKopecks: MAX_COMPENSATION_KOPECKS - (KOPECKS_PER_RUBLE - 1),
                    settledKopecks: 0,
                },
            }),
            NOW,
        )
        expect(gate.ready === false && gate.reason).toBe('budget_exhausted_or_insufficient')
        expect(gate.counts.remainingBudgetKopecks).toBe(KOPECKS_PER_RUBLE - 1)
        expect(gate.counts.freshUnclaimedOrderCount).toBe(1)
    })

    it('25b. one ruble of headroom is enough, because one ruble is a valid claim', () => {
        const gate = pilotInputGateV1(
            candidate(),
            input({
                budgetPeriod: {
                    limitKopecks: MAX_COMPENSATION_KOPECKS,
                    reservedKopecks: MAX_COMPENSATION_KOPECKS - KOPECKS_PER_RUBLE,
                    settledKopecks: 0,
                },
            }),
            NOW,
        )
        expect(gate.ready).toBe(true)
        expect(gate.counts.claimableOrderCount).toBe(1)
    })

    it('26. is ready with authoritative park, ready catalogue, a fresh unclaimed order and budget', () => {
        const gate = pilotInputGateV1(candidate(), input(), NOW)
        expect(gate.ready).toBe(true)
        expect(gate.counts).toMatchObject({
            catalogueOrderCount: 1,
            freshOrderCount: 1,
            freshUnclaimedOrderCount: 1,
            claimableOrderCount: 1,
            remainingBudgetKopecks: MAX_COMPENSATION_KOPECKS,
        })
    })

    it('27. an unrelated eligible driver and an unrelated fresh order never combine', () => {
        // Everything is present, but nothing belongs to this candidate's scope.
        const gate = pilotInputGateV1(
            candidate(),
            input({
                orders: [
                    order({ externalParkId: OTHER_PARK, externalOrderId: 'other-park-order' }),
                    order({ externalDriverProfileId: OTHER_PROFILE, externalOrderId: 'other-profile-order' }),
                ],
            }),
            NOW,
        )
        expect(gate.ready).toBe(false)
        expect(gate.counts.catalogueOrderCount).toBe(0)
    })
})

/**
 * The rule that decides which contact lineage may be bound as one monetary
 * person lives in exactly one place, and both surfaces ask it.
 *
 * The danger a shared rule removes is one-sided drift: readiness reporting a
 * driver as PILOT CANDIDATE READY whom the Telegram submission path then
 * refuses. So the table below drives the SAME lineage read through both paths
 * and asserts they always agree on admission, while each keeps its own words
 * for the refusal.
 */
describe('one shared lineage admission rule', () => {
    const OTHER = 'contact-survivor'

    /** Every shape Contacts can present, and what the shared rule makes of it. */
    const LINEAGES: Array<{
        name: string
        read: PilotContactLineageReadV1
        admitted: boolean
        /** The refusal the live monetary path returned before the rule was shared. */
        live: 'identity_not_proven' | 'identity_needs_review' | null
        readiness: string | null
    }> = [
        {
            name: 'a singleton lineage that is its own canonical contact',
            read: { status: 'resolved', canonicalContactId: CONTACT, contactIds: [CONTACT] },
            admitted: true, live: null, readiness: null,
        },
        {
            name: 'a contact merged away into another canonical contact',
            read: { status: 'resolved', canonicalContactId: OTHER, contactIds: [OTHER, CONTACT] },
            admitted: false, live: 'identity_not_proven', readiness: 'contact_lineage_ambiguous',
        },
        {
            name: 'a canonical contact joined with others into one person',
            read: { status: 'resolved', canonicalContactId: CONTACT, contactIds: [CONTACT, 'contact-merged-away'] },
            admitted: false, live: 'identity_needs_review', readiness: 'contact_lineage_ambiguous',
        },
        {
            name: 'a contact Contacts cannot find',
            read: { status: 'missing' },
            admitted: false, live: 'identity_not_proven', readiness: 'contact_lineage_missing',
        },
        {
            name: 'a lineage Contacts cannot walk to one canonical contact',
            read: { status: 'unresolvable' },
            admitted: false, live: 'identity_needs_review', readiness: 'contact_lineage_unresolvable',
        },
    ]

    function livePort(read: PilotContactLineageReadV1): CompensationPilotPortV1 {
        const forbidden = (name: string) => () => {
            throw new Error(`the identity path must not call ${name}`)
        }
        return {
            confirmMainDriver: async () => 'confirmed',
            resolveContactLineage: async () => read,
            findDriverFacts: async () => ({
                externalParkId: PARK,
                externalDriverProfileId: PROFILE,
                facts: { isSelfEmployed: true, employmentType: 'selfemployed', parkHireDate: HIRE_DATE },
            }),
            findCashOrders: forbidden('findCashOrders') as never,
            findBudgetPeriod: forbidden('findBudgetPeriod') as never,
            findClaimedOrderIds: forbidden('findClaimedOrderIds') as never,
            findDriverApplications: forbidden('findDriverApplications') as never,
            submitApplication: forbidden('submitApplication') as never,
        }
    }

    for (const entry of LINEAGES) {
        it(`agrees on ${entry.name}`, async () => {
            // 1. the shared rule
            const admission = admitPilotContactLineageV1(CONTACT, entry.read)
            expect(admission.admitted).toBe(entry.admitted)

            // 2. readiness, which maps the rule onto its own reason codes
            const readiness = pilotCandidateGateV1(prescreen(), identity({ lineage: entry.read }))
            expect(readiness.ready).toBe(entry.admitted)
            if (!readiness.ready) expect(readiness.reason).toBe(entry.readiness)

            // 3. the live monetary path, which maps it onto its refusals
            const live = await resolvePilotIdentityV1(
                { telegramUserId: '777', driverId: DRIVER, contactId: CONTACT, selectedExternalParkId: PARK },
                livePort(entry.read),
            )
            expect(live.proven).toBe(entry.admitted)
            if (!live.proven) expect(live.refusal).toBe(entry.live)

            // 4. and they never disagree about admission itself
            expect(readiness.ready).toBe(live.proven)
        })
    }

    it('admits only a singleton: merged monetary identities stay out of this pilot', () => {
        expect(admitPilotContactLineageV1(CONTACT, {
            status: 'resolved', canonicalContactId: CONTACT, contactIds: [CONTACT, 'b', 'c'],
        })).toEqual({ admitted: false, refusal: 'lineage_not_singleton' })
        expect(admitPilotContactLineageV1(CONTACT, {
            status: 'resolved', canonicalContactId: 'a', contactIds: ['a', CONTACT],
        })).toEqual({ admitted: false, refusal: 'lineage_not_canonical' })
    })

    it('hands back exactly the admitted lineage, so no caller rebuilds one', () => {
        const read: PilotContactLineageReadV1 = {
            status: 'resolved', canonicalContactId: CONTACT, contactIds: [CONTACT],
        }
        const admission = admitPilotContactLineageV1(CONTACT, read)
        expect(admission).toEqual({ admitted: true, canonicalContactId: CONTACT, lineage: [CONTACT] })

        // Gate 1 carries the admitted proof through, it does not reconstruct it.
        const gate = pilotCandidateGateV1(prescreen(), identity({ lineage: read }))
        expect(gate.ready === true && gate.candidate.canonicalContactId).toBe(CONTACT)
        expect(gate.ready === true && gate.candidate.lineage).toEqual([CONTACT])
    })
})
