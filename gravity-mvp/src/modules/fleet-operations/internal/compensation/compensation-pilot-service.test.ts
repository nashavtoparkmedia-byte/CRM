import { describe, expect, it, vi } from 'vitest'

import type { PilotCatalogueFactsV1, PilotCatalogueOrderV1 } from './compensation-pilot-selection'
import {
    DRIVER_FACTS_FRESHNESS_V1,
    DriverFactsRefresherV1,
    checkPilotOrderV1,
    compensationSectionViewV1,
    requestPilotRefreshV1,
    resolvePilotIdentityV1,
    submitPilotApplicationV1,
    withOwnerPilotAdmissionPortV1,
    type CompensationPilotIngestionPortV1,
    type CompensationPilotPortV1,
    type DriverFactsRefreshResultV1,
    type DriverFactsRefreshTargetV1,
    type PilotDriverFactsV1,
    type PilotTelegramPersonProofV1,
} from './compensation-pilot-service'
import { pilotScopeKeyV1 } from './compensation-pilot-selection'
import { compensationSubmissionWindowV1 } from './compensation-submission-window'

const NOW = new Date('2026-09-20T09:00:00.000Z')
const PARK = 'park-1'
const PROFILE = 'b'.repeat(32)
const CONTACT = 'contact-1'
const DRIVER = 'driver-1'

const PROOF: PilotTelegramPersonProofV1 = {
    telegramUserId: '777', driverId: DRIVER, contactId: CONTACT, selectedExternalParkId: PARK,
}
const SCOPE_KEY = pilotScopeKeyV1({ driverId: DRIVER, externalParkId: PARK, externalDriverProfileId: PROFILE })
const MINUTE = 60_000
/** Database clock of every read in these tests. */
const DB_NOW = new Date('2026-09-20T08:59:00.000Z')

const ORDER: PilotCatalogueOrderV1 = {
    id: 'row-1',
    provider: 'yandex_fleet',
    externalParkId: PARK,
    externalOrderId: 'a'.repeat(32),
    shortOrderIdDisplay: '3982091',
    externalDriverProfileId: PROFILE,
    rawPrice: '335.0000',
    amountKopecks: 33_500,
    endedAt: new Date('2026-09-12T10:00:00.000Z'),
    observedAt: new Date(DB_NOW.getTime() - 5 * MINUTE),
    providerBookedAt: new Date('2026-09-12T09:30:00.000Z'),
}

const ELIGIBLE_DRIVER: PilotDriverFactsV1 = {
    externalParkId: PARK,
    externalDriverProfileId: PROFILE,
    facts: {
        isSelfEmployed: true,
        employmentType: 'selfemployed',
        parkHireDate: new Date('2026-09-02T06:00:00.000Z'),
    },
}

function port(overrides: Partial<CompensationPilotPortV1> = {}): CompensationPilotPortV1 {
    return {
        confirmMainDriver: vi.fn(async () => 'confirmed' as const),
        resolveContactLineage: vi.fn(async () => ({
            status: 'resolved' as const, canonicalContactId: CONTACT, contactIds: [CONTACT],
        })),
        findDriverFacts: vi.fn(async () => ELIGIBLE_DRIVER),
        findCashOrders: vi.fn(async () => [ORDER]),
        findBudgetPeriod: vi.fn(async () => ({ limitKopecks: 500_000, reservedKopecks: 0, settledKopecks: 0 })),
        findClaimedOrderIds: vi.fn(async () => []),
        findDriverApplications: vi.fn(async () => []),
        submitApplication: vi.fn(async () => ({ applicationId: 'app-1', amountKopecks: 30_000, status: 'created' as const })),
        ...overrides,
    }
}

const READY_FACTS: PilotCatalogueFactsV1 = {
    mode: 'write',
    parkEnabled: true,
    dbNow: DB_NOW,
    lastHotSuccessAt: new Date(DB_NOW.getTime() - 2 * MINUTE),
    reconciliationPassStartedAt: new Date(DB_NOW.getTime() - 60 * MINUTE),
    reconciliationFloorBookedAt: null,
    reconciliationCursorBookedAt: null,
    lastReconciliationCompletedAt: new Date(DB_NOW.getTime() - 30 * MINUTE),
}

function ingestion(overrides: Partial<CompensationPilotIngestionPortV1> = {}): CompensationPilotIngestionPortV1 {
    return {
        readCatalogueFacts: vi.fn(async () => READY_FACTS),
        requestHotRefresh: vi.fn(async () => ({ status: 'scheduled' as const, reason: null })),
        requestOrderConfirmation: vi.fn(async () => ({ status: 'scheduled' as const, reason: null })),
        readOrderConfirmation: vi.fn(async () => ({
            state: 'undetermined' as const, startedAt: null, endedAt: null, code: null,
        })),
        ...overrides,
    }
}

const SUBMIT = {
    ...PROOF,
    externalOrderId: ORDER.externalOrderId,
    claimedRubles: 300,
    supportConfirmed: true,
    attachmentFileId: 'tg-file-1',
    attachmentKind: 'photo',
    idempotencyKey: 'key-1',
    scopeKey: SCOPE_KEY,
}

describe('the compensation section a driver sees', () => {
    it('lists eligible orders with the remaining monthly budget', async () => {
        const view = await compensationSectionViewV1(PROOF, port(), ingestion(), NOW)
        expect(view).toMatchObject({
            available: true,
            firstMonthKey: '2026-09',
            remainingBudgetKopecks: 500_000,
        })
        expect(view.available && view.orders).toHaveLength(1)
    })

    it('tells an unproven person it is unlinked rather than showing an empty list', async () => {
        const p = port({ confirmMainDriver: vi.fn(async () => 'not_confirmed' as const) })
        const view = await compensationSectionViewV1(PROOF, p, ingestion(), NOW)
        expect(view).toEqual({ available: false, reason: 'identity_not_proven', applications: [] })
        expect(p.findDriverFacts).not.toHaveBeenCalled()
        expect(p.findDriverApplications).not.toHaveBeenCalled()
    })

    it('names the eligibility reason when the driver is not park-SMZ', async () => {
        const view = await compensationSectionViewV1(PROOF, port({
            findDriverFacts: vi.fn(async () => ({
                ...ELIGIBLE_DRIVER,
                facts: { isSelfEmployed: false, employmentType: 'park_employee', parkHireDate: new Date('2026-09-02T06:00:00.000Z') },
            })),
        }), ingestion(), NOW)
        expect(view).toMatchObject({ available: false, reason: 'not_self_employed' })
    })

    it('still shows past applications to a driver who is no longer eligible', async () => {
        const view = await compensationSectionViewV1(PROOF, port({
            findDriverFacts: vi.fn(async () => ({
                ...ELIGIBLE_DRIVER,
                facts: { isSelfEmployed: null, employmentType: null, parkHireDate: null },
            })),
            findDriverApplications: vi.fn(async () => [{
                applicationId: 'app-0', status: 'paid' as const, externalOrderId: 'x',
                shortOrderIdDisplay: null, claimedKopecks: 100, amountKopecks: 100,
                verifiedKopecks: 100, submittedAt: NOW, rejectionReason: null,
            }]),
        }), ingestion(), NOW)
        expect(view.available).toBe(false)
        expect(view.applications).toHaveLength(1)
    })

    it('reports zero budget rather than failing when the period is missing', async () => {
        const view = await compensationSectionViewV1(PROOF, port({
            findBudgetPeriod: vi.fn(async () => null),
        }), ingestion(), NOW)
        expect(view).toMatchObject({ available: true, remainingBudgetKopecks: 0 })
    })
})

