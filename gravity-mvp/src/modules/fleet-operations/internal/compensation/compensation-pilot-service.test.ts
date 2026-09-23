import { describe, expect, it, vi } from 'vitest'

import type { PilotCatalogueFactsV1, PilotCatalogueOrderV1 } from './compensation-pilot-selection'
import {
    checkPilotOrderV1,
    compensationSectionViewV1,
    requestPilotRefreshV1,
    resolvePilotIdentityV1,
    submitPilotApplicationV1,
    type CompensationPilotIngestionPortV1,
    type CompensationPilotPortV1,
    type PilotDriverFactsV1,
    type PilotTelegramPersonProofV1,
} from './compensation-pilot-service'
import { pilotScopeKeyV1 } from './compensation-pilot-selection'

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

    it('rejects above one thousand rubles without touching C1', async () => {
        const p = port()
        const outcome = await submitPilotApplicationV1({ ...SUBMIT, claimedRubles: 1001 }, p, ingestion(), NOW)

        expect(outcome).toEqual({ submitted: false, refusal: 'claim_above_pilot_cap' })
        expect(p.submitApplication).not.toHaveBeenCalled()
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
