import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
    CASH_ACCESS_IDENTITY_REFUSALS_V1,
    CASH_ACCESS_MANAGE_CAPABILITY_V1,
    CASH_ACCESS_REASON_KIND_V1,
    CASH_ACCESS_REFUSAL_REASONS_V1,
    cashAccessDayAllowedV1,
    cashAccessOrderClaimableV1,
    decideCashAccessV1,
    type CashAccessActorV1,
    type CashAccessDecisionV1,
    type CashAccessInputV1,
    type CashManualAccessV1,
} from './compensation-access'
import { compensationBusinessDayKeyV1 } from './compensation-calendar'
import { cashOrderCatalogueV1, type StoredCashOrderV1 } from './compensation-cash-order-ingestion'
import { compensationPilotEligibilityV1, type CompensationEligibilityFactsV1 } from './compensation-eligibility'
import { pilotDriverDayAllowedV1 } from './compensation-pilot-selection'

// Business calendar is Asia/Yekaterinburg (UTC+5). A driver hired on
// 5 October 2026 has October as the first month:
//   month start   2026-09-30T19:00Z
//   month end     2026-10-31T19:00Z
//   last instant  2026-11-03T19:00Z (month end + 72 h)
const OCTOBER_START = new Date('2026-09-30T19:00:00.000Z')
const OCTOBER_END = new Date('2026-10-31T19:00:00.000Z')
const OCTOBER_CLOSES = new Date('2026-11-03T19:00:00.000Z')
const HOUR = 60 * 60 * 1000

const signedManager: CashAccessActorV1 = {
    kind: 'signed_staff_session',
    principalId: 'staff:manager-1',
    capabilities: [CASH_ACCESS_MANAGE_CAPABILITY_V1],
}

function facts(overrides: Partial<CompensationEligibilityFactsV1> = {}): CompensationEligibilityFactsV1 {
    return {
        isSelfEmployed: true,
        employmentType: 'selfemployed',
        parkHireDate: new Date('2026-10-05T06:00:00.000Z'),
        ...overrides,
    }
}

const oldNonSmz = facts({ isSelfEmployed: false, employmentType: 'park_employee', parkHireDate: new Date('2025-03-01T06:00:00.000Z') })

function input(overrides: Partial<CashAccessInputV1> = {}): CashAccessInputV1 {
    return {
        identity: { proven: true },
        standardFacts: facts(),
        referral: null,
        manual: null,
        ownerPolicy: {},
        at: new Date('2026-10-20T06:00:00.000Z'),
        ...overrides,
    }
}

function manual(decision: 'grant' | 'deny', decidedAt: string, actor: CashAccessActorV1 = signedManager): CashManualAccessV1 {
    return { decision, decidedAt: new Date(decidedAt), actor }
}

function order(endedAt: string | Date): StoredCashOrderV1 {
    const ended = typeof endedAt === 'string' ? new Date(endedAt) : endedAt
    return {
        id: `order-${ended.getTime()}`,
        provider: 'yandex',
        externalParkId: 'park',
        externalOrderId: `ext-${ended.getTime()}`,
        shortOrderIdDisplay: null,
        externalDriverProfileId: 'profile',
        rawPrice: '650',
        amountKopecks: 65000,
        endedAt: ended,
    }
}

function claimable(decision: CashAccessDecisionV1, endedAt: string): boolean {
    return cashAccessOrderClaimableV1(decision, order(endedAt))
}