describe('submitting from the bot', () => {
    it('submits a complete claim through C1', async () => {
        const p = port()
        const outcome = await submitPilotApplicationV1(SUBMIT, p, ingestion(), NOW)

        expect(outcome).toMatchObject({ submitted: true, applicationId: 'app-1', amountKopecks: 30_000 })
        expect(p.submitApplication).toHaveBeenCalledTimes(1)
        expect(p.submitApplication).toHaveBeenCalledWith(expect.objectContaining({
            canonicalContactId: CONTACT,
            lineage: [CONTACT],
            telegramUserId: '777',
        }))
        expect(p.findClaimedOrderIds).toHaveBeenCalledWith([CONTACT])
    })

    it('resolves the person once, so the claim check and the submit see the same lineage', async () => {
        const p = port()
        await submitPilotApplicationV1(SUBMIT, p, ingestion(), NOW)
        expect(p.confirmMainDriver).toHaveBeenCalledTimes(1)
        expect(p.resolveContactLineage).toHaveBeenCalledTimes(1)
        expect(p.findDriverFacts).toHaveBeenCalledTimes(1)
    })

    it('passes a monetary-core refusal to the driver instead of failing the request', async () => {
        const p = port({ submitApplication: vi.fn(async () => ({ refusal: 'active_pending_exists' })) })
        const outcome = await submitPilotApplicationV1(SUBMIT, p, ingestion(), NOW)
        expect(outcome).toEqual({ submitted: false, refusal: 'active_pending_exists' })
    })

    it('never reaches C1 when the person cannot be proven', async () => {
        const p = port({ confirmMainDriver: vi.fn(async () => 'not_confirmed' as const) })
        const outcome = await submitPilotApplicationV1(SUBMIT, p, ingestion(), NOW)
        expect(outcome).toEqual({ submitted: false, refusal: 'identity_not_proven' })
        expect(p.findClaimedOrderIds).not.toHaveBeenCalled()
        expect(p.submitApplication).not.toHaveBeenCalled()
    })

    it('rejects above the monetary core\'s request bound without touching C1', async () => {
        const p = port()
        const outcome = await submitPilotApplicationV1({ ...SUBMIT, claimedRubles: 100_001 }, p, ingestion(), NOW)

        expect(outcome).toEqual({ submitted: false, refusal: 'claim_above_pilot_cap' })
        expect(p.submitApplication).not.toHaveBeenCalled()
    })

    it('hands a request above the 500 RUB cap to C1 unchanged, which pays the cap', async () => {
        const p = port()
        expect(await submitPilotApplicationV1({ ...SUBMIT, claimedRubles: 800 }, p, ingestion(), NOW))
            .toMatchObject({ submitted: true })
        expect(p.submitApplication).toHaveBeenCalledWith(expect.objectContaining({ claimedRubles: 800 }))
    })

    it('refuses without support confirmation or an attachment', async () => {
        const p = port()
        expect(await submitPilotApplicationV1({ ...SUBMIT, supportConfirmed: false }, p, ingestion(), NOW))
            .toEqual({ submitted: false, refusal: 'support_not_confirmed' })
        expect(await submitPilotApplicationV1({ ...SUBMIT, attachmentFileId: null }, p, ingestion(), NOW))
            .toEqual({ submitted: false, refusal: 'attachment_missing' })
        expect(p.submitApplication).not.toHaveBeenCalled()
    })

    it('refuses an order the freshly rebuilt catalogue no longer offers', async () => {
        // The conversation remembered an order; eligibility has since lapsed.
        const p = port({ findCashOrders: vi.fn(async () => []) })
        const outcome = await submitPilotApplicationV1(SUBMIT, p, ingestion(), NOW)
        expect(outcome).toEqual({ submitted: false, refusal: 'order_not_in_catalogue' })
    })

    it('refuses a second claim on an order already claimed', async () => {
        const p = port({ findClaimedOrderIds: vi.fn(async () => [ORDER.externalOrderId]) })
        const outcome = await submitPilotApplicationV1(SUBMIT, p, ingestion(), NOW)
        expect(outcome).toEqual({ submitted: false, refusal: 'order_already_claimed' })
    })
})

describe('proving the canonical person from the Telegram proof', () => {
    it('proves exactly the confirmed contact and reads eligibility from the proven Driver', async () => {
        const p = port()
        const resolved = await resolvePilotIdentityV1(PROOF, p)
        expect(resolved).toEqual({
            proven: true,
            identity: {
                telegramUserId: '777',
                canonicalContactId: CONTACT,
                lineage: [CONTACT],
                ...ELIGIBLE_DRIVER,
            },
        })
        expect(p.confirmMainDriver).toHaveBeenCalledWith(CONTACT, DRIVER)
        expect(p.resolveContactLineage).toHaveBeenCalledWith(CONTACT)
        expect(p.findDriverFacts).toHaveBeenCalledWith(DRIVER)
    })

    it('refuses a proof with a missing or padded identifier before asking Contacts', async () => {
        for (const broken of [
            { ...PROOF, telegramUserId: '' },
            { ...PROOF, driverId: ' driver-1' },
            { ...PROOF, contactId: '' },
        ]) {
            const p = port()
            expect(await resolvePilotIdentityV1(broken, p)).toEqual({ proven: false, refusal: 'identity_not_proven' })
            expect(p.confirmMainDriver).not.toHaveBeenCalled()
        }
    })

    it('answers a held Contacts fence as retryable, not as unlinked', async () => {
        const p = port({ confirmMainDriver: vi.fn(async () => 'busy' as const) })
        expect(await resolvePilotIdentityV1(PROOF, p)).toEqual({ proven: false, refusal: 'identity_busy' })
        expect(p.resolveContactLineage).not.toHaveBeenCalled()
    })

    it('refuses a contact that has been merged into another one since authority was proven', async () => {
        const p = port({
            resolveContactLineage: vi.fn(async () => ({
                status: 'resolved' as const, canonicalContactId: 'contact-survivor', contactIds: ['contact-survivor', CONTACT],
            })),
        })
        expect(await resolvePilotIdentityV1(PROOF, p)).toEqual({ proven: false, refusal: 'identity_not_proven' })
        expect(p.findDriverFacts).not.toHaveBeenCalled()
    })

    it('refuses to bind a lineage of several contacts instead of joining them to one monetary person', async () => {
        const p = port({
            resolveContactLineage: vi.fn(async () => ({
                status: 'resolved' as const, canonicalContactId: CONTACT, contactIds: [CONTACT, 'contact-merged-away'],
            })),
        })
        const outcome = await submitPilotApplicationV1(SUBMIT, p, ingestion(), NOW)
        expect(outcome).toEqual({ submitted: false, refusal: 'identity_needs_review' })
        expect(p.findDriverApplications).not.toHaveBeenCalled()
        expect(p.submitApplication).not.toHaveBeenCalled()
    })

    it('refuses a contact Contacts cannot find or cannot walk to one canonical contact', async () => {
        expect(await resolvePilotIdentityV1(PROOF, port({
            resolveContactLineage: vi.fn(async () => ({ status: 'missing' as const })),
        }))).toEqual({ proven: false, refusal: 'identity_not_proven' })
        expect(await resolvePilotIdentityV1(PROOF, port({
            resolveContactLineage: vi.fn(async () => ({ status: 'unresolvable' as const })),
        }))).toEqual({ proven: false, refusal: 'identity_needs_review' })
    })

    it('refuses when the proven Driver row is gone', async () => {
        expect(await resolvePilotIdentityV1(PROOF, port({ findDriverFacts: vi.fn(async () => null) })))
            .toEqual({ proven: false, refusal: 'identity_not_proven' })
    })
})

describe('the selected park scopes every Telegram request', () => {
    it('asks for a park before reading any catalogue when none is selected', async () => {
        const p = port()
        const i = ingestion()
        const view = await compensationSectionViewV1({ ...PROOF, selectedExternalParkId: null }, p, i, NOW)
        expect(view).toMatchObject({ available: false, reason: 'park_not_selected' })
        expect(p.findCashOrders).not.toHaveBeenCalled()
        expect(i.readCatalogueFacts).not.toHaveBeenCalled()
    })

    it('fails closed when the selected park is not the proven profile park', async () => {
        const p = port()
        const view = await compensationSectionViewV1({ ...PROOF, selectedExternalParkId: 'park-2' }, p, ingestion(), NOW)
        expect(view).toMatchObject({ available: false, reason: 'selected_park_profile_unproven' })
        expect(p.findCashOrders).not.toHaveBeenCalled()
        const outcome = await submitPilotApplicationV1({ ...SUBMIT, selectedExternalParkId: 'park-2' }, p, ingestion(), NOW)
        expect(outcome).toEqual({ submitted: false, refusal: 'selected_park_profile_unproven' })
        expect(p.submitApplication).not.toHaveBeenCalled()
    })

    it('reads the list from the local catalogue with no provider call', async () => {
        const i = ingestion()
        const view = await compensationSectionViewV1(PROOF, port(), i, NOW)
        expect(view).toMatchObject({
            available: true,
            scopeKey: SCOPE_KEY,
            externalParkId: PARK,
            catalogueStatus: 'ready',
            todayKey: '2026-09-20',
            search: null,
        })
        expect(view.available && view.orders[0]).toMatchObject({
            externalOrderId: ORDER.externalOrderId, dayKey: '2026-09-12', localTime: '15:00', claimed: false,
        })
        expect(i.readCatalogueFacts).toHaveBeenCalledTimes(1)
        expect(i.requestHotRefresh).not.toHaveBeenCalled()
        expect(i.requestOrderConfirmation).not.toHaveBeenCalled()
        expect(i.readOrderConfirmation).not.toHaveBeenCalled()
    })

    it('tells a park without a catalogue apart from an empty one', async () => {
        const disabled = await compensationSectionViewV1(PROOF, port(), ingestion({
            readCatalogueFacts: vi.fn(async () => ({ ...READY_FACTS, mode: 'dry_run' })),
        }), NOW)
        expect(disabled).toMatchObject({ available: false, reason: 'catalogue_disabled' })

        const empty = await compensationSectionViewV1(PROOF, port({ findCashOrders: vi.fn(async () => []) }), ingestion(), NOW)
        expect(empty).toMatchObject({ available: true, catalogueStatus: 'ready', orders: [] })
    })

    it('shows a partial or stale catalogue with its status rather than hiding it', async () => {
        const partial = await compensationSectionViewV1(PROOF, port(), ingestion({
            readCatalogueFacts: vi.fn(async () => ({ ...READY_FACTS, lastReconciliationCompletedAt: null })),
        }), NOW)
        expect(partial).toMatchObject({ available: true, catalogueStatus: 'partial' })
        const stale = await compensationSectionViewV1(PROOF, port(), ingestion({
            readCatalogueFacts: vi.fn(async () => ({ ...READY_FACTS, lastHotSuccessAt: null })),
        }), NOW)
        expect(stale).toMatchObject({ available: true, catalogueStatus: 'stale' })
    })

    it('marks an order a claim already holds', async () => {
        const view = await compensationSectionViewV1(PROOF, port({
            findClaimedOrderIds: vi.fn(async () => [ORDER.externalOrderId]),
        }), ingestion(), NOW)
        expect(view.available && view.orders[0].claimed).toBe(true)
    })

    it('answers a search with every candidate, never one chosen for the driver', async () => {
        const twin = { ...ORDER, id: 'row-2', externalOrderId: 'c'.repeat(32) }
        const view = await compensationSectionViewV1(PROOF, port({
            findCashOrders: vi.fn(async () => [ORDER, twin]),
        }), ingestion(), NOW, { search: '3982091' })
        expect(view.available && view.search).toMatchObject({ kind: 'number', truncated: false })
        expect(view.available && view.search?.matches.map((order) => order.externalOrderId))
            .toEqual([ORDER.externalOrderId, twin.externalOrderId])
    })
})

