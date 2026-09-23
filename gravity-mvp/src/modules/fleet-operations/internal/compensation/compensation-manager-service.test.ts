import { describe, expect, it, vi } from 'vitest'

import {
    listManagerApplicationsV1,
    managerRejectionKeyV1,
    performManagerActionV1,
    readManagerApplicationV1,
    readManagerBudgetV1,
    type CompensationManagerActionOutcomeV1,
    type CompensationManagerPortV1,
    type ManagerApplicationDetailFactsV1,
    type ManagerPrincipalV1,
} from './compensation-manager-service'

/**
 * The manager seam against a fake store.
 *
 * These prove the wiring: which monetary-core entry point an action reaches,
 * what it carries there, and that the answer always states the state read back
 * from storage rather than the one the screen believed. What happens under the
 * monetary core's locks is proved against PostgreSQL, not here.
 */

const NOW = new Date('2026-09-20T09:00:00.000Z')
const PRINCIPAL: ManagerPrincipalV1 = { principalId: 'user-1', operatorLabel: 'Менеджер Аня' }

const OK: CompensationManagerActionOutcomeV1 = { ok: true, code: null, replayed: false }
const REPLAYED: CompensationManagerActionOutcomeV1 = { ok: true, code: null, replayed: true }
const refused = (code: string): CompensationManagerActionOutcomeV1 => ({ ok: false, code, replayed: false })

function applicationFacts(over: Partial<ManagerApplicationDetailFactsV1> = {}): ManagerApplicationDetailFactsV1 {
    return {
        applicationId: 'app-1',
        status: 'PENDING',
        version: 3,
        periodKey: '2026-09',
        submittedAt: new Date('2026-09-19T12:00:00.000Z'),
        paidAt: null,
        rejectedAt: null,
        rejectionReason: null,
        requestedKopecks: 30_000,
        payableKopecks: 33_500,
        orderAmountKopecks: 33_500,
        provider: 'yandex_fleet',
        externalParkId: 'park-1',
        parkName: 'Парк 1',
        externalOrderId: 'a'.repeat(32),
        shortOrderIdDisplay: '3982091',
        orderEndedAt: new Date('2026-09-18T10:15:00.000Z'),
        orderRawPrice: '335.0000',
        orderVerifiedAt: new Date('2026-09-18T11:00:00.000Z'),
        driverName: 'Иванов Иван',
        driverPhone: '+79990000000',
        externalDriverProfileId: 'b'.repeat(32),
        boundContactIds: ['contact-1'],
        telegramUserId: '777',
        attachmentKind: 'photo',
        hasAttachment: true,
        supportContactedAt: new Date('2026-09-19T11:00:00.000Z'),
        authorization: null,
        reconciliation: null,
        settlement: null,
        catalogue: {
            amountKopecks: 33_500,
            observedAt: new Date('2026-09-19T08:00:00.000Z'),
            providerBookedAt: new Date('2026-09-18T10:20:00.000Z'),
        },
        history: [],
        ...over,
    }
}

const ACTIVE_AUTHORIZATION = {
    id: 'auth-1',
    state: 'active' as const,
    authorizationFence: 'fence-1',
    intendedBusinessDay: '2026-09-20',
    openedAt: new Date('2026-09-20T08:00:00.000Z'),
    expiresAt: new Date('2026-09-20T08:30:00.000Z'),
    openedByLabel: 'Менеджер Аня',
}

const OPEN_RECONCILIATION = {
    id: 'task-1',
    state: 'open',
    reason: 'payout_outcome_unknown',
    openedAt: new Date('2026-09-20T08:40:00.000Z'),
}

/**
 * A store whose reads can differ between calls, which is how a race is staged:
 * the first read is what the manager saw, the later ones are what storage says
 * after the monetary core answered.
 */
function fakePort(reads: (ManagerApplicationDetailFactsV1 | null)[], outcome = OK) {
    const queue = [...reads]
    let last = reads[reads.length - 1] ?? null
    type Port = CompensationManagerPortV1
    const port = {
        findApplication: vi.fn<Port['findApplication']>(async () => {
            if (queue.length > 0) {
                last = queue.shift() ?? null
                return last
            }
            return last
        }),
        findApplications: vi.fn<Port['findApplications']>(async () => ({ rows: [], hasMore: false })),
        findBudget: vi.fn<Port['findBudget']>(async () => null),
        findEvidenceSource: vi.fn<Port['findEvidenceSource']>(async () => null),
        startPayout: vi.fn<Port['startPayout']>(async () => outcome),
        rejectApplication: vi.fn<Port['rejectApplication']>(async () => outcome),
        finalizePayout: vi.fn<Port['finalizePayout']>(async () => outcome),
        releasePayout: vi.fn<Port['releasePayout']>(async () => outcome),
        resolveReconciliation: vi.fn<Port['resolveReconciliation']>(async () => outcome),
    }
    return port satisfies CompensationManagerPortV1
}

