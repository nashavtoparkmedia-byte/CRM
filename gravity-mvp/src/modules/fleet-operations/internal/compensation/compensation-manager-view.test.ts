import { describe, expect, it } from 'vitest'

import {
    MANAGER_APPLICATION_STATES_V1,
    MANAGER_PAGE_SIZE_MAX_V1,
    MANAGER_PAGE_SIZE_V1,
    decodeManagerCursorV1,
    encodeManagerCursorV1,
    managerAllowedActionsV1,
    managerApplicationStateV1,
    managerAuthorizationAgeV1,
    managerBudgetViewV1,
    managerCurrentPeriodKeyV1,
    managerResultForCompensationErrorV1,
    normalizeManagerFilterV1,
    routeManagerActionV1,
    type ManagerActionAvailabilityFactsV1,
    type ManagerBudgetFactsV1,
} from './compensation-manager-view'

/**
 * The manager projection, on its own.
 *
 * Nothing here touches storage: these are the rules that decide what one word
 * an application is in, which actions that word opens, and how a monetary-core
 * refusal is worded for the person reading it.
 */

const facts = (over: Partial<ManagerActionAvailabilityFactsV1> = {}): ManagerActionAvailabilityFactsV1 => ({
    status: 'PENDING',
    authorizationState: null,
    hasOpenReconciliation: false,
    evidence: 'present',
    ...over,
})

describe('the state a manager sees', () => {
    it('is new while the claim is pending and no payout right is open', () => {
        expect(managerApplicationStateV1(facts())).toBe('new')
    })

    it('is awaiting payment while a payout right is live', () => {
        expect(managerApplicationStateV1(facts({ authorizationState: 'active' }))).toBe('awaiting_payment')
    })

    it('is reconciliation once the payout outcome is unknown and a task is open', () => {
        expect(managerApplicationStateV1(facts({
            authorizationState: 'unknown_outcome',
            hasOpenReconciliation: true,
        }))).toBe('reconciliation')
    })

    it('falls back to new when the outcome is unknown but no task is open', () => {
        // The pair is the truth; an unknown authorization with nothing to
        // reconcile is not a state a manager can act on as reconciliation.
        expect(managerApplicationStateV1(facts({ authorizationState: 'unknown_outcome' }))).toBe('new')
    })

    it.each([
        ['finalized', 'new'],
        ['cancelled', 'new'],
    ] as const)('treats a %s authorization on a pending claim as %s', (authorizationState, expected) => {
        expect(managerApplicationStateV1(facts({ authorizationState }))).toBe(expected)
    })

    it('reads the settled statuses straight from the monetary core', () => {
        expect(managerApplicationStateV1(facts({ status: 'PAID', authorizationState: 'finalized' }))).toBe('paid')
        expect(managerApplicationStateV1(facts({ status: 'REJECTED' }))).toBe('rejected')
    })

    it('never invents a state outside the five the screens know', () => {
        const states = new Set<string>(MANAGER_APPLICATION_STATES_V1)
        for (const status of ['PENDING', 'PAID', 'REJECTED']) {
            for (const authorizationState of [null, 'active', 'unknown_outcome', 'finalized', 'cancelled'] as const) {
                for (const hasOpenReconciliation of [true, false]) {
                    expect(states.has(managerApplicationStateV1({
                        status, authorizationState, hasOpenReconciliation,
                    }))).toBe(true)
                }
            }
        }
    })
})

describe('the actions an application is open to', () => {
    it('offers approving and rejecting a new claim that has a screenshot', () => {
        expect(managerAllowedActionsV1(facts())).toEqual(['approve', 'reject'])
    })

    it('offers only rejecting when the screenshot is missing', () => {
        expect(managerAllowedActionsV1(facts({ evidence: 'missing' }))).toEqual(['reject'])
    })

    it('keeps every monetary way out open once money is authorised, screenshot or not', () => {
        // Evidence trouble must never strand authorised money.
        for (const evidence of ['present', 'missing'] as const) {
            expect(managerAllowedActionsV1(facts({ authorizationState: 'active', evidence })))
                .toEqual(['mark_paid', 'cancel_approval', 'declare_outcome_unknown'])
        }
    })

    it('offers both resolutions while a reconciliation is open', () => {
        expect(managerAllowedActionsV1(facts({
            authorizationState: 'unknown_outcome', hasOpenReconciliation: true, evidence: 'missing',
        }))).toEqual(['reconcile_paid', 'reconcile_not_paid'])
    })

    it('offers nothing on a settled application', () => {
        expect(managerAllowedActionsV1(facts({ status: 'PAID' }))).toEqual([])
        expect(managerAllowedActionsV1(facts({ status: 'REJECTED' }))).toEqual([])
    })
})