describe('checking the order a driver chose', () => {
    const check = (overrides: Partial<Parameters<typeof checkPilotOrderV1>[0]> = {}) => ({
        ...PROOF, externalOrderId: ORDER.externalOrderId, scopeKey: SCOPE_KEY, retry: false, ...overrides,
    })
    const stale = { ...ORDER, observedAt: new Date(DB_NOW.getTime() - 45 * MINUTE - 1) }

    it('lets a recently confirmed order through without asking Yandex', async () => {
        const i = ingestion()
        const outcome = await checkPilotOrderV1(check(), port(), i, NOW)
        expect(outcome).toMatchObject({ state: 'fresh', refusal: null, order: { externalOrderId: ORDER.externalOrderId } })
        expect(i.readOrderConfirmation).not.toHaveBeenCalled()
        expect(i.requestOrderConfirmation).not.toHaveBeenCalled()
    })

    it('schedules a targeted confirmation of an older order and lets the driver carry on', async () => {
        const i = ingestion()
        const outcome = await checkPilotOrderV1(check(), port({ findCashOrders: vi.fn(async () => [stale]) }), i, NOW)
        expect(outcome.state).toBe('checking')
        expect(i.requestOrderConfirmation).toHaveBeenCalledWith({
            externalParkId: PARK,
            dayKey: '2026-09-12',
            externalOrderId: ORDER.externalOrderId,
            providerBookedAt: ORDER.providerBookedAt,
            endedAt: ORDER.endedAt,
        })
    })

    it('joins a running confirmation instead of starting another', async () => {
        const i = ingestion({
            readOrderConfirmation: vi.fn(async () => ({ state: 'running' as const, startedAt: null, endedAt: null, code: null })),
        })
        const outcome = await checkPilotOrderV1(check(), port({ findCashOrders: vi.fn(async () => [stale]) }), i, NOW)
        expect(outcome.state).toBe('checking')
        expect(i.requestOrderConfirmation).not.toHaveBeenCalled()
    })

    it('reports a failed provider check as a failure the driver can retry, not as not confirmed', async () => {
        const failed = vi.fn(async () => ({
            state: 'failed' as const, startedAt: null, endedAt: new Date(DB_NOW.getTime() - MINUTE), code: 'provider_deferred',
        }))
        const i = ingestion({ readOrderConfirmation: failed })
        const p = port({ findCashOrders: vi.fn(async () => [stale]) })
        expect((await checkPilotOrderV1(check(), p, i, NOW)).state).toBe('check_failed')
        expect(i.requestOrderConfirmation).not.toHaveBeenCalled()
        expect((await checkPilotOrderV1(check({ retry: true }), p, i, NOW)).state).toBe('checking')
        expect(i.requestOrderConfirmation).toHaveBeenCalledTimes(1)
    })

    it('treats only a complete fallback that did not return the order as not confirmed', async () => {
        const i = ingestion({
            readOrderConfirmation: vi.fn(async () => ({
                state: 'not_returned' as const,
                startedAt: new Date(DB_NOW.getTime() - 4 * MINUTE),
                endedAt: new Date(DB_NOW.getTime() - 2 * MINUTE),
                code: null,
            })),
        })
        const outcome = await checkPilotOrderV1(check(), port({ findCashOrders: vi.fn(async () => [stale]) }), i, NOW)
        expect(outcome.state).toBe('not_confirmed')
        const incomplete = ingestion({
            readOrderConfirmation: vi.fn(async () => ({
                state: 'incomplete' as const, startedAt: null, endedAt: new Date(DB_NOW.getTime() - MINUTE), code: null,
            })),
        })
        expect((await checkPilotOrderV1(check(), port({ findCashOrders: vi.fn(async () => [stale]) }), incomplete, NOW)).state)
            .toBe('check_failed')
    })

    it('says the check is unavailable when ingestion cannot schedule one', async () => {
        const i = ingestion({ requestOrderConfirmation: vi.fn(async () => ({ status: 'not_scheduled' as const, reason: 'mode_not_write' })) })
        const outcome = await checkPilotOrderV1(check(), port({ findCashOrders: vi.fn(async () => [stale]) }), i, NOW)
        expect(outcome.state).toBe('unavailable')
    })

    it('answers a button from a list issued for another scope as stale', async () => {
        const i = ingestion()
        const outcome = await checkPilotOrderV1(check({ scopeKey: 'aaaaaaaaaaaa' }), port(), i, NOW)
        expect(outcome).toEqual({ state: 'stale_context', order: null, refusal: null })
        expect(i.readOrderConfirmation).not.toHaveBeenCalled()
    })

    it('fails closed when the active park changed after the list was shown', async () => {
        // The list was issued for PARK; the link now selects another park.
        const outcome = await checkPilotOrderV1(check({ selectedExternalParkId: 'park-2' }), port(), ingestion(), NOW)
        expect(outcome).toEqual({ state: 'refused', order: null, refusal: 'selected_park_profile_unproven' })
    })

    it('knows an order that left the catalogue, and one a claim already holds', async () => {
        expect((await checkPilotOrderV1(check(), port({ findCashOrders: vi.fn(async () => []) }), ingestion(), NOW)).state)
            .toBe('gone')
        expect((await checkPilotOrderV1(check(), port({
            findClaimedOrderIds: vi.fn(async () => [ORDER.externalOrderId]),
        }), ingestion(), NOW)).state).toBe('already_claimed')
    })
})