describe('the list a manager opens', () => {
    it('states each row in the manager\'s words and hands the filter back normalised', async () => {
        const port = fakePort([])
        port.findApplications.mockResolvedValue({
            rows: [
                applicationFacts(),
                applicationFacts({
                    applicationId: 'app-2',
                    authorization: ACTIVE_AUTHORIZATION,
                    hasAttachment: false,
                    submittedAt: new Date('2026-09-19T11:00:00.000Z'),
                }),
            ],
            hasMore: false,
        })

        const list = await listManagerApplicationsV1({ state: 'nonsense', limit: 9 }, port)

        expect(list.rows.map((row) => [row.applicationId, row.state, row.evidence])).toEqual([
            ['app-1', 'new', 'present'],
            ['app-2', 'awaiting_payment', 'missing'],
        ])
        expect(list.filter).toEqual({ periodKey: null, state: null, externalParkId: null, limit: 9 })
        expect(port.findApplications).toHaveBeenCalledWith(expect.objectContaining({ state: null, limit: 9 }))
    })

    it('shows the order on the business calendar, not in UTC', async () => {
        const port = fakePort([])
        port.findApplications.mockResolvedValue({ rows: [applicationFacts()], hasMore: false })

        const [row] = (await listManagerApplicationsV1({}, port)).rows
        // 2026-09-18T10:15Z is 15:15 on the compensation business calendar.
        expect(row.order).toMatchObject({ dayKey: '2026-09-18', localDate: '18.09', localTime: '15:15' })
    })

    it('offers a next page only when the store says another row exists', async () => {
        const port = fakePort([])
        port.findApplications.mockResolvedValue({ rows: [applicationFacts()], hasMore: false })
        expect((await listManagerApplicationsV1({}, port)).nextCursor).toBeNull()

        port.findApplications.mockResolvedValue({ rows: [applicationFacts()], hasMore: true })
        const cursor = (await listManagerApplicationsV1({}, port)).nextCursor
        expect(cursor).not.toBeNull()

        // The cursor names the last row of the page, so the next page resumes
        // at the sort key itself rather than at an offset.
        await listManagerApplicationsV1({ cursor }, port)
        expect(port.findApplications).toHaveBeenLastCalledWith(expect.objectContaining({
            cursor: { submittedAt: new Date('2026-09-19T12:00:00.000Z'), applicationId: 'app-1' },
        }))
    })

    it('has no next page when the store returns nothing', async () => {
        const port = fakePort([])
        port.findApplications.mockResolvedValue({ rows: [], hasMore: true })
        const list = await listManagerApplicationsV1({}, port)
        expect(list.rows).toEqual([])
        expect(list.nextCursor).toBeNull()
    })
})