describe('routing an action', () => {
    it.each([
        ['approve', 'start_payout', facts()],
        ['reject', 'reject_application', facts()],
        ['mark_paid', 'finalize_payout', facts({ authorizationState: 'active' })],
        ['cancel_approval', 'cancel_preparation', facts({ authorizationState: 'active' })],
        ['declare_outcome_unknown', 'declare_outcome_unknown', facts({ authorizationState: 'active' })],
        ['reconcile_paid', 'reconcile', facts({ authorizationState: 'unknown_outcome', hasOpenReconciliation: true })],
        ['reconcile_not_paid', 'reconcile', facts({ authorizationState: 'unknown_outcome', hasOpenReconciliation: true })],
    ] as const)('sends %s to the %s entry point', (action, operation, availability) => {
        expect(routeManagerActionV1(action, availability)).toEqual({ operation })
    })

    it('refuses everything on a settled application, naming which way it settled', () => {
        expect(routeManagerActionV1('approve', facts({ status: 'PAID' }))).toEqual({ refusal: 'already_paid' })
        expect(routeManagerActionV1('reject', facts({ status: 'REJECTED' }))).toEqual({ refusal: 'already_rejected' })
    })

    it('names the missing screenshot when approving a new claim without one', () => {
        expect(routeManagerActionV1('approve', facts({ evidence: 'missing' })))
            .toEqual({ refusal: 'evidence_missing' })
    })

    it('names the approval that already happened rather than a generic move', () => {
        expect(routeManagerActionV1('approve', facts({ authorizationState: 'active' })))
            .toEqual({ refusal: 'already_approved' })
    })

    it('answers any other action the state does not allow with the state having moved', () => {
        expect(routeManagerActionV1('mark_paid', facts())).toEqual({ refusal: 'state_changed' })
        expect(routeManagerActionV1('reconcile_paid', facts({ authorizationState: 'active' })))
            .toEqual({ refusal: 'state_changed' })
        expect(routeManagerActionV1('cancel_approval', facts())).toEqual({ refusal: 'state_changed' })
    })

    it('names the authorised payout when a rejection arrives too late', () => {
        // The monetary core answers a late rejection with this same code, so
        // the manager reads one sentence whichever side caught the race.
        expect(routeManagerActionV1('reject', facts({ authorizationState: 'active' })))
            .toEqual({ refusal: 'payout_authorization_active' })
        expect(routeManagerActionV1('reject', facts({
            authorizationState: 'unknown_outcome', hasOpenReconciliation: true,
        }))).toEqual({ refusal: 'payout_authorization_active' })
    })
})

describe('wording a monetary-core refusal', () => {
    it('explains which way the application moved when it is no longer pending', () => {
        expect(managerResultForCompensationErrorV1('not_pending', facts({ status: 'PAID' }))).toBe('already_paid')
        expect(managerResultForCompensationErrorV1('not_pending', facts({ status: 'REJECTED' }))).toBe('already_rejected')
        expect(managerResultForCompensationErrorV1('not_pending', facts({ authorizationState: 'active' })))
            .toBe('state_changed')
    })

    it.each([
        ['application_not_found', 'application_not_found'],
        ['payout_authorization_active', 'payout_authorization_active'],
        ['another_payout_in_progress', 'another_payout_in_progress'],
        ['daily_limit_reached', 'daily_limit_reached'],
        ['authorization_too_old_reconcile', 'authorization_too_old_reconcile'],
        ['reconciliation_required', 'reconciliation_required'],
        ['reconciliation_not_open', 'reconciliation_not_open'],
        ['person_reconciliation_required', 'person_reconciliation_required'],
        ['already_finalized', 'already_paid'],
        ['order_already_settled', 'already_paid'],
        ['authorization_fenced', 'state_changed'],
        ['authorization_released', 'state_changed'],
        ['unknown_authorization', 'state_changed'],
        ['period_missing', 'budget_period_missing'],
        ['period_not_open', 'budget_period_missing'],
        ['payout_clock_skew', 'clock_skew'],
    ] as const)('maps %s to %s', (code, expected) => {
        expect(managerResultForCompensationErrorV1(code, facts())).toBe(expected)
    })

    it('says only that the action is unavailable for a code it does not know', () => {
        expect(managerResultForCompensationErrorV1('some_future_refusal', facts())).toBe('unavailable')
        expect(managerResultForCompensationErrorV1('', facts())).toBe('unavailable')
    })
})