describe('the submission gate', () => {
    it('reaches C1 at exactly sixty minutes, with the observation as the order it hands over', async () => {
        const order = { ...ORDER, observedAt: new Date(DB_NOW.getTime() - 60 * MINUTE) }
        const p = port({ findCashOrders: vi.fn(async () => [order]) })
        const outcome = await submitPilotApplicationV1(SUBMIT, p, ingestion(), NOW)
        expect(outcome).toMatchObject({ submitted: true })
        expect(p.submitApplication).toHaveBeenCalledWith(expect.objectContaining({
            order: expect.objectContaining({ observedAt: order.observedAt }),
            submittedAt: NOW,
        }))
    })

    it('does not reach C1 a millisecond past sixty minutes, and asks Yandex instead', async () => {
        const order = { ...ORDER, observedAt: new Date(DB_NOW.getTime() - 60 * MINUTE - 1) }
        const p = port({ findCashOrders: vi.fn(async () => [order]) })
        const i = ingestion()
        const outcome = await submitPilotApplicationV1(SUBMIT, p, i, NOW)
        expect(outcome).toEqual({ submitted: false, refusal: 'order_confirmation_pending' })
        expect(i.requestOrderConfirmation).toHaveBeenCalledTimes(1)
        expect(p.submitApplication).not.toHaveBeenCalled()
    })

    it('never turns a provider failure into a definitive refusal', async () => {
        const order = { ...ORDER, observedAt: new Date(DB_NOW.getTime() - 2 * 60 * MINUTE) }
        const p = port({ findCashOrders: vi.fn(async () => [order]) })
        const failed = ingestion({
            readOrderConfirmation: vi.fn(async () => ({
                state: 'failed' as const, startedAt: null, endedAt: new Date(DB_NOW.getTime() - MINUTE), code: 'http_503',
            })),
        })
        expect(await submitPilotApplicationV1(SUBMIT, p, failed, NOW)).toEqual({ submitted: false, refusal: 'order_check_failed' })
        const notReturned = ingestion({
            readOrderConfirmation: vi.fn(async () => ({
                state: 'not_returned' as const,
                startedAt: new Date(DB_NOW.getTime() - 3 * MINUTE),
                endedAt: new Date(DB_NOW.getTime() - MINUTE),
                code: null,
            })),
        })
        expect(await submitPilotApplicationV1(SUBMIT, p, notReturned, NOW)).toEqual({ submitted: false, refusal: 'order_not_confirmed' })
        const unavailable = ingestion({
            requestOrderConfirmation: vi.fn(async () => ({ status: 'not_scheduled' as const, reason: 'park_not_enabled' })),
        })
        expect(await submitPilotApplicationV1(SUBMIT, p, unavailable, NOW)).toEqual({ submitted: false, refusal: 'order_check_unavailable' })
        expect(p.submitApplication).not.toHaveBeenCalled()
    })

    it('refuses a submit carrying another scope token, before any claim check', async () => {
        const p = port()
        const outcome = await submitPilotApplicationV1({ ...SUBMIT, scopeKey: 'aaaaaaaaaaaa' }, p, ingestion(), NOW)
        expect(outcome).toEqual({ submitted: false, refusal: 'stale_context' })
        expect(p.submitApplication).not.toHaveBeenCalled()
    })

    it('files nothing for an order from park A once the link moved to park B', async () => {
        // The Telegram link was re-pointed to a proven profile in park B; the
        // bot still holds park A's token and order.
        const p = port({
            findDriverFacts: vi.fn(async () => ({ ...ELIGIBLE_DRIVER, externalParkId: 'park-2', externalDriverProfileId: 'q'.repeat(32) })),
            findCashOrders: vi.fn(async () => []),
        })
        const outcome = await submitPilotApplicationV1({ ...SUBMIT, selectedExternalParkId: 'park-2' }, p, ingestion(), NOW)
        expect(outcome).toEqual({ submitted: false, refusal: 'stale_context' })
        expect(p.submitApplication).not.toHaveBeenCalled()
    })

    it('still requires the screenshot of a fresh order', async () => {
        const p = port()
        expect(await submitPilotApplicationV1({ ...SUBMIT, attachmentFileId: '  ' }, p, ingestion(), NOW))
            .toEqual({ submitted: false, refusal: 'attachment_missing' })
        expect(p.submitApplication).not.toHaveBeenCalled()
    })

    it('refuses a disabled catalogue without reading provider state', async () => {
        const i = ingestion({ readCatalogueFacts: vi.fn(async () => ({ ...READY_FACTS, parkEnabled: false })) })
        expect(await submitPilotApplicationV1(SUBMIT, port(), i, NOW)).toEqual({ submitted: false, refusal: 'catalogue_disabled' })
        expect(i.readOrderConfirmation).not.toHaveBeenCalled()
    })
})

describe('refreshing the selected park', () => {
    it('schedules a hot pass of exactly the selected park and returns', async () => {
        const i = ingestion()
        expect(await requestPilotRefreshV1(PROOF, port(), i, NOW)).toEqual({ status: 'scheduled', refusal: null })
        expect(i.requestHotRefresh).toHaveBeenCalledWith(PARK)
        expect(i.requestOrderConfirmation).not.toHaveBeenCalled()
    })

    it('says a refresh just happened or is running', async () => {
        for (const reason of ['hot_pass_recent', 'refresh_in_flight']) {
            const i = ingestion({ requestHotRefresh: vi.fn(async () => ({ status: 'not_scheduled' as const, reason })) })
            expect(await requestPilotRefreshV1(PROOF, port(), i, NOW)).toEqual({ status: 'recent', refusal: null })
        }
    })

    it('does not refresh without a selected park or for a disabled catalogue', async () => {
        const i = ingestion()
        expect(await requestPilotRefreshV1({ ...PROOF, selectedExternalParkId: null }, port(), i, NOW))
            .toEqual({ status: 'refused', refusal: 'park_not_selected' })
        const disabled = ingestion({ readCatalogueFacts: vi.fn(async () => ({ ...READY_FACTS, mode: 'off' })) })
        expect(await requestPilotRefreshV1(PROOF, port(), disabled, NOW)).toEqual({ status: 'unavailable', refusal: null })
        expect(i.requestHotRefresh).not.toHaveBeenCalled()
        expect(disabled.requestHotRefresh).not.toHaveBeenCalled()
    })
})