describe('one application', () => {
    it('is absent when the store has no such row', async () => {
        expect(await readManagerApplicationV1('missing', fakePort([null]), NOW)).toBeNull()
    })

    it('shows what the core froze beside what ingestion holds now', async () => {
        const detail = await readManagerApplicationV1('app-1', fakePort([applicationFacts()]), NOW)
        expect(detail!.snapshot).toEqual({
            rawPrice: '335.0000',
            amountKopecks: 33_500,
            verifiedAt: new Date('2026-09-18T11:00:00.000Z'),
            endedAt: new Date('2026-09-18T10:15:00.000Z'),
        })
        expect(detail!.catalogue).toEqual({
            present: true,
            amountKopecks: 33_500,
            observedAt: new Date('2026-09-19T08:00:00.000Z'),
            providerBookedAt: new Date('2026-09-18T10:20:00.000Z'),
        })
    })

    it('says plainly when ingestion no longer holds the order', async () => {
        const detail = await readManagerApplicationV1('app-1', fakePort([applicationFacts({ catalogue: null })]), NOW)
        expect(detail!.catalogue).toEqual({
            present: false, amountKopecks: null, observedAt: null, providerBookedAt: null,
        })
    })

    it('ages the payout right against the core\'s own unaided-finalize window', async () => {
        const detail = await readManagerApplicationV1(
            'app-1',
            fakePort([applicationFacts({ authorization: ACTIVE_AUTHORIZATION })]),
            new Date('2026-09-21T09:00:00.000Z'),
        )
        expect(detail!.authorization).toMatchObject({
            state: 'active',
            intendedBusinessDay: '2026-09-20',
            openedByLabel: 'Менеджер Аня',
        })
        expect(detail!.authorization!.age).toMatchObject({ beyondUnaidedRecall: true, stale: true })
        expect(detail!.allowedActions).toEqual(['mark_paid', 'cancel_approval', 'declare_outcome_unknown'])
    })

    it('carries the recorded history and the reconciliation that is open', async () => {
        const history = [{
            occurredAt: new Date('2026-09-20T08:00:00.000Z'),
            action: 'payout_started',
            actorLabel: 'Менеджер Аня',
            previousState: 'PENDING',
            nextState: 'PENDING',
            amountKopecks: 33_500,
            reason: null,
        }]
        const detail = await readManagerApplicationV1('app-1', fakePort([applicationFacts({
            authorization: { ...ACTIVE_AUTHORIZATION, state: 'unknown_outcome' },
            reconciliation: OPEN_RECONCILIATION,
            history,
        })]), NOW)
        expect(detail!.state).toBe('reconciliation')
        expect(detail!.history).toEqual(history)
        expect(detail!.reconciliation).toEqual({
            state: 'open', reason: 'payout_outcome_unknown', openedAt: OPEN_RECONCILIATION.openedAt,
        })
        expect(detail!.allowedActions).toEqual(['reconcile_paid', 'reconcile_not_paid'])
    })

    it('never carries the screenshot id or the authorization fence out of the seam', async () => {
        const port = fakePort([applicationFacts({ authorization: ACTIVE_AUTHORIZATION })])
        const detail = await readManagerApplicationV1('app-1', port, NOW)
        const serialised = JSON.stringify(detail)
        expect(serialised).not.toContain('fence-1')
        expect(serialised).not.toContain('authorizationFence')
        expect(serialised).not.toContain('attachmentFileId')
        // Reading an application never even asks where the screenshot lives:
        // that answer is server-only and has its own way out.
        expect(port.findEvidenceSource).not.toHaveBeenCalled()
        // The screenshot is a fact of presence and kind, never an address.
        expect(detail!.evidence).toBe('present')
        expect(detail!.attachmentKind).toBe('photo')
    })
})

describe('the month a manager sees', () => {
    it('reports a month with no ledger row as missing', async () => {
        const port = fakePort([])
        expect(await readManagerBudgetV1('2026-09', port)).toMatchObject({ periodKey: '2026-09', state: 'missing' })
        expect(port.findBudget).toHaveBeenCalledWith('2026-09')
    })

    it('passes the ledger through without a second arithmetic', async () => {
        const port = fakePort([])
        port.findBudget.mockResolvedValue({
            periodKey: '2026-09',
            state: 'open',
            limitKopecks: 500_000,
            reservedKopecks: 100_000,
            settledKopecks: 50_000,
            pendingSumKopecks: 100_000,
            awaitingPaymentKopecks: 33_500,
            settlementSumKopecks: 50_000,
            counts: { new: 1, awaiting_payment: 1, reconciliation: 0, paid: 1, rejected: 0 },
            paidCount: 1,
        } as never)
        expect(await readManagerBudgetV1('2026-09', port)).toMatchObject({
            remainingKopecks: 350_000, awaitingPaymentKopecks: 33_500, ledgerConsistent: true, applicationCount: 3,
        })
    })
})