describe('the month as the dashboard shows it', () => {
    const budget = (over: Partial<ManagerBudgetFactsV1> = {}): ManagerBudgetFactsV1 => ({
        periodKey: '2026-09',
        state: 'open',
        limitKopecks: 1_000_000,
        reservedKopecks: 60_000,
        settledKopecks: 30_000,
        pendingSumKopecks: 60_000,
        awaitingPaymentKopecks: 20_000,
        settlementSumKopecks: 30_000,
        counts: { new: 2, awaiting_payment: 1, reconciliation: 0, paid: 1, rejected: 3 },
        paidCount: 1,
        ...over,
    })

    it('reports a month with no period row as missing rather than as a zero budget', () => {
        const view = managerBudgetViewV1('2026-10', null)
        expect(view).toMatchObject({
            periodKey: '2026-10',
            state: 'missing',
            limitKopecks: 0,
            remainingKopecks: 0,
            applicationCount: 0,
            ledgerConsistent: true,
        })
        expect(view.counts).toEqual({ new: 0, awaiting_payment: 0, reconciliation: 0, paid: 0, rejected: 0 })
    })

    it('takes remaining from the ledger counters and nothing else', () => {
        expect(managerBudgetViewV1('2026-09', budget()).remainingKopecks).toBe(1_000_000 - 60_000 - 30_000)
    })

    it('never shows a negative remaining', () => {
        expect(managerBudgetViewV1('2026-09', budget({
            limitKopecks: 50_000, reservedKopecks: 60_000, settledKopecks: 30_000, pendingSumKopecks: 60_000,
        })).remainingKopecks).toBe(0)
    })

    it('counts every application it was given, including states with no rows', () => {
        const view = managerBudgetViewV1('2026-09', budget({ counts: { new: 2, rejected: 3 } as never }))
        expect(view.counts).toEqual({ new: 2, awaiting_payment: 0, reconciliation: 0, paid: 0, rejected: 3 })
        expect(view.applicationCount).toBe(5)
    })

    it('reports a ledger that no longer matches its applications, and repairs nothing', () => {
        const drifted = managerBudgetViewV1('2026-09', budget({ pendingSumKopecks: 61_000 }))
        expect(drifted.ledgerConsistent).toBe(false)
        expect(drifted.reservedKopecks).toBe(60_000)
        expect(drifted.remainingKopecks).toBe(910_000)

        expect(managerBudgetViewV1('2026-09', budget({ settlementSumKopecks: 1 })).ledgerConsistent).toBe(false)
        expect(managerBudgetViewV1('2026-09', budget()).ledgerConsistent).toBe(true)
    })

    it('answers with the period the ledger row itself names', () => {
        expect(managerBudgetViewV1('2026-08', budget()).periodKey).toBe('2026-09')
    })
})

describe('the current budget month', () => {
    it('is the business month of the instant, on the monetary core calendar', () => {
        // 2026-10-01T00:30 in the business zone is still 2026-09-30 in UTC;
        // the business calendar decides, so the dashboard and the ledger agree.
        expect(managerCurrentPeriodKeyV1(new Date('2026-09-30T19:30:00.000Z'))).toBe('2026-10')
        expect(managerCurrentPeriodKeyV1(new Date('2026-09-30T18:30:00.000Z'))).toBe('2026-09')
    })
})