describe('standard first month, unchanged', () => {
    it('admits a new park-SMZ for the first calendar month, not 30 days', () => {
        const decision = decideCashAccessV1(input())
        expect(decision).toEqual({
            access: 'granted',
            at: new Date('2026-10-20T06:00:00.000Z'),
            windows: [{ basis: 'park_smz', ordersFrom: OCTOBER_START, ordersUntil: OCTOBER_END }],
            ignored: [],
        })
        expect(claimable(decision, '2026-10-01T03:00:00.000Z')).toBe(true)
        expect(claimable(decision, '2026-10-31T18:59:59.999Z')).toBe(true)
        expect(claimable(decision, '2026-09-30T18:59:59.999Z')).toBe(false)
    })

    it('reports the Owner pilot admission as its own basis', () => {
        const admitted = facts({ isSelfEmployed: false, employmentType: 'park_employee', ownerPilotAdmission: { monthKeys: ['2026-10'] } })
        const decision = decideCashAccessV1(input({ standardFacts: admitted }))
        expect(decision).toMatchObject({ access: 'granted', windows: [{ basis: 'owner_pilot_admission' }] })
    })

    it('agrees with the live rule at every instant, for every order and every day', () => {
        const parkSmz = facts()
        const orders: StoredCashOrderV1[] = []
        for (let t = Date.parse('2026-09-25T00:00:00.000Z'); t < Date.parse('2026-11-06T00:00:00.000Z'); t += 5 * HOUR) {
            orders.push(order(new Date(t)))
        }
        let checkedInstants = 0
        for (let t = Date.parse('2026-09-26T00:00:00.000Z'); t < Date.parse('2026-11-06T00:00:00.000Z'); t += 7 * HOUR) {
            const now = new Date(t)
            const decision = decideCashAccessV1(input({ standardFacts: parkSmz, at: now }))
            const live = compensationPilotEligibilityV1(parkSmz, now)
            expect(decision.access === 'granted').toBe(live.eligible)

            const catalogue = cashOrderCatalogueV1(parkSmz, orders, now)
            const listed = new Set(catalogue.orders.map((row) => row.id))
            for (const row of orders) {
                expect(cashAccessOrderClaimableV1(decision, row)).toBe(listed.has(row.id))
            }

            if (live.eligible) {
                for (let d = Date.parse('2026-09-25T12:00:00.000Z'); d < Date.parse('2026-11-08T12:00:00.000Z'); d += 24 * HOUR) {
                    const dayKey = compensationBusinessDayKeyV1(new Date(d))
                    expect(cashAccessDayAllowedV1(decision, dayKey)).toBe(pilotDriverDayAllowedV1(dayKey, live.firstMonthKey, now))
                }
            }
            checkedInstants += 1
        }
        expect(checkedInstants).toBeGreaterThan(100)
    })

    it('closes at the month end plus 72 hours, as the live rule does', () => {
        expect(decideCashAccessV1(input({ at: new Date(OCTOBER_CLOSES.getTime() - 1) })).access).toBe('granted')
        expect(decideCashAccessV1(input({ at: OCTOBER_CLOSES }))).toMatchObject({
            access: 'refused',
            reasons: ['outside_first_calendar_month', 'no_entitlement'],
        })
    })
})