describe('performing an action', () => {
    const act = (
        action: Parameters<typeof performManagerActionV1>[0]['action'],
        port: ReturnType<typeof fakePort>,
        over: Partial<Parameters<typeof performManagerActionV1>[0]> = {},
    ) => performManagerActionV1({ applicationId: 'app-1', action, principal: PRINCIPAL, ...over }, port)

    it('answers that the application is gone, touching nothing', async () => {
        const port = fakePort([null])
        expect(await act('approve', port)).toEqual({
            code: 'application_not_found', state: null, applicationId: 'app-1',
        })
        expect(port.startPayout).not.toHaveBeenCalled()
    })

    it('refuses a rejection with no reason before reaching the monetary core', async () => {
        const port = fakePort([applicationFacts()])
        expect(await act('reject', port, { reason: '   ' })).toEqual({
            code: 'reject_requires_reason', state: 'new', applicationId: 'app-1',
        })
        expect(port.rejectApplication).not.toHaveBeenCalled()
    })

    it('refuses to approve a claim whose screenshot was never stored', async () => {
        const port = fakePort([applicationFacts({ hasAttachment: false })])
        expect(await act('approve', port, { evidenceProven: true })).toMatchObject({ code: 'evidence_missing' })
        expect(port.startPayout).not.toHaveBeenCalled()
    })

    it('refuses to approve when the caller did not prove it could fetch the screenshot', async () => {
        const port = fakePort([applicationFacts()])
        // Absence means no: the fetch happens in the composition root, and an
        // unproved approval is a blind one.
        expect(await act('approve', port)).toMatchObject({ code: 'evidence_unavailable', state: 'new' })
        expect(port.startPayout).not.toHaveBeenCalled()
    })

    it('starts the payout once the screenshot was actually fetched', async () => {
        const port = fakePort([
            applicationFacts(),
            applicationFacts({ authorization: ACTIVE_AUTHORIZATION }),
        ])
        expect(await act('approve', port, { evidenceProven: true })).toEqual({
            code: 'performed', state: 'awaiting_payment', applicationId: 'app-1',
        })
        expect(port.startPayout).toHaveBeenCalledWith({ applicationId: 'app-1', principal: PRINCIPAL })
    })

    it('rejects with the reason it was given and a key that repeats for one rejection', async () => {
        const port = fakePort([
            applicationFacts(),
            applicationFacts({ status: 'REJECTED', rejectionReason: 'Нет чека' }),
        ])
        expect(await act('reject', port, { reason: '  Нет чека  ' })).toEqual({
            code: 'performed', state: 'rejected', applicationId: 'app-1',
        })
        expect(port.rejectApplication).toHaveBeenCalledWith({
            applicationId: 'app-1',
            reason: 'Нет чека',
            rejectionKey: managerRejectionKeyV1('app-1', 3),
            principal: PRINCIPAL,
        })
    })

    it('presents the fence it read, so the core decides the race under its own lock', async () => {
        const port = fakePort([
            applicationFacts({ authorization: ACTIVE_AUTHORIZATION }),
            applicationFacts({ status: 'PAID', authorization: { ...ACTIVE_AUTHORIZATION, state: 'finalized' } }),
        ])
        expect(await act('mark_paid', port)).toEqual({ code: 'performed', state: 'paid', applicationId: 'app-1' })
        expect(port.finalizePayout).toHaveBeenCalledWith({
            payoutAuthorizationId: 'auth-1', authorizationFence: 'fence-1', principal: PRINCIPAL,
        })
    })

    it.each([
        ['cancel_approval', 'cancel_preparation'],
        ['declare_outcome_unknown', 'declare_outcome_unknown'],
    ] as const)('releases the payout right for %s', async (action, kind) => {
        const port = fakePort([applicationFacts({ authorization: ACTIVE_AUTHORIZATION })])
        await act(action, port)
        expect(port.releasePayout).toHaveBeenCalledWith(expect.objectContaining({
            payoutAuthorizationId: 'auth-1', authorizationFence: 'fence-1', kind, principal: PRINCIPAL,
        }))
        // A release always carries a reason, whether or not the manager typed one.
        expect(port.releasePayout.mock.calls[0][0].reason).not.toBe('')
    })

    it('prefers the manager\'s own words when releasing', async () => {
        const port = fakePort([applicationFacts({ authorization: ACTIVE_AUTHORIZATION })])
        await act('cancel_approval', port, { reason: 'Водитель отозвал заявку' })
        expect(port.releasePayout.mock.calls[0][0].reason).toBe('Водитель отозвал заявку')
    })

    it.each([
        ['reconcile_paid', 'paid'],
        ['reconcile_not_paid', 'not_paid'],
    ] as const)('resolves an open reconciliation as %s', async (action, resolution) => {
        const port = fakePort([applicationFacts({
            authorization: { ...ACTIVE_AUTHORIZATION, state: 'unknown_outcome' },
            reconciliation: OPEN_RECONCILIATION,
        })])
        await act(action, port)
        expect(port.resolveReconciliation).toHaveBeenCalledWith(expect.objectContaining({
            reconciliationTaskId: 'task-1', resolution, principal: PRINCIPAL,
        }))
        expect(port.resolveReconciliation.mock.calls[0][0].resolutionEvidence).not.toBe('')
    })

    it('reports a replay as already done rather than as a second payment', async () => {
        const port = fakePort([
            applicationFacts({ authorization: ACTIVE_AUTHORIZATION }),
            applicationFacts({ status: 'PAID', authorization: { ...ACTIVE_AUTHORIZATION, state: 'finalized' } }),
        ], REPLAYED)
        expect(await act('mark_paid', port)).toMatchObject({ code: 'already_done', state: 'paid' })
    })

    it('states where the application ended up when someone else moved it first', async () => {
        // Two managers on the same claim: this one read PENDING, the other
        // rejected it, and the core refuses under its lock.
        const port = fakePort([
            applicationFacts(),
            applicationFacts({ status: 'REJECTED', rejectedAt: NOW }),
        ], refused('not_pending'))
        expect(await act('approve', port, { evidenceProven: true })).toEqual({
            code: 'already_rejected', state: 'rejected', applicationId: 'app-1',
        })
    })

    it('reports a fence the row no longer carries as the state having moved', async () => {
        const port = fakePort([
            applicationFacts({ authorization: ACTIVE_AUTHORIZATION }),
            applicationFacts({ status: 'PAID', authorization: { ...ACTIVE_AUTHORIZATION, state: 'finalized' } }),
        ], refused('authorization_fenced'))
        expect(await act('cancel_approval', port)).toEqual({
            code: 'state_changed', state: 'paid', applicationId: 'app-1',
        })
    })

    it.each([
        ['daily_limit_reached', 'daily_limit_reached'],
        ['another_payout_in_progress', 'another_payout_in_progress'],
        ['period_missing', 'budget_period_missing'],
        ['authorization_too_old_reconcile', 'authorization_too_old_reconcile'],
    ] as const)('passes the core refusal %s through as %s', async (code, expected) => {
        const port = fakePort([applicationFacts(), applicationFacts()], refused(code))
        expect(await act('approve', port, { evidenceProven: true })).toMatchObject({ code: expected, state: 'new' })
    })

    it('refuses an action the state no longer allows, without calling the core', async () => {
        const port = fakePort([applicationFacts({ status: 'PAID' })])
        expect(await act('approve', port, { evidenceProven: true })).toMatchObject({
            code: 'already_paid', state: 'paid',
        })
        expect(port.startPayout).not.toHaveBeenCalled()
    })

    it('reads the state back after every attempt, so no screen keeps an unconfirmed belief', async () => {
        const port = fakePort([
            applicationFacts(),
            applicationFacts({ authorization: ACTIVE_AUTHORIZATION }),
        ])
        await act('approve', port, { evidenceProven: true })
        expect(port.findApplication.mock.calls.length).toBeGreaterThanOrEqual(2)
    })

    it('answers with no state at all when the row disappears under the action', async () => {
        const port = fakePort([applicationFacts(), null])
        expect(await act('approve', port, { evidenceProven: true })).toEqual({
            code: 'performed', state: null, applicationId: 'app-1',
        })
    })
})

describe('the rejection key', () => {
    it('repeats for a retry of the same rejection', () => {
        expect(managerRejectionKeyV1('app-1', 3)).toBe(managerRejectionKeyV1('app-1', 3))
    })

    it('differs once the application has moved on', () => {
        expect(managerRejectionKeyV1('app-1', 3)).not.toBe(managerRejectionKeyV1('app-1', 4))
    })

    it('differs between applications', () => {
        expect(managerRejectionKeyV1('app-1', 3)).not.toBe(managerRejectionKeyV1('app-2', 3))
    })

    it('cannot collide by moving the separator between the two parts', () => {
        expect(managerRejectionKeyV1('app-1|3', 0)).not.toBe(managerRejectionKeyV1('app-1', 3))
    })

    it('fits the stored key column and carries no bytes a database would choke on', () => {
        const key = managerRejectionKeyV1('app-1', 3)
        expect(key.length).toBeLessThanOrEqual(64)
        expect(key).toMatch(/^mgr_reject_[0-9a-f]{40}$/u)
    })
})