describe('the list cursor', () => {
    const row = { submittedAt: new Date('2026-09-18T07:05:09.123Z'), applicationId: 'app-1' }

    it('round-trips the sort key exactly', () => {
        expect(decodeManagerCursorV1(encodeManagerCursorV1(row))).toEqual(row)
    })

    it('survives an application id that contains the separator', () => {
        const odd = { submittedAt: row.submittedAt, applicationId: 'app|with|bars' }
        expect(decodeManagerCursorV1(encodeManagerCursorV1(odd))).toEqual(odd)
    })

    it.each(['', 'not-base64!!', Buffer.from('no-separator').toString('base64url'),
        Buffer.from('|app-1').toString('base64url'),
        Buffer.from('not-a-date|app-1').toString('base64url'),
        Buffer.from('2026-09-18T07:05:09.123Z|').toString('base64url'),
    ])('refuses the unreadable cursor %#', (cursor) => {
        expect(decodeManagerCursorV1(cursor)).toBeNull()
    })
})

describe('normalising a filter', () => {
    it('keeps only values it understands', () => {
        expect(normalizeManagerFilterV1({
            periodKey: '2026-09', state: 'awaiting_payment', externalParkId: ' park-1 ', limit: 10,
        })).toEqual({
            periodKey: '2026-09', state: 'awaiting_payment', externalParkId: 'park-1', cursor: null, limit: 10,
        })
    })

    it('drops a period key that is not a month', () => {
        for (const periodKey of ['2026-13', '2026-9', 'september', '2026-09-18', '']) {
            expect(normalizeManagerFilterV1({ periodKey }).periodKey).toBeNull()
        }
    })

    it('drops a state the screens do not know', () => {
        expect(normalizeManagerFilterV1({ state: 'PENDING' }).state).toBeNull()
        expect(normalizeManagerFilterV1({ state: 'awaiting_payment' }).state).toBe('awaiting_payment')
    })

    it('defaults and caps the page size', () => {
        expect(normalizeManagerFilterV1({}).limit).toBe(MANAGER_PAGE_SIZE_V1)
        expect(normalizeManagerFilterV1({ limit: 0 }).limit).toBe(MANAGER_PAGE_SIZE_V1)
        expect(normalizeManagerFilterV1({ limit: -5 }).limit).toBe(MANAGER_PAGE_SIZE_V1)
        expect(normalizeManagerFilterV1({ limit: 7.5 }).limit).toBe(MANAGER_PAGE_SIZE_V1)
        expect(normalizeManagerFilterV1({ limit: 10_000 }).limit).toBe(MANAGER_PAGE_SIZE_MAX_V1)
    })

    it('drops an unreadable cursor instead of failing the page', () => {
        expect(normalizeManagerFilterV1({ cursor: 'rubbish!!' }).cursor).toBeNull()
    })
})

describe('how long a payout right has been open', () => {
    const openedAt = new Date('2026-09-18T07:00:00.000Z')
    const expiresAt = new Date('2026-09-18T08:00:00.000Z')
    const MAX = 24 * 60 * 60_000

    it('measures the age and whether the core will still finalize it unaided', () => {
        expect(managerAuthorizationAgeV1({ openedAt, expiresAt }, new Date('2026-09-18T07:30:00.000Z'), MAX))
            .toEqual({ ageMs: 30 * 60_000, beyondUnaidedRecall: false, stale: false })
    })

    it('marks preparation that outlived its window as stale without changing anything', () => {
        expect(managerAuthorizationAgeV1({ openedAt, expiresAt }, new Date('2026-09-18T08:00:01.000Z'), MAX))
            .toMatchObject({ beyondUnaidedRecall: false, stale: true })
    })

    it('marks a right older than the unaided window as needing reconciliation', () => {
        expect(managerAuthorizationAgeV1({ openedAt, expiresAt }, new Date('2026-09-19T07:00:01.000Z'), MAX))
            .toMatchObject({ beyondUnaidedRecall: true, stale: true })
        expect(managerAuthorizationAgeV1({ openedAt, expiresAt }, new Date('2026-09-19T07:00:00.000Z'), MAX)
            .beyondUnaidedRecall).toBe(false)
    })

    it('never reports a negative age when the clock reads behind the row', () => {
        expect(managerAuthorizationAgeV1({ openedAt, expiresAt }, new Date('2026-09-18T06:00:00.000Z'), MAX).ageMs).toBe(0)
    })
})