describe('referral access', () => {
    const confirmedAt = new Date('2026-11-10T09:30:00.000Z')
    const referral = { confirmedAt, revokedAt: null }

    it('gives an old non-SMZ inviter access from the confirmation, with no end', () => {
        const decision = decideCashAccessV1(input({ standardFacts: oldNonSmz, referral, at: new Date('2027-03-15T06:00:00.000Z') }))
        expect(decision).toMatchObject({
            access: 'granted',
            windows: [{ basis: 'referral', ordersFrom: confirmedAt, ordersUntil: null }],
        })
        expect(claimable(decision, '2027-03-14T10:00:00.000Z')).toBe(true)
    })

    it('never reaches back before the confirmation instant', () => {
        const decision = decideCashAccessV1(input({ standardFacts: oldNonSmz, referral, at: new Date('2026-11-12T06:00:00.000Z') }))
        expect(claimable(decision, new Date(confirmedAt.getTime() - 1).toISOString())).toBe(false)
        expect(claimable(decision, confirmedAt.toISOString())).toBe(true)
        expect(claimable(decision, '2026-11-01T06:00:00.000Z')).toBe(false)
    })

    it('keeps the existing submission deadline for every order', () => {
        // A November order stays claimable until the end of November plus 72 h.
        expect(claimable(decideCashAccessV1(input({ standardFacts: oldNonSmz, referral, at: new Date('2026-12-03T18:59:59.999Z') })), '2026-11-20T06:00:00.000Z')).toBe(true)
        expect(claimable(decideCashAccessV1(input({ standardFacts: oldNonSmz, referral, at: new Date('2026-12-03T19:00:00.000Z') })), '2026-11-20T06:00:00.000Z')).toBe(false)
    })

    it('is not yet access before its confirmation instant', () => {
        expect(decideCashAccessV1(input({ standardFacts: oldNonSmz, referral, at: new Date(confirmedAt.getTime() - 1) }))).toMatchObject({
            access: 'refused',
            reasons: ['not_self_employed', 'no_entitlement'],
        })
    })

    it('stops at the revoke instant, so nothing is claimable after it, whatever the order date', () => {
        const revokedAt = new Date('2026-12-10T12:00:00.000Z')
        const revoked = { confirmedAt, revokedAt }
        const before = decideCashAccessV1(input({ standardFacts: oldNonSmz, referral: revoked, at: new Date(revokedAt.getTime() - 1) }))
        expect(claimable(before, '2026-12-05T06:00:00.000Z')).toBe(true)
        const after = decideCashAccessV1(input({ standardFacts: oldNonSmz, referral: revoked, at: revokedAt }))
        expect(after).toMatchObject({ access: 'refused', reasons: ['not_self_employed', 'referral_access_revoked'], referralOffer: 'offer' })
        expect(claimable(after, '2026-12-05T06:00:00.000Z')).toBe(false)
    })

    it('adds its window to a new driver\'s first month instead of replacing it', () => {
        const early = { confirmedAt: new Date('2026-10-20T00:00:00.000Z'), revokedAt: null }
        const decision = decideCashAccessV1(input({ referral: early, at: new Date('2026-10-25T06:00:00.000Z') }))
        expect(decision).toMatchObject({ access: 'granted' })
        expect(decision.access === 'granted' && decision.windows.map((w) => w.basis)).toEqual(['referral', 'park_smz'])
        // Before the referral, the first month still covers the order.
        expect(claimable(decision, '2026-10-02T06:00:00.000Z')).toBe(true)
        // After the first month's grace, the referral alone carries the driver.
        const later = decideCashAccessV1(input({ referral: early, at: new Date('2026-11-20T06:00:00.000Z') }))
        expect(claimable(later, '2026-11-19T06:00:00.000Z')).toBe(true)
        expect(claimable(later, '2026-10-25T06:00:00.000Z')).toBe(false)
    })

    it('opens picker days from the confirmation day only', () => {
        const decision = decideCashAccessV1(input({ standardFacts: oldNonSmz, referral, at: new Date('2026-11-20T06:00:00.000Z') }))
        expect(cashAccessDayAllowedV1(decision, '2026-11-09')).toBe(false)
        expect(cashAccessDayAllowedV1(decision, '2026-11-10')).toBe(true)
        expect(cashAccessDayAllowedV1(decision, '2026-11-20')).toBe(true)
        expect(cashAccessDayAllowedV1(decision, '2026-11-21')).toBe(false)
        expect(cashAccessDayAllowedV1(decision, '2026-13-01')).toBe(false)
    })
})

describe('manual access', () => {
    it('grants regardless of SMZ status and connection date, from the decision instant', () => {
        for (const standardFacts of [oldNonSmz, null, facts({ isSelfEmployed: null, parkHireDate: null })]) {
            const decision = decideCashAccessV1(input({ standardFacts, manual: manual('grant', '2026-10-18T10:00:00.000Z') }))
            expect(decision).toMatchObject({
                access: 'granted',
                windows: [{ basis: 'manual_grant', ordersFrom: new Date('2026-10-18T10:00:00.000Z'), ordersUntil: null }],
            })
            expect(claimable(decision, '2026-10-18T09:59:59.999Z')).toBe(false)
            expect(claimable(decision, '2026-10-18T10:00:00.000Z')).toBe(true)
        }
    })

    it('ignores a record not made by a signed staff session with the capability', () => {
        const unsigned: CashAccessActorV1[] = [
            { kind: 'crm_user', principalId: 'crm_user:u3' },
            { kind: 'integration_admin', principalId: 'identity-access:integration-admin-session' },
            { kind: 'system', principalId: 'system' },
            { kind: 'signed_staff_session', principalId: '  ', capabilities: [CASH_ACCESS_MANAGE_CAPABILITY_V1] },
        ]
        for (const actor of unsigned) {
            expect(decideCashAccessV1(input({ standardFacts: oldNonSmz, manual: manual('grant', '2026-10-18T10:00:00.000Z', actor) }))).toEqual({
                access: 'refused',
                at: new Date('2026-10-20T06:00:00.000Z'),
                reasons: ['not_self_employed', 'no_entitlement'],
                referralOffer: 'offer',
                ignored: ['manual_record_unsigned'],
            })
        }
        const withoutCapability: CashAccessActorV1 = { kind: 'signed_staff_session', principalId: 'staff:m2', capabilities: ['cash.referral.qualify'] }
        expect(decideCashAccessV1(input({ standardFacts: oldNonSmz, manual: manual('grant', '2026-10-18T10:00:00.000Z', withoutCapability) })))
            .toMatchObject({ access: 'refused', ignored: ['manual_record_missing_capability'] })
    })

    it('an unsigned denial changes nothing either', () => {
        const decision = decideCashAccessV1(input({ manual: manual('deny', '2026-10-18T10:00:00.000Z', { kind: 'crm_user', principalId: 'crm_user:u1' }) }))
        expect(decision).toMatchObject({ access: 'granted', windows: [{ basis: 'park_smz' }], ignored: ['manual_record_unsigned'] })
    })

    it('does not act before its own decision instant', () => {
        expect(decideCashAccessV1(input({ standardFacts: oldNonSmz, manual: manual('grant', '2026-10-21T00:00:00.000Z') })))
            .toMatchObject({ access: 'refused', ignored: ['manual_record_not_yet_effective'] })
    })

    it('a signed denial closes referral access', () => {
        const decision = decideCashAccessV1(input({
            standardFacts: oldNonSmz,
            referral: { confirmedAt: new Date('2026-10-01T00:00:00.000Z'), revokedAt: null },
            manual: manual('deny', '2026-10-18T10:00:00.000Z'),
            ownerPolicy: { referralOfferAfterManualDeny: false },
        }))
        expect(decision).toMatchObject({ access: 'refused', reasons: ['manual_deny', 'not_self_employed'], referralOffer: 'no_offer' })
    })
})