describe('the first month\'s orders after the month has ended: the month-end grace', () => {
    /** 30 September 23:30 Yekaterinburg: the last calendar day of the hire month. */
    const LAST_DAY_ORDER: PilotCatalogueOrderV1 = {
        ...ORDER,
        id: 'row-last-day',
        externalOrderId: 'd'.repeat(32),
        shortOrderIdDisplay: '3982099',
        endedAt: new Date('2026-09-30T18:30:00.000Z'),
        providerBookedAt: new Date('2026-09-30T18:00:00.000Z'),
    }
    /** 2 October: the month is over, and its orders' shared window is still open. */
    const GRACE_NOW = new Date('2026-10-02T12:00:00.000Z')
    const GRACE_DEADLINE = compensationSubmissionWindowV1(LAST_DAY_ORDER.endedAt).submissionDeadline
    const SUBMIT_LAST_DAY = { ...SUBMIT, externalOrderId: LAST_DAY_ORDER.externalOrderId }

    it('is bounded by the deadline the monetary core stores: the month\'s end plus 72 hours, for every order', () => {
        // 4 October 00:00 Yekaterinburg, the same for the last-day and the mid-month order.
        expect(GRACE_DEADLINE).toEqual(new Date('2026-10-03T19:00:00.000Z'))
        expect(compensationSubmissionWindowV1(ORDER.endedAt).submissionDeadline).toEqual(GRACE_DEADLINE)
    })

    it('lists every order of the first month through the grace, newest first', async () => {
        const p = port({ findCashOrders: vi.fn(async () => [ORDER, LAST_DAY_ORDER]) })
        const view = await compensationSectionViewV1(PROOF, p, ingestion(), GRACE_NOW)
        expect(view).toMatchObject({ available: true, firstMonthKey: '2026-09', remainingBudgetKopecks: 500_000 })
        if (!view.available) return
        expect(view.orders.map((order) => order.externalOrderId))
            .toEqual([LAST_DAY_ORDER.externalOrderId, ORDER.externalOrderId])
        // The period it charges is still the order's month, read by its key.
        expect(p.findBudgetPeriod).toHaveBeenCalledWith('2026-09')
    })

    it('submits the last-day claim after the month ended, against the first month', async () => {
        const p = port({ findCashOrders: vi.fn(async () => [ORDER, LAST_DAY_ORDER]) })
        expect(await submitPilotApplicationV1(SUBMIT_LAST_DAY, p, ingestion(), GRACE_NOW))
            .toMatchObject({ submitted: true, status: 'created' })
        expect(p.submitApplication).toHaveBeenCalledWith(expect.objectContaining({
            order: expect.objectContaining({
                externalOrderId: LAST_DAY_ORDER.externalOrderId,
                endedAt: LAST_DAY_ORDER.endedAt,
            }),
            submittedAt: GRACE_NOW,
        }))
    })

    it('is claimable until the deadline and refused at it and after it', async () => {
        // Stale, so that the only thing stopping a confirmation request at the
        // deadline is the closed window, never an already-fresh observation.
        const staleLastDay: PilotCatalogueOrderV1 = { ...LAST_DAY_ORDER, observedAt: new Date(DB_NOW.getTime() - 61 * MINUTE) }
        const p = port({ findCashOrders: vi.fn(async () => [ORDER, staleLastDay]) })
        const i = ingestion()
        const lastMoment = await compensationSectionViewV1(PROOF, p, i, new Date(GRACE_DEADLINE.getTime() - 1))
        expect(lastMoment.available).toBe(true)
        for (const now of [GRACE_DEADLINE, new Date(GRACE_DEADLINE.getTime() + 1)]) {
            expect(await compensationSectionViewV1(PROOF, p, i, now))
                .toMatchObject({ available: false, reason: 'outside_first_calendar_month' })
            expect(await submitPilotApplicationV1(SUBMIT_LAST_DAY, p, i, now))
                .toEqual({ submitted: false, refusal: 'outside_first_calendar_month' })
        }
        expect(p.submitApplication).not.toHaveBeenCalled()
        // No provider confirmation is ever asked for a claim whose window has closed.
        expect(i.requestOrderConfirmation).not.toHaveBeenCalled()
    })

    it('asks for a stale last-day claim to be confirmed at the last moment, carrying the order\'s own completion instant', async () => {
        const stale: PilotCatalogueOrderV1 = { ...LAST_DAY_ORDER, observedAt: new Date(DB_NOW.getTime() - 61 * MINUTE) }
        const p = port({ findCashOrders: vi.fn(async () => [stale]) })
        const i = ingestion()
        expect(await submitPilotApplicationV1(SUBMIT_LAST_DAY, p, i, new Date(GRACE_DEADLINE.getTime() - 1)))
            .toEqual({ submitted: false, refusal: 'order_confirmation_pending' })
        expect(i.requestOrderConfirmation).toHaveBeenCalledWith({
            externalParkId: PARK,
            dayKey: '2026-09-30',
            externalOrderId: LAST_DAY_ORDER.externalOrderId,
            providerBookedAt: LAST_DAY_ORDER.providerBookedAt,
            endedAt: LAST_DAY_ORDER.endedAt,
        })
        expect(p.submitApplication).not.toHaveBeenCalled()
    })

    it('treats a window that closed between the listing and the request as a failed check, never as a claim', async () => {
        const stale: PilotCatalogueOrderV1 = { ...LAST_DAY_ORDER, observedAt: new Date(DB_NOW.getTime() - 61 * MINUTE) }
        const p = port({ findCashOrders: vi.fn(async () => [stale]) })
        const i = ingestion({ requestOrderConfirmation: vi.fn(async () => ({ status: 'not_scheduled' as const, reason: 'order_window_closed' })) })
        expect(await submitPilotApplicationV1(SUBMIT_LAST_DAY, p, i, new Date(GRACE_DEADLINE.getTime() - 1)))
            .toEqual({ submitted: false, refusal: 'order_check_failed' })
        expect(p.submitApplication).not.toHaveBeenCalled()
    })

    it('gives a mid-month order the same grace: claimable after the month ends, refused from the deadline on', async () => {
        const open = port({ findCashOrders: vi.fn(async () => [ORDER]) })
        for (const now of [new Date('2026-09-30T19:00:00.000Z'), GRACE_NOW, new Date(GRACE_DEADLINE.getTime() - 1)]) {
            expect(await compensationSectionViewV1(PROOF, open, ingestion(), now))
                .toMatchObject({ available: true, firstMonthKey: '2026-09' })
            expect(await submitPilotApplicationV1(SUBMIT, open, ingestion(), now))
                .toMatchObject({ submitted: true, status: 'created' })
        }
        const closed = port({ findCashOrders: vi.fn(async () => [ORDER]) })
        for (const now of [GRACE_DEADLINE, new Date(GRACE_DEADLINE.getTime() + 1)]) {
            expect(await compensationSectionViewV1(PROOF, closed, ingestion(), now))
                .toMatchObject({ available: false, reason: 'outside_first_calendar_month' })
            expect(await submitPilotApplicationV1(SUBMIT, closed, ingestion(), now))
                .toEqual({ submitted: false, refusal: 'outside_first_calendar_month' })
        }
        expect(closed.submitApplication).not.toHaveBeenCalled()
    })

    it('keeps the facts gates ahead of the grace: a non-SMZ driver gets nothing from a last-day order', async () => {
        const p = port({
            findCashOrders: vi.fn(async () => [LAST_DAY_ORDER]),
            findDriverFacts: vi.fn(async () => ({
                ...ELIGIBLE_DRIVER,
                facts: { ...ELIGIBLE_DRIVER.facts, isSelfEmployed: false, employmentType: 'park_employee' },
            })),
        })
        expect(await compensationSectionViewV1(PROOF, p, ingestion(), GRACE_NOW))
            .toMatchObject({ available: false, reason: 'not_self_employed' })
    })

    it('keeps the catalogue inside the first month: an order completed after the month has no grace', async () => {
        // 1 October 10:00 Yekaterinburg: already the month after hire.
        const october: PilotCatalogueOrderV1 = {
            ...LAST_DAY_ORDER, id: 'row-october', externalOrderId: 'e'.repeat(32), endedAt: new Date('2026-10-01T05:00:00.000Z'),
        }
        const p = port({ findCashOrders: vi.fn(async () => [october]) })
        expect(await compensationSectionViewV1(PROOF, p, ingestion(), GRACE_NOW))
            .toMatchObject({ available: false, reason: 'outside_first_calendar_month' })
    })

    it('still demands a fresh provider observation before a last-day claim reaches C1', async () => {
        const stale: PilotCatalogueOrderV1 = { ...LAST_DAY_ORDER, observedAt: new Date(DB_NOW.getTime() - 61 * MINUTE) }
        const p = port({ findCashOrders: vi.fn(async () => [stale]) })
        const i = ingestion()
        expect(await submitPilotApplicationV1(SUBMIT_LAST_DAY, p, i, GRACE_NOW))
            .toEqual({ submitted: false, refusal: 'order_confirmation_pending' })
        expect(i.requestOrderConfirmation).toHaveBeenCalledWith(expect.objectContaining({
            externalParkId: PARK, dayKey: '2026-09-30', externalOrderId: LAST_DAY_ORDER.externalOrderId,
        }))
        expect(p.submitApplication).not.toHaveBeenCalled()
    })
})

describe('Owner pilot admission on the pilot port', () => {
    const PARK_EMPLOYEE: PilotDriverFactsV1 = {
        ...ELIGIBLE_DRIVER,
        facts: { isSelfEmployed: false, employmentType: 'park_employee', parkHireDate: new Date('2026-09-02T06:00:00.000Z') },
    }
    const ADMISSION = { externalParkId: PARK, externalDriverProfileId: PROFILE, monthKey: '2026-09' }

    it('is the same port when nothing is admitted', () => {
        const p = port()
        expect(withOwnerPilotAdmissionPortV1(p, [])).toBe(p)
    })

    it('lists and submits for an admitted park employee, through C1 unchanged', async () => {
        const p = port({ findDriverFacts: vi.fn(async () => PARK_EMPLOYEE) })
        const admitted = withOwnerPilotAdmissionPortV1(p, [ADMISSION])
        const view = await compensationSectionViewV1(PROOF, admitted, ingestion(), NOW)
        expect(view).toMatchObject({ available: true, firstMonthKey: '2026-09' })
        const result = await submitPilotApplicationV1(SUBMIT, admitted, ingestion(), NOW)
        expect(result).toMatchObject({ submitted: true, applicationId: 'app-1' })
        expect(p.submitApplication).toHaveBeenCalledTimes(1)
    })

    it('refuses as before when the admission names another profile or month', async () => {
        const p = port({ findDriverFacts: vi.fn(async () => PARK_EMPLOYEE) })
        for (const admission of [{ ...ADMISSION, externalDriverProfileId: 'd'.repeat(32) }, { ...ADMISSION, monthKey: '2026-10' }]) {
            const view = await compensationSectionViewV1(PROOF, withOwnerPilotAdmissionPortV1(p, [admission]), ingestion(), NOW)
            expect(view).toMatchObject({ available: false, reason: 'not_self_employed' })
        }
        expect(p.submitApplication).not.toHaveBeenCalled()
    })

    it('changes only the facts read: every other port method is the original', () => {
        const p = port()
        const admitted = withOwnerPilotAdmissionPortV1(p, [ADMISSION])
        for (const name of ['confirmMainDriver', 'resolveContactLineage', 'findCashOrders', 'findBudgetPeriod',
            'findClaimedOrderIds', 'findDriverApplications', 'submitApplication'] as const) {
            expect(admitted[name]).toBe(p[name])
        }
        expect(admitted.findDriverFacts).not.toBe(p.findDriverFacts)
    })
})

