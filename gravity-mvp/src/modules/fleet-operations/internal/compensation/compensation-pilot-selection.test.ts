import { describe, expect, it } from 'vitest'

import {
    PILOT_FRESHNESS_V1,
    PILOT_SEARCH_LIMIT_V1,
    freshForOrderCheckV1,
    freshForSubmissionV1,
    pilotCatalogueStatusV1,
    pilotConfirmationFollowUpV1,
    pilotListedOrderV1,
    pilotOrderSearchV1,
    pilotScheduleFollowUpV1,
    pilotScopeKeyV1,
    resolvePilotScopeV1,
    type PilotCatalogueFactsV1,
    type PilotListedOrderV1,
    type PilotOrderConfirmationReadV1,
} from './compensation-pilot-selection'

const MINUTE = 60_000
const DB_NOW = new Date('2026-09-18T10:00:00.000Z')
const ago = (ms: number) => new Date(DB_NOW.getTime() - ms)

const PARK = 'park-a'
const PROFILE = 'p'.repeat(32)

describe('the selected park is the scope, and it must be the proven profile park', () => {
    const base = { driverId: 'driver-1', externalParkId: PARK, externalDriverProfileId: PROFILE }

    it('asks for a park when none is selected, never borrowing the proven one', () => {
        for (const selectedExternalParkId of [null, '', '   ']) {
            expect(resolvePilotScopeV1({ ...base, selectedExternalParkId }))
                .toEqual({ scoped: false, refusal: 'park_not_selected' })
        }
    })

    it('fails closed when the selected park is not the proven profile park', () => {
        expect(resolvePilotScopeV1({ ...base, selectedExternalParkId: 'park-b' }))
            .toEqual({ scoped: false, refusal: 'selected_park_profile_unproven' })
    })

    it('refuses a proven Driver without a park profile', () => {
        expect(resolvePilotScopeV1({ ...base, externalDriverProfileId: null, selectedExternalParkId: PARK }))
            .toEqual({ scoped: false, refusal: 'driver_not_in_park' })
    })

    it('scopes to the matching park with a stable key per driver, park and profile', () => {
        const resolved = resolvePilotScopeV1({ ...base, selectedExternalParkId: PARK })
        expect(resolved).toMatchObject({ scoped: true, scope: { externalParkId: PARK, externalDriverProfileId: PROFILE } })
        if (!resolved.scoped) return
        expect(resolved.scope.scopeKey).toMatch(/^[0-9a-f]{12}$/)
        expect(resolved.scope.scopeKey).toBe(pilotScopeKeyV1(base))
        expect(pilotScopeKeyV1({ ...base, externalParkId: 'park-b' })).not.toBe(resolved.scope.scopeKey)
        expect(pilotScopeKeyV1({ ...base, driverId: 'driver-2' })).not.toBe(resolved.scope.scopeKey)
        expect(pilotScopeKeyV1({ ...base, externalDriverProfileId: 'q'.repeat(32) })).not.toBe(resolved.scope.scopeKey)
    })
})

describe('provider freshness thresholds', () => {
    it('lets an order check through at exactly 45 minutes and not a millisecond later', () => {
        expect(PILOT_FRESHNESS_V1.ORDER_CHECK_MAX_AGE_MS).toBe(45 * MINUTE)
        expect(freshForOrderCheckV1({ observedAt: ago(45 * MINUTE) }, DB_NOW)).toBe(true)
        expect(freshForOrderCheckV1({ observedAt: ago(45 * MINUTE + 1) }, DB_NOW)).toBe(false)
    })

    it('lets a submission through at exactly 60 minutes and not a millisecond later', () => {
        expect(PILOT_FRESHNESS_V1.SUBMISSION_MAX_AGE_MS).toBe(60 * MINUTE)
        expect(freshForSubmissionV1({ observedAt: ago(60 * MINUTE) }, DB_NOW)).toBe(true)
        expect(freshForSubmissionV1({ observedAt: ago(60 * MINUTE + 1) }, DB_NOW)).toBe(false)
    })

    it('keeps the two thresholds distinct: 50 minutes needs a check but may still be submitted', () => {
        const order = { observedAt: ago(50 * MINUTE) }
        expect(freshForOrderCheckV1(order, DB_NOW)).toBe(false)
        expect(freshForSubmissionV1(order, DB_NOW)).toBe(true)
    })

    it('treats an observation stamped after the read as fresh rather than as negative age', () => {
        expect(freshForSubmissionV1({ observedAt: new Date(DB_NOW.getTime() + 5) }, DB_NOW)).toBe(true)
    })
})