describe('P5 and P6 stay the Owner\'s decision', () => {
    const deny = manual('deny', '2026-10-18T10:00:00.000Z')

    it('P6: a denial against a standard-eligible driver asks for the Owner\'s decision and is not claimable', () => {
        const decision = decideCashAccessV1(input({ manual: deny }))
        expect(decision).toEqual({
            access: 'owner_decision_required',
            at: new Date('2026-10-20T06:00:00.000Z'),
            scenario: 'P6_manual_deny_vs_standard_programme',
            referralOffer: 'owner_decision_required',
            ignored: [],
        })
        expect(claimable(decision, '2026-10-10T06:00:00.000Z')).toBe(false)
        expect(cashAccessDayAllowedV1(decision, '2026-10-10')).toBe(false)
    })

    it('P6 decided either way is applied exactly', () => {
        expect(decideCashAccessV1(input({ manual: deny, ownerPolicy: { manualDenyClosesStandardProgramme: true } })))
            .toMatchObject({ access: 'refused', reasons: ['manual_deny'] })
        expect(decideCashAccessV1(input({ manual: deny, ownerPolicy: { manualDenyClosesStandardProgramme: false } })))
            .toMatchObject({ access: 'granted', windows: [{ basis: 'park_smz' }] })
    })

    it('P6 open does not matter when the standard programme refuses anyway', () => {
        expect(decideCashAccessV1(input({ standardFacts: oldNonSmz, manual: deny })))
            .toMatchObject({ access: 'refused', reasons: ['manual_deny', 'not_self_employed'] })
    })

    it('P5: the referral offer to a denied person is the Owner\'s to decide', () => {
        const offer = (referralOfferAfterManualDeny?: boolean) => {
            const decision = decideCashAccessV1(input({ standardFacts: oldNonSmz, manual: deny, ownerPolicy: { referralOfferAfterManualDeny } }))
            return decision.access === 'granted' ? null : decision.referralOffer
        }
        expect(offer(undefined)).toBe('owner_decision_required')
        expect(offer(true)).toBe('offer')
        expect(offer(false)).toBe('no_offer')
    })
})

describe('identity blockers always block', () => {
    it('refuses on every identity refusal whatever access the person holds, with no referral offer', () => {
        const holdings: Partial<CashAccessInputV1>[] = [
            {},
            { manual: manual('grant', '2026-10-01T00:00:00.000Z') },
            { referral: { confirmedAt: new Date('2026-10-01T00:00:00.000Z'), revokedAt: null } },
            { manual: manual('deny', '2026-10-01T00:00:00.000Z'), ownerPolicy: { manualDenyClosesStandardProgramme: false, referralOfferAfterManualDeny: true } },
        ]
        for (const refusal of CASH_ACCESS_IDENTITY_REFUSALS_V1) {
            for (const holding of holdings) {
                const decision = decideCashAccessV1(input({ ...holding, identity: { proven: false, refusal } }))
                expect(decision).toEqual({
                    access: 'refused',
                    at: new Date('2026-10-20T06:00:00.000Z'),
                    reasons: [refusal],
                    referralOffer: 'no_offer',
                    ignored: [],
                })
                expect(claimable(decision, '2026-10-10T06:00:00.000Z')).toBe(false)
            }
        }
    })
})