describe('on demand: the driver picks a day and only that driver\'s day is asked for', () => {
    const ON_DEMAND = { ...READY_FACTS, mode: 'on_demand' }
    const onDemand = (fetch: CompensationPilotIngestionPortV1['fetchDriverDay'] = vi.fn(async () => ({ state: 'complete' as const, code: null }))) =>
        ingestion({ readCatalogueFacts: vi.fn(async () => ON_DEMAND), fetchDriverDay: fetch })
    const PARK_EMPLOYEE: PilotDriverFactsV1 = {
        ...ELIGIBLE_DRIVER,
        facts: { isSelfEmployed: false, employmentType: 'park_employee', parkHireDate: new Date('2026-09-02T06:00:00.000Z') },
    }

    it('shows the date picker state without asking the provider anything', async () => {
        const i = onDemand()
        const view = await compensationSectionViewV1(PROOF, port(), i, NOW)
        expect(view).toMatchObject({ available: true, catalogueStatus: 'on_demand', search: null })
        expect(i.fetchDriverDay).not.toHaveBeenCalled()
    })

    it('asks for the proven park, the proven profile and the picked day, and lists that day only', async () => {
        const i = onDemand()
        const other = { ...ORDER, id: 'row-2', externalOrderId: 'c'.repeat(32), endedAt: new Date('2026-09-14T10:00:00.000Z') }
        const view = await compensationSectionViewV1(PROOF, port({ findCashOrders: vi.fn(async () => [ORDER, other]) }), i, NOW, { search: '2026-09-12' })
        expect(i.fetchDriverDay).toHaveBeenCalledTimes(1)
        expect(i.fetchDriverDay).toHaveBeenCalledWith({ externalParkId: PARK, externalDriverProfileId: PROFILE, dayKey: '2026-09-12' })
        expect(view.available && view.search).toMatchObject({ query: '2026-09-12', kind: 'date', truncated: false })
        expect(view.available && view.search?.matches.map((order) => order.externalOrderId)).toEqual([ORDER.externalOrderId])
    })

    it('answers an empty provider day as no orders, and a failed one as unavailable, never as no orders', async () => {
        const empty = await compensationSectionViewV1(PROOF, port(), onDemand(), NOW, { search: '2026-09-13' })
        expect(empty.available && empty.search).toMatchObject({ kind: 'date', matches: [] })
        const failed = await compensationSectionViewV1(PROOF, port(), onDemand(vi.fn(async () => ({ state: 'failed' as const, code: 'provider_rate_limited' }))), NOW, { search: '2026-09-13' })
        expect(failed.available && failed.search).toMatchObject({ kind: 'date_unavailable', matches: [] })
        const running = await compensationSectionViewV1(PROOF, port(), onDemand(vi.fn(async () => ({ state: 'running' as const, code: null }))), NOW, { search: '2026-09-13' })
        expect(running.available && running.search).toMatchObject({ kind: 'date_checking' })
        const absent = await compensationSectionViewV1(PROOF, port(), ingestion({ readCatalogueFacts: vi.fn(async () => ON_DEMAND) }), NOW, { search: '2026-09-13' })
        expect(absent.available && absent.search).toMatchObject({ kind: 'date_unavailable' })
    })

    it('never asks the provider for a day the driver cannot claim', async () => {
        const i = onDemand()
        for (const day of ['2026-09-21', '2026-08-31']) {
            const view = await compensationSectionViewV1(PROOF, port(), i, NOW, { search: day })
            expect(view.available && view.search).toMatchObject({ kind: 'date_not_allowed', matches: [] })
        }
        expect(i.fetchDriverDay).not.toHaveBeenCalled()
    })

    it('never asks the provider for an ineligible driver, an unproven person or another park', async () => {
        const i = onDemand()
        expect(await compensationSectionViewV1(PROOF, port({ findDriverFacts: vi.fn(async () => PARK_EMPLOYEE) }), i, NOW, { search: '2026-09-12' }))
            .toMatchObject({ available: false, reason: 'not_self_employed' })
        expect(await compensationSectionViewV1(PROOF, port({ confirmMainDriver: vi.fn(async () => 'not_confirmed' as const) }), i, NOW, { search: '2026-09-12' }))
            .toMatchObject({ available: false, reason: 'identity_not_proven' })
        expect(await compensationSectionViewV1({ ...PROOF, selectedExternalParkId: 'park-2' }, port(), i, NOW, { search: '2026-09-12' }))
            .toMatchObject({ available: false, reason: 'selected_park_profile_unproven' })
        expect(i.fetchDriverDay).not.toHaveBeenCalled()
    })

    it('serves an Owner-admitted park employee for the admitted month, and asks nothing without the admission', async () => {
        const i = onDemand()
        const parkEmployee = port({ findDriverFacts: vi.fn(async () => PARK_EMPLOYEE) })
        expect(await compensationSectionViewV1(PROOF, parkEmployee, i, NOW, { search: '2026-09-12' }))
            .toMatchObject({ available: false, reason: 'not_self_employed' })
        expect(i.fetchDriverDay).not.toHaveBeenCalled()

        const otherMonth = withOwnerPilotAdmissionPortV1(parkEmployee, [{ externalParkId: PARK, externalDriverProfileId: PROFILE, monthKey: '2026-10' }])
        expect(await compensationSectionViewV1(PROOF, otherMonth, i, NOW, { search: '2026-09-12' }))
            .toMatchObject({ available: false, reason: 'not_self_employed' })
        expect(i.fetchDriverDay).not.toHaveBeenCalled()

        const admitted = withOwnerPilotAdmissionPortV1(parkEmployee, [{ externalParkId: PARK, externalDriverProfileId: PROFILE, monthKey: '2026-09' }])
        const view = await compensationSectionViewV1(PROOF, admitted, i, NOW, { search: '2026-09-12' })
        expect(view.available && view.search).toMatchObject({ kind: 'date' })
        expect(i.fetchDriverDay).toHaveBeenCalledTimes(1)
        expect(i.fetchDriverDay).toHaveBeenCalledWith({ externalParkId: PARK, externalDriverProfileId: PROFILE, dayKey: '2026-09-12' })
    })

    it('treats a day query outside on-demand mode as an ordinary unsupported search', async () => {
        const i = ingestion({ fetchDriverDay: vi.fn(async () => ({ state: 'complete' as const, code: null })) })
        const view = await compensationSectionViewV1(PROOF, port(), i, NOW, { search: '2026-09-12' })
        expect(view.available && view.search).toMatchObject({ kind: 'unsupported' })
        expect(i.fetchDriverDay).not.toHaveBeenCalled()
    })

    it('confirms an older order through its own driver day, carrying the proven profile', async () => {
        const i = onDemand()
        const stale = { ...ORDER, observedAt: new Date(DB_NOW.getTime() - 45 * MINUTE - 1) }
        const outcome = await checkPilotOrderV1(
            { ...PROOF, externalOrderId: ORDER.externalOrderId, scopeKey: SCOPE_KEY, retry: false },
            port({ findCashOrders: vi.fn(async () => [stale]) }), i, NOW,
        )
        expect(outcome.state).toBe('checking')
        expect(i.requestOrderConfirmation).toHaveBeenCalledWith(expect.objectContaining({
            externalParkId: PARK, dayKey: '2026-09-12', externalDriverProfileId: PROFILE,
        }))
    })

    it('keeps every submission check: a stale order is re-confirmed, not submitted', async () => {
        const p = port({ findCashOrders: vi.fn(async () => [{ ...ORDER, observedAt: new Date(DB_NOW.getTime() - 61 * MINUTE) }]) })
        const result = await submitPilotApplicationV1(SUBMIT, p, onDemand(), NOW)
        expect(result).toEqual({ submitted: false, refusal: 'order_confirmation_pending' })
        expect(p.submitApplication).not.toHaveBeenCalled()
    })
})