describe('what an old order needs next', () => {
    const order = { observedAt: ago(90 * MINUTE) }
    const read = (overrides: Partial<PilotOrderConfirmationReadV1>): PilotOrderConfirmationReadV1 => ({
        state: 'undetermined', startedAt: null, endedAt: null, code: null, ...overrides,
    })

    it('joins a check that is already running', () => {
        expect(pilotConfirmationFollowUpV1(read({ state: 'running' }), order, DB_NOW, { retry: false })).toBe('checking')
    })

    it('reads a recent complete fallback that did not return the order as a verdict', () => {
        const verdict = read({ state: 'not_returned', startedAt: ago(5 * MINUTE), endedAt: ago(3 * MINUTE) })
        expect(pilotConfirmationFollowUpV1(verdict, order, DB_NOW, { retry: false })).toBe('not_confirmed')
        expect(pilotConfirmationFollowUpV1(verdict, order, DB_NOW, { retry: true })).toBe('not_confirmed')
    })

    it('does not trust a not-returned verdict that a later observation contradicts, or that is old', () => {
        const contradicted = read({ state: 'not_returned', startedAt: ago(100 * MINUTE), endedAt: ago(95 * MINUTE) })
        expect(pilotConfirmationFollowUpV1(contradicted, { observedAt: ago(90 * MINUTE) }, DB_NOW, { retry: false })).toBe('request')
        const old = read({ state: 'not_returned', startedAt: ago(50 * MINUTE), endedAt: ago(46 * MINUTE) })
        expect(pilotConfirmationFollowUpV1(old, order, DB_NOW, { retry: false })).toBe('request')
        const unended = read({ state: 'not_returned', startedAt: ago(5 * MINUTE), endedAt: null })
        expect(pilotConfirmationFollowUpV1(unended, order, DB_NOW, { retry: false })).toBe('request')
    })

    it('never reads a failed or incomplete check as not confirmed', () => {
        for (const state of ['failed', 'incomplete'] as const) {
            const recent = read({ state, endedAt: ago(2 * MINUTE), code: 'provider_deferred' })
            expect(pilotConfirmationFollowUpV1(recent, order, DB_NOW, { retry: false })).toBe('check_failed')
            expect(pilotConfirmationFollowUpV1(recent, order, DB_NOW, { retry: true })).toBe('request')
            const old = read({ state, endedAt: ago(PILOT_FRESHNESS_V1.FAILED_CHECK_REPORT_MS + 1) })
            expect(pilotConfirmationFollowUpV1(old, order, DB_NOW, { retry: false })).toBe('request')
            const untimed = read({ state, endedAt: null })
            expect(pilotConfirmationFollowUpV1(untimed, order, DB_NOW, { retry: false })).toBe('check_failed')
        }
    })

    it('asks again when the runtime has nothing current to say', () => {
        for (const state of ['undetermined', 'confirmed', 'removed'] as const) {
            expect(pilotConfirmationFollowUpV1(read({ state }), order, DB_NOW, { retry: false })).toBe('request')
        }
    })

    it('maps a scheduling answer onto what the driver is told', () => {
        expect(pilotScheduleFollowUpV1({ status: 'scheduled', reason: null })).toBe('checking')
        expect(pilotScheduleFollowUpV1({ status: 'joined', reason: null })).toBe('checking')
        for (const reason of ['mode_not_write', 'park_not_enabled', 'invalid_day']) {
            expect(pilotScheduleFollowUpV1({ status: 'not_scheduled', reason })).toBe('unavailable')
        }
        for (const reason of ['provider_deferred', 'state_read_failed']) {
            expect(pilotScheduleFollowUpV1({ status: 'not_scheduled', reason })).toBe('check_failed')
        }
    })
})