describe('refusal reasons are the true ones', () => {
    it('names the stated standard reason, then the missing entitlement, and offers the referral programme', () => {
        expect(decideCashAccessV1(input({ standardFacts: oldNonSmz }))).toMatchObject({
            reasons: ['not_self_employed', 'no_entitlement'],
            referralOffer: 'offer',
        })
        const oldSmz = facts({ parkHireDate: new Date('2025-03-01T06:00:00.000Z') })
        expect(decideCashAccessV1(input({ standardFacts: oldSmz }))).toMatchObject({
            reasons: ['outside_first_calendar_month', 'no_entitlement'],
            referralOffer: 'offer',
        })
    })

    it('never turns unknown provider facts into a stated refusal', () => {
        const cases: Array<[CompensationEligibilityFactsV1 | null, string]> = [
            [facts({ isSelfEmployed: null }), 'self_employment_unknown'],
            [facts({ parkHireDate: null }), 'hire_date_unknown'],
            [null, 'standard_facts_unavailable'],
        ]
        for (const [standardFacts, reason] of cases) {
            const decision = decideCashAccessV1(input({ standardFacts }))
            expect(decision).toMatchObject({ access: 'refused', reasons: [reason, 'no_entitlement'], referralOffer: 'offer' })
            if (decision.access === 'refused') {
                expect(CASH_ACCESS_REASON_KIND_V1[decision.reasons[0]]).toBe('unverified')
                expect(decision.reasons).not.toContain('not_self_employed')
            }
        }
    })

    it('needs no provider facts at all for a person who holds access', () => {
        expect(decideCashAccessV1(input({ standardFacts: null, referral: { confirmedAt: new Date('2026-10-01T00:00:00.000Z'), revokedAt: null } })))
            .toMatchObject({ access: 'granted', windows: [{ basis: 'referral' }] })
    })

    it('classifies every reason', () => {
        expect(Object.keys(CASH_ACCESS_REASON_KIND_V1).sort()).toEqual([...CASH_ACCESS_REFUSAL_REASONS_V1].sort())
        expect(CASH_ACCESS_REASON_KIND_V1.not_self_employed).toBe('stated')
        expect(CASH_ACCESS_REASON_KIND_V1.manual_deny).toBe('decided')
        expect(CASH_ACCESS_REASON_KIND_V1.identity_needs_review).toBe('identity')
    })
})

describe('determinism and isolation', () => {
    it('returns the same answer for the same input and never modifies it', () => {
        const frozen = Object.freeze(input({
            standardFacts: Object.freeze(oldNonSmz),
            referral: Object.freeze({ confirmedAt: new Date('2026-10-01T00:00:00.000Z'), revokedAt: null }),
            manual: Object.freeze(manual('grant', '2026-10-02T00:00:00.000Z', Object.freeze({ ...signedManager, capabilities: Object.freeze([...signedManager.capabilities]) }))),
            ownerPolicy: Object.freeze({}),
        }))
        expect(decideCashAccessV1(frozen)).toEqual(decideCashAccessV1(frozen))
    })

    it('is not wired into anything yet, and reads nothing monetary', () => {
        const root = join(process.cwd(), 'src')
        const files: string[] = []
        const walk = (dir: string) => {
            for (const name of readdirSync(dir)) {
                const path = join(dir, name)
                if (statSync(path).isDirectory()) walk(path)
                else if (/\.(ts|tsx|js|mjs)$/.test(name)) files.push(path)
            }
        }
        walk(root)
        const s0 = new Set([
            'modules/fleet-operations/internal/compensation/compensation-access.ts',
            'modules/fleet-operations/internal/compensation/compensation-referral-qualification.ts',
        ])
        const importers = files
            .filter((file) => !/\.test\.(ts|tsx)$/.test(file) && !s0.has(relative(root, file)))
            .filter((file) => /compensation-access['"]|compensation-referral-qualification['"]/.test(readFileSync(file, 'utf8')))
            .map((file) => relative(root, file))
        expect(importers).toEqual([])

        for (const file of s0) {
            const source = readFileSync(join(root, file), 'utf8')
            expect(source).not.toMatch(/from '[^']*(compensation-money|compensation-policy|compensation-prisma-adapter|compensation-pilot-service|prisma)'/)
            expect(source).not.toMatch(/process\.env|fetch\(|\$queryRaw|\$executeRaw/)
        }
    })
})