describe('driver facts refreshed on demand, without the nightly park sync', () => {
    type Facts = PilotDriverFactsV1['facts']
    const SMZ_HIRED_IN_SEPTEMBER: Facts = {
        isSelfEmployed: true, employmentType: 'selfemployed', parkHireDate: new Date('2026-09-02T06:00:00.000Z'),
    }
    const NEVER_STATED: Facts = { isSelfEmployed: null, employmentType: null, parkHireDate: null }

    /**
     * The Driver row and the provider behind it. A refresh copies the provider's
     * current facts into the row, as the Fleet reconciler's upsert does; an
     * unavailable provider leaves the row untouched.
     */
    function world(input: {
        stored: Facts
        provider: Facts | 'unavailable' | 'fresh'
        row?: { externalParkId: string; externalDriverProfileId: string }
    }) {
        let stored = input.stored
        const row = input.row ?? { externalParkId: PARK, externalDriverProfileId: PROFILE }
        const ensureDriverFactsFresh = vi.fn(async () => {
            if (input.provider === 'fresh') return 'fresh' as const
            if (input.provider === 'unavailable') return 'unavailable' as const
            stored = input.provider
            return 'refreshed' as const
        })
        const p = port({
            findDriverFacts: vi.fn(async () => ({ ...row, facts: stored })),
            ensureDriverFactsFresh,
        })
        return { p, ensureDriverFactsFresh }
    }

    it('admits a new SMZ driver whose hire date the CRM never had but Yandex states', async () => {
        const { p, ensureDriverFactsFresh } = world({ stored: NEVER_STATED, provider: SMZ_HIRED_IN_SEPTEMBER })
        const view = await compensationSectionViewV1(PROOF, p, ingestion(), NOW)
        expect(view).toMatchObject({ available: true, firstMonthKey: '2026-09' })
        expect(ensureDriverFactsFresh).toHaveBeenCalledWith({
            driverId: DRIVER, externalParkId: PARK, externalDriverProfileId: PROFILE, factsStated: false,
        })
        expect(p.findDriverFacts).toHaveBeenCalledTimes(2)
    })

    it('marks a row without the SMZ flag or the hire date as unstated, whatever its stamp', async () => {
        for (const [facts, stated] of [
            [NEVER_STATED, false],
            [{ ...SMZ_HIRED_IN_SEPTEMBER, isSelfEmployed: null }, false],
            [{ ...SMZ_HIRED_IN_SEPTEMBER, parkHireDate: null }, false],
            [{ ...SMZ_HIRED_IN_SEPTEMBER, isSelfEmployed: false }, true],
            [SMZ_HIRED_IN_SEPTEMBER, true],
        ] as const) {
            const { p, ensureDriverFactsFresh } = world({ stored: facts, provider: 'fresh' })
            await compensationSectionViewV1(PROOF, p, ingestion(), NOW)
            expect(ensureDriverFactsFresh).toHaveBeenCalledWith(expect.objectContaining({ factsStated: stated }))
        }
    })

    it('decides on what Yandex states now when the stored facts were stale and changed', async () => {
        const rehired = world({
            stored: { ...SMZ_HIRED_IN_SEPTEMBER, parkHireDate: new Date('2026-06-02T06:00:00.000Z') },
            provider: SMZ_HIRED_IN_SEPTEMBER,
        })
        expect(await compensationSectionViewV1(PROOF, rehired.p, ingestion(), NOW)).toMatchObject({ available: true })

        const leftSmz = world({ stored: SMZ_HIRED_IN_SEPTEMBER, provider: { ...SMZ_HIRED_IN_SEPTEMBER, isSelfEmployed: false } })
        expect(await compensationSectionViewV1(PROOF, leftSmz.p, ingestion(), NOW))
            .toMatchObject({ available: false, reason: 'not_self_employed' })
        expect(await submitPilotApplicationV1(SUBMIT, leftSmz.p, ingestion(), NOW))
            .toEqual({ submitted: false, refusal: 'not_self_employed' })
        expect(leftSmz.p.submitApplication).not.toHaveBeenCalled()
    })

    it('refuses a driver Yandex states is not SMZ', async () => {
        const { p } = world({ stored: NEVER_STATED, provider: { ...SMZ_HIRED_IN_SEPTEMBER, isSelfEmployed: false, employmentType: 'park_employee' } })
        expect(await compensationSectionViewV1(PROOF, p, ingestion(), NOW))
            .toMatchObject({ available: false, reason: 'not_self_employed' })
    })

    it('refuses a driver whose first calendar month is over', async () => {
        const { p } = world({ stored: NEVER_STATED, provider: { ...SMZ_HIRED_IN_SEPTEMBER, parkHireDate: new Date('2026-07-15T06:00:00.000Z') } })
        expect(await compensationSectionViewV1(PROOF, p, ingestion(), NOW))
            .toMatchObject({ available: false, reason: 'outside_first_calendar_month' })
        expect(await submitPilotApplicationV1(SUBMIT, p, ingestion(), NOW))
            .toEqual({ submitted: false, refusal: 'outside_first_calendar_month' })
        expect(p.submitApplication).not.toHaveBeenCalled()
    })

    it('asks to retry, and files nothing, when Yandex cannot confirm stale facts', async () => {
        // The stale row would pass; it must not decide while unconfirmed.
        const { p } = world({ stored: SMZ_HIRED_IN_SEPTEMBER, provider: 'unavailable' })
        expect(await compensationSectionViewV1(PROOF, p, ingestion(), NOW))
            .toEqual({ available: false, reason: 'identity_busy', applications: [] })
        expect(await submitPilotApplicationV1(SUBMIT, p, ingestion(), NOW))
            .toEqual({ submitted: false, refusal: 'identity_busy' })
        expect(await checkPilotOrderV1({ ...PROOF, externalOrderId: ORDER.externalOrderId, scopeKey: SCOPE_KEY, retry: false }, p, ingestion(), NOW))
            .toMatchObject({ refusal: 'identity_busy' })
        expect(p.submitApplication).not.toHaveBeenCalled()
        expect(p.findDriverApplications).not.toHaveBeenCalled()
    })

    it('reads the row once and asks nothing more when the facts are fresh', async () => {
        const { p, ensureDriverFactsFresh } = world({ stored: SMZ_HIRED_IN_SEPTEMBER, provider: 'fresh' })
        expect(await compensationSectionViewV1(PROOF, p, ingestion(), NOW)).toMatchObject({ available: true })
        expect(ensureDriverFactsFresh).toHaveBeenCalledTimes(1)
        expect(p.findDriverFacts).toHaveBeenCalledTimes(1)
    })

    it('refreshes the proven row of a multi-park driver, never the park the bot names', async () => {
        const PARK_2 = 'park-2'
        const PROFILE_2 = 'q'.repeat(32)
        const own = world({ stored: NEVER_STATED, provider: SMZ_HIRED_IN_SEPTEMBER, row: { externalParkId: PARK_2, externalDriverProfileId: PROFILE_2 } })
        const view = await compensationSectionViewV1({ ...PROOF, selectedExternalParkId: PARK_2 }, own.p, ingestion(), NOW)
        expect(view).toMatchObject({ available: true, firstMonthKey: '2026-09' })
        expect(own.ensureDriverFactsFresh).toHaveBeenCalledWith({
            driverId: DRIVER, externalParkId: PARK_2, externalDriverProfileId: PROFILE_2, factsStated: false,
        })

        // The bot still holds park 1: the proven row in park 2 is refreshed, and the scope refuses.
        const other = world({ stored: NEVER_STATED, provider: SMZ_HIRED_IN_SEPTEMBER, row: { externalParkId: PARK_2, externalDriverProfileId: PROFILE_2 } })
        expect(await compensationSectionViewV1(PROOF, other.p, ingestion(), NOW)).toMatchObject({ available: false })
        expect(other.ensureDriverFactsFresh).toHaveBeenCalledWith(expect.objectContaining({ externalParkId: PARK_2 }))
        expect(other.ensureDriverFactsFresh).not.toHaveBeenCalledWith(expect.objectContaining({ externalParkId: PARK }))
    })

    it('never asks the provider for a person who is not proven', async () => {
        for (const overrides of [
            { confirmMainDriver: vi.fn(async () => 'not_confirmed' as const) },
            { confirmMainDriver: vi.fn(async () => 'busy' as const) },
            { resolveContactLineage: vi.fn(async () => ({ status: 'resolved' as const, canonicalContactId: CONTACT, contactIds: [CONTACT, 'contact-2'] })) },
        ]) {
            const { p, ensureDriverFactsFresh } = world({ stored: NEVER_STATED, provider: SMZ_HIRED_IN_SEPTEMBER })
            const unproven = { ...p, ...overrides }
            expect(await compensationSectionViewV1(PROOF, unproven, ingestion(), NOW)).toMatchObject({ available: false })
            expect(ensureDriverFactsFresh).not.toHaveBeenCalled()
        }
        const noProfile = world({ stored: NEVER_STATED, provider: SMZ_HIRED_IN_SEPTEMBER, row: { externalParkId: PARK, externalDriverProfileId: '' } })
        await compensationSectionViewV1(PROOF, noProfile.p, ingestion(), NOW)
        expect(noProfile.ensureDriverFactsFresh).not.toHaveBeenCalled()
    })

    it('keeps every money rule after a refresh', async () => {
        const capped = world({ stored: NEVER_STATED, provider: SMZ_HIRED_IN_SEPTEMBER })
        expect(await submitPilotApplicationV1({ ...SUBMIT, claimedRubles: 100_001 }, capped.p, ingestion(), NOW))
            .toEqual({ submitted: false, refusal: 'claim_above_pilot_cap' })

        const pending = world({ stored: NEVER_STATED, provider: SMZ_HIRED_IN_SEPTEMBER })
        pending.p.submitApplication = vi.fn(async () => ({ refusal: 'active_pending_exists' as const }))
        expect(await submitPilotApplicationV1(SUBMIT, pending.p, ingestion(), NOW))
            .toEqual({ submitted: false, refusal: 'active_pending_exists' })

        const empty = world({ stored: NEVER_STATED, provider: SMZ_HIRED_IN_SEPTEMBER })
        empty.p.findBudgetPeriod = vi.fn(async () => ({ limitKopecks: 500_000, reservedKopecks: 500_000, settledKopecks: 0 }))
        expect(await compensationSectionViewV1(PROOF, empty.p, ingestion(), NOW)).toMatchObject({ remainingBudgetKopecks: 0 })

        const ok = world({ stored: NEVER_STATED, provider: SMZ_HIRED_IN_SEPTEMBER })
        expect(await submitPilotApplicationV1(SUBMIT, ok.p, ingestion(), NOW))
            .toMatchObject({ submitted: true, applicationId: 'app-1' })
        expect(ok.p.submitApplication).toHaveBeenCalledTimes(1)
    })
})