describe('catalogue status', () => {
    const facts = (overrides: Partial<PilotCatalogueFactsV1> = {}): PilotCatalogueFactsV1 => ({
        mode: 'write',
        parkEnabled: true,
        dbNow: DB_NOW,
        lastHotSuccessAt: ago(2 * MINUTE),
        reconciliationPassStartedAt: ago(60 * MINUTE),
        reconciliationFloorBookedAt: null,
        reconciliationCursorBookedAt: null,
        lastReconciliationCompletedAt: ago(30 * MINUTE),
        ...overrides,
    })

    it('is disabled when ingestion does not write this park', () => {
        expect(pilotCatalogueStatusV1(facts({ mode: 'off' }))).toBe('disabled')
        expect(pilotCatalogueStatusV1(facts({ mode: 'dry_run' }))).toBe('disabled')
        expect(pilotCatalogueStatusV1(facts({ parkEnabled: false }))).toBe('disabled')
    })

    it('is stale when no hot pass succeeded for over ten minutes, or ever', () => {
        expect(pilotCatalogueStatusV1(facts({ lastHotSuccessAt: null }))).toBe('stale')
        expect(pilotCatalogueStatusV1(facts({ lastHotSuccessAt: ago(10 * MINUTE + 1) }))).toBe('stale')
        expect(pilotCatalogueStatusV1(facts({ lastHotSuccessAt: ago(10 * MINUTE) }))).toBe('ready')
    })

    it('is partial until reconciliation covers the current month', () => {
        expect(pilotCatalogueStatusV1(facts({ lastReconciliationCompletedAt: null }))).toBe('partial')
        // September starts at 2026-08-31T19:00Z in Yekaterinburg; covered means a
        // cursor at least 24 h below that.
        expect(pilotCatalogueStatusV1(facts({
            lastReconciliationCompletedAt: null,
            reconciliationCursorBookedAt: new Date('2026-08-30T19:00:00.000Z'),
        }))).toBe('ready')
        expect(pilotCatalogueStatusV1(facts({
            lastReconciliationCompletedAt: null,
            reconciliationCursorBookedAt: new Date('2026-08-30T19:00:00.001Z'),
        }))).toBe('partial')
    })
})

describe('listing and finding orders', () => {
    const stored = (id: string, endedAt: string, amountKopecks: number, shortOrderIdDisplay: string | null) => ({
        id: `row-${id}`,
        provider: 'yandex_fleet',
        externalParkId: PARK,
        externalOrderId: id,
        shortOrderIdDisplay,
        externalDriverProfileId: PROFILE,
        rawPrice: String(amountKopecks / 100),
        amountKopecks,
        endedAt: new Date(endedAt),
    })

    it('shows business-clock time and day, and whether a claim holds the order', () => {
        const listed = pilotListedOrderV1(stored('o1', '2026-09-18T10:42:00.000Z', 68_000, '4821'), ['o1'])
        expect(listed).toMatchObject({
            externalOrderId: 'o1',
            dayKey: '2026-09-18',
            localTime: '15:42',
            localDate: '18.09',
            claimed: true,
        })
        // 21:30Z is already the next business day in Yekaterinburg.
        expect(pilotListedOrderV1(stored('o2', '2026-09-18T21:30:00.000Z', 100, null), [])).toMatchObject({
            dayKey: '2026-09-19', localTime: '02:30', claimed: false,
        })
    })

    const orders: PilotListedOrderV1[] = [
        pilotListedOrderV1(stored('o1', '2026-09-18T10:42:00.000Z', 68_000, '4821'), []),
        pilotListedOrderV1(stored('o2', '2026-09-18T07:18:00.000Z', 43_000, '4821'), []),
        pilotListedOrderV1(stored('o3', '2026-09-18T04:51:00.000Z', 68_050, '5100'), []),
    ]

    it('returns every order sharing a short number instead of picking one', () => {
        const search = pilotOrderSearchV1(orders, '№ 4821')
        expect(search.kind).toBe('number')
        expect(search.matches.map((order) => order.externalOrderId)).toEqual(['o1', 'o2'])
    })

    it('matches a whole-rouble price, including a price with kopecks', () => {
        expect(pilotOrderSearchV1(orders, '680').matches.map((order) => order.externalOrderId)).toEqual(['o1', 'o3'])
    })

    it('matches a completion time, padding a one-digit hour, and still returns a single match as a list', () => {
        const search = pilotOrderSearchV1(orders, '9:51')
        expect(search).toMatchObject({ kind: 'time', truncated: false })
        expect(search.matches.map((order) => order.externalOrderId)).toEqual(['o3'])
    })

    it('answers an unreadable query with no matches', () => {
        expect(pilotOrderSearchV1(orders, 'вчера')).toMatchObject({ kind: 'unsupported', matches: [] })
    })

    it('caps a long list and says so', () => {
        const many = Array.from({ length: PILOT_SEARCH_LIMIT_V1 + 3 }, (_, index) => ({ ...orders[0], externalOrderId: `m${index}` }))
        const search = pilotOrderSearchV1(many, '680')
        expect(search.matches).toHaveLength(PILOT_SEARCH_LIMIT_V1)
        expect(search.truncated).toBe(true)
    })
})