describe('what reaches the provider when a driver taps', () => {
    const F = DRIVER_FACTS_FRESHNESS_V1
    const HOUR = 60 * 60 * 1000
    const OTHER_PARK = 'park-2'
    const target = (profile = 'a'.repeat(32), park = PARK): DriverFactsRefreshTargetV1 => ({
        externalParkId: park, externalDriverProfileId: profile,
    })

    /** A clock the test moves, a provider the test answers, and waits that end only when told to. */
    function provider(answer: (target: DriverFactsRefreshTargetV1) => Promise<DriverFactsRefreshResultV1>) {
        let now = Date.parse('2026-10-24T12:00:00.000Z')
        let releaseWaits: Array<() => void> = []
        const refresh = vi.fn(answer)
        const refresher = new DriverFactsRefresherV1({
            refresh,
            nowMs: () => now,
            sleep: () => new Promise<void>((resolve) => { releaseWaits.push(resolve) }),
        })
        return {
            refresher,
            refresh,
            advance: (ms: number) => { now += ms },
            /** Ends every driver's wait, as WAIT_MS elapsing would. */
            timeOut: () => { releaseWaits.forEach((release) => release()); releaseWaits = [] },
        }
    }
    const refreshed = async (): Promise<DriverFactsRefreshResultV1> => ({ status: 'refreshed' })

    it('asks once, then decides on the stated facts for 12 hours however often the driver taps', async () => {
        const w = provider(refreshed)
        expect(await w.refresher.ensureFresh(target(), true)).toBe('refreshed')
        for (let tap = 0; tap < 20; tap += 1) {
            w.advance(HOUR / 2)
            expect(await w.refresher.ensureFresh(target(), true)).toBe('fresh')
        }
        expect(w.refresh).toHaveBeenCalledTimes(1)
        w.advance(2 * HOUR)
        expect(await w.refresher.ensureFresh(target(), true)).toBe('refreshed')
        expect(w.refresh).toHaveBeenCalledTimes(2)
        expect(w.refresh).toHaveBeenCalledWith(target())
    })

    it('never trusts a stored row on its own: the first tap of a process asks the provider', async () => {
        const w = provider(refreshed)
        expect(await w.refresher.ensureFresh(target('b'.repeat(32)), true)).toBe('refreshed')
        expect(await w.refresher.ensureFresh(target('c'.repeat(32)), false)).toBe('refreshed')
        expect(w.refresh).toHaveBeenCalledTimes(2)
    })

    it('trusts an unstated SMZ flag or hire date only right after the provider answered, then asks again', async () => {
        const w = provider(refreshed)
        expect(await w.refresher.ensureFresh(target(), false)).toBe('refreshed')
        for (let tap = 0; tap < 10; tap += 1) {
            w.advance(30_000)
            expect(await w.refresher.ensureFresh(target(), false)).toBe('fresh')
        }
        expect(w.refresh).toHaveBeenCalledTimes(1)
        w.advance(F.UNSTATED_RECHECK_MS)
        expect(await w.refresher.ensureFresh(target(), false)).toBe('refreshed')
        expect(w.refresh).toHaveBeenCalledTimes(2)
    })

    it('joins concurrent taps for one profile into one request', async () => {
        let answer!: (result: DriverFactsRefreshResultV1) => void
        const w = provider(() => new Promise((resolve) => { answer = resolve }))
        const taps = Array.from({ length: 10 }, () => w.refresher.ensureFresh(target(), true))
        answer({ status: 'refreshed' })
        expect(await Promise.all(taps)).toEqual(Array(10).fill('refreshed'))
        expect(w.refresh).toHaveBeenCalledTimes(1)
    })

    it('does not ask again for a profile that just failed, until the retry window passes', async () => {
        const w = provider(async () => ({ status: 'failed', code: 'provider_error' }))
        expect(await w.refresher.ensureFresh(target(), true)).toBe('unavailable')
        for (let tap = 0; tap < 10; tap += 1) {
            w.advance(5_000)
            expect(await w.refresher.ensureFresh(target(), true)).toBe('unavailable')
        }
        expect(w.refresh).toHaveBeenCalledTimes(1)
        w.advance(F.RETRY_AFTER_FAILURE_MS)
        await w.refresher.ensureFresh(target(), true)
        expect(w.refresh).toHaveBeenCalledTimes(2)
    })

    it('pauses the whole park on HTTP 429 for Retry-After, other parks unaffected', async () => {
        const w = provider(async (t) => (t.externalParkId === PARK
            ? { status: 'rate_limited', retryAfterMs: 5 * 60_000 }
            : { status: 'refreshed' }))
        expect(await w.refresher.ensureFresh(target('a'.repeat(32)), true)).toBe('unavailable')
        w.advance(4 * 60_000)
        expect(await w.refresher.ensureFresh(target('b'.repeat(32)), true)).toBe('unavailable')
        expect(await w.refresher.ensureFresh(target('c'.repeat(32), OTHER_PARK), true)).toBe('refreshed')
        expect(w.refresh).toHaveBeenCalledTimes(2)
        w.advance(60_001)
        await w.refresher.ensureFresh(target('b'.repeat(32)), true)
        expect(w.refresh).toHaveBeenCalledTimes(3)
    })

    it('doubles the park pause on repeated 429 without Retry-After, up to the cap', async () => {
        const w = provider(async () => ({ status: 'rate_limited', retryAfterMs: null }))
        let profile = 0
        const next = () => target(`${profile++}`.repeat(32).slice(0, 32))
        await w.refresher.ensureFresh(next(), true)
        let expected: number = F.RATE_LIMIT_COOLDOWN_MS
        for (let strike = 1; strike <= 6; strike += 1) {
            const calls = w.refresh.mock.calls.length
            w.advance(expected - 1)
            expect(await w.refresher.ensureFresh(next(), true)).toBe('unavailable')
            expect(w.refresh.mock.calls.length).toBe(calls)
            w.advance(1)
            await w.refresher.ensureFresh(next(), true)
            expect(w.refresh.mock.calls.length).toBe(calls + 1)
            expected = Math.min(F.RATE_LIMIT_COOLDOWN_MAX_MS, expected * 2)
        }
        expect(expected).toBe(F.RATE_LIMIT_COOLDOWN_MAX_MS)
    })

    it('starts at most MAX_IN_FLIGHT refreshes at once across all drivers', async () => {
        const w = provider(() => new Promise(() => undefined))
        const taps = Array.from({ length: F.MAX_IN_FLIGHT + 2 }, (_, index) => w.refresher.ensureFresh(target(`${index}`.repeat(32)), true))
        w.timeOut()
        expect(await Promise.all(taps)).toEqual(Array(F.MAX_IN_FLIGHT + 2).fill('unavailable'))
        expect(w.refresh).toHaveBeenCalledTimes(F.MAX_IN_FLIGHT)
    })

    it('lets a slow refresh finish in the background while the driver is asked to retry', async () => {
        let answer!: (result: DriverFactsRefreshResultV1) => void
        const w = provider(() => new Promise((resolve) => { answer = resolve }))
        const first = w.refresher.ensureFresh(target(), true)
        w.timeOut()
        expect(await first).toBe('unavailable')
        // The retry joins the same request instead of starting another.
        const retry = w.refresher.ensureFresh(target(), true)
        answer({ status: 'refreshed' })
        expect(await retry).toBe('refreshed')
        expect(w.refresh).toHaveBeenCalledTimes(1)
    })

    it('treats a refresh that throws, or a profile Yandex did not return, as a failure', async () => {
        const thrown = provider(async () => { throw new Error('boom') })
        expect(await thrown.refresher.ensureFresh(target(), true)).toBe('unavailable')
        const missing = provider(async () => ({ status: 'not_returned' }))
        expect(await missing.refresher.ensureFresh(target(), true)).toBe('unavailable')
        missing.advance(10_000)
        expect(await missing.refresher.ensureFresh(target(), true)).toBe('unavailable')
        expect(missing.refresh).toHaveBeenCalledTimes(1)
    })
})
