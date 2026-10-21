import { describe, expect, it } from 'vitest'

import { cashOrderCatalogueV1, type StoredCashOrderV1 } from './compensation-cash-order-ingestion'
import {
    compensationEligibilityFactsFromFleetProfileV1,
    compensationPilotAdmissionBasisV1,
    compensationPilotEligibilityV1,
    compensationPilotFirstMonthV1,
    isParkSelfEmployedV1,
    OWNER_PILOT_ADMISSION_MAX_ENTRIES_V1,
    ownerPilotAdmissionForV1,
    parkFirstCalendarMonthV1,
    parseOwnerPilotAdmissionsV1,
    withOwnerPilotAdmissionV1,
    type CompensationEligibilityFactsV1,
} from './compensation-eligibility'

function facts(overrides: Partial<CompensationEligibilityFactsV1> = {}): CompensationEligibilityFactsV1 {
    return {
        isSelfEmployed: true,
        employmentType: 'selfemployed',
        parkHireDate: new Date('2026-09-05T06:00:00.000Z'),
        ...overrides,
    }
}

describe('park-SMZ gate', () => {
    it('passes a stated self-employed driver', () => {
        expect(isParkSelfEmployedV1(facts())).toBe(true)
    })

    it('rejects a park employee', () => {
        expect(isParkSelfEmployedV1(facts({ isSelfEmployed: false, employmentType: 'park_employee' }))).toBe(false)
    })

    it('rejects an individual entrepreneur, which is a different tax status', () => {
        const entrepreneur = facts({ isSelfEmployed: false, employmentType: 'individual_entrepreneur' })
        expect(isParkSelfEmployedV1(entrepreneur)).toBe(false)
        expect(compensationPilotEligibilityV1(entrepreneur, new Date('2026-09-10T06:00:00.000Z')))
            .toMatchObject({ eligible: false, reason: 'not_self_employed' })
    })

    it('fails closed when the park never stated the value', () => {
        expect(compensationPilotEligibilityV1(facts({ isSelfEmployed: null }), new Date('2026-09-10T06:00:00.000Z')))
            .toMatchObject({ eligible: false, reason: 'self_employment_unknown' })
    })

    it('never lets employment_type override the boolean', () => {
        const contradictory = facts({ isSelfEmployed: false, employmentType: 'selfemployed' })
        expect(isParkSelfEmployedV1(contradictory)).toBe(false)
    })
})

describe('first calendar month window', () => {
    it('admits a driver inside the month they were hired', () => {
        const decision = compensationPilotEligibilityV1(facts(), new Date('2026-09-20T06:00:00.000Z'))
        expect(decision).toMatchObject({ eligible: true, firstMonthKey: '2026-09' })
    })

    it('stays eligible through the 72 hours after the hire month ends, for that month\'s orders', () => {
        // 1 October 11:00 and 3 October 23:59:59.999 Yekaterinburg.
        expect(compensationPilotEligibilityV1(facts(), new Date('2026-10-01T06:00:00.000Z')))
            .toMatchObject({ eligible: true, firstMonthKey: '2026-09' })
        expect(compensationPilotEligibilityV1(facts(), new Date('2026-10-03T18:59:59.999Z')))
            .toMatchObject({ eligible: true, firstMonthKey: '2026-09' })
    })

    it('refuses from 4 October 00:00 Yekaterinburg, when the hire month stops accepting claims', () => {
        const decision = compensationPilotEligibilityV1(facts(), new Date('2026-10-03T19:00:00.000Z'))
        expect(decision).toMatchObject({ eligible: false, reason: 'outside_first_calendar_month', firstMonthKey: '2026-09' })
    })

    it('refuses a moment before the hire month began', () => {
        const decision = compensationPilotEligibilityV1(facts(), new Date('2026-08-31T10:00:00.000Z'))
        expect(decision).toMatchObject({ eligible: false, reason: 'outside_first_calendar_month' })
    })

    it('fails closed when the park never stated a hire date', () => {
        expect(compensationPilotEligibilityV1(facts({ parkHireDate: null }), new Date('2026-09-10T06:00:00.000Z')))
            .toMatchObject({ eligible: false, reason: 'hire_date_unknown' })
    })

    it('reads the hire month on the Yekaterinburg calendar, not UTC', () => {
        // 31 August 20:00 UTC is already 1 September in Yekaterinburg.
        const lateAugustUtc = new Date('2026-08-31T20:00:00.000Z')
        expect(parkFirstCalendarMonthV1(lateAugustUtc)).toMatchObject({ year: 2026, month: 9 })
    })

    it('keeps a driver hired late in the month eligible until that month\'s claims close', () => {
        const lateHire = facts({ parkHireDate: new Date('2026-09-28T06:00:00.000Z') })
        expect(compensationPilotEligibilityV1(lateHire, new Date('2026-09-30T12:00:00.000Z')))
            .toMatchObject({ eligible: true, firstMonthKey: '2026-09' })
        expect(compensationPilotEligibilityV1(lateHire, new Date('2026-10-02T06:00:00.000Z')))
            .toMatchObject({ eligible: true, firstMonthKey: '2026-09' })
        expect(compensationPilotEligibilityV1(lateHire, new Date('2026-10-04T06:00:00.000Z')))
            .toMatchObject({ eligible: false, reason: 'outside_first_calendar_month' })
    })
})

describe('the facts half of eligibility, with no clock', () => {
    it('names the first month and its window from the hire date alone', () => {
        expect(compensationPilotFirstMonthV1(facts())).toEqual({
            ok: true,
            firstMonth: { year: 2026, month: 9 },
            firstMonthKey: '2026-09',
            windowStartsAt: new Date('2026-08-31T19:00:00.000Z'),
            windowEndsAt: new Date('2026-09-30T19:00:00.000Z'),
        })
    })

    it('refuses on the facts in the same order as the clocked decision, and never on the clock', () => {
        expect(compensationPilotFirstMonthV1(facts({ isSelfEmployed: null, parkHireDate: null })))
            .toEqual({ ok: false, reason: 'self_employment_unknown' })
        expect(compensationPilotFirstMonthV1(facts({ isSelfEmployed: false, parkHireDate: null })))
            .toEqual({ ok: false, reason: 'not_self_employed' })
        expect(compensationPilotFirstMonthV1(facts({ parkHireDate: null })))
            .toEqual({ ok: false, reason: 'hire_date_unknown' })
    })

    it('is the month the clocked decision states, before and after it refuses on the clock', () => {
        const first = compensationPilotFirstMonthV1(facts())
        if (!first.ok) throw new Error(first.reason)
        const claimsClose = new Date(first.windowEndsAt.getTime() + 72 * 60 * 60 * 1000)
        expect(compensationPilotEligibilityV1(facts(), new Date('2026-09-20T06:00:00.000Z')))
            .toMatchObject({ eligible: true, firstMonthKey: first.firstMonthKey, windowEndsAt: first.windowEndsAt })
        expect(compensationPilotEligibilityV1(facts(), first.windowEndsAt))
            .toMatchObject({ eligible: true, firstMonthKey: first.firstMonthKey, windowEndsAt: first.windowEndsAt })
        expect(compensationPilotEligibilityV1(facts(), claimsClose))
            .toMatchObject({ eligible: false, reason: 'outside_first_calendar_month', firstMonthKey: first.firstMonthKey })
    })
})

describe('gate ordering', () => {
    it('reports the self-employment failure before looking at dates', () => {
        const decision = compensationPilotEligibilityV1(
            facts({ isSelfEmployed: false, parkHireDate: null }),
            new Date('2026-09-10T06:00:00.000Z'),
        )
        expect(decision).toMatchObject({ eligible: false, reason: 'not_self_employed' })
    })
})

describe('facts lifted from a Fleet driver profile', () => {
    it('reads the three stated values in the wire shape Fleet returns', () => {
        expect(compensationEligibilityFactsFromFleetProfileV1({
            id: 'profile-1',
            is_selfemployed: true,
            employment_type: 'selfemployed',
            hire_date: '2026-09-05T00:00:00+00:00',
        })).toEqual({
            isSelfEmployed: true,
            employmentType: 'selfemployed',
            parkHireDate: new Date('2026-09-05T00:00:00.000Z'),
        })
    })

    it('keeps an unstated value null so the gate fails closed on it', () => {
        const unstated = compensationEligibilityFactsFromFleetProfileV1({ id: 'profile-1' })
        expect(unstated).toEqual({ isSelfEmployed: null, employmentType: null, parkHireDate: null })
        expect(compensationPilotEligibilityV1(unstated, new Date('2026-09-10T06:00:00.000Z')))
            .toMatchObject({ eligible: false, reason: 'self_employment_unknown' })
    })

    it('never reads a truthy string as a self-employment statement', () => {
        expect(compensationEligibilityFactsFromFleetProfileV1({ is_selfemployed: 'true' }).isSelfEmployed)
            .toBeNull()
    })

    it('refuses a hire date that does not parse rather than inventing one', () => {
        expect(compensationEligibilityFactsFromFleetProfileV1({ hire_date: 'not-a-date' }).parkHireDate)
            .toBeNull()
    })

    it('tolerates a missing profile', () => {
        expect(compensationEligibilityFactsFromFleetProfileV1(undefined))
            .toEqual({ isSelfEmployed: null, employmentType: null, parkHireDate: null })
    })
})

describe('Owner pilot admission: the configured list', () => {
    const PARK = 'a'.repeat(32)
    const OTHER_PARK = 'c'.repeat(32)
    const PROFILE = 'b'.repeat(32)
    const entry = (park = PARK, profile = PROFILE, month = '2026-10') => `${park}:${profile}:${month}`

    it('reads nothing from an unset or blank value, without an error', () => {
        expect(parseOwnerPilotAdmissionsV1(undefined, [PARK])).toEqual({ admissions: [], error: null })
        expect(parseOwnerPilotAdmissionsV1(null, [PARK])).toEqual({ admissions: [], error: null })
        expect(parseOwnerPilotAdmissionsV1('  ', [PARK])).toEqual({ admissions: [], error: null })
    })

    it('reads exact park, profile and month triples, tolerating spaces around commas', () => {
        expect(parseOwnerPilotAdmissionsV1(` ${entry()} , ${entry(PARK, 'd'.repeat(32), '2026-11')}`, [PARK])).toEqual({
            admissions: [
                { externalParkId: PARK, externalDriverProfileId: PROFILE, monthKey: '2026-10' },
                { externalParkId: PARK, externalDriverProfileId: 'd'.repeat(32), monthKey: '2026-11' },
            ],
            error: null,
        })
    })

    it('discards the whole list on any malformed entry', () => {
        for (const raw of [
            `${entry()},`,
            entry('A'.repeat(32)),
            entry(PARK, 'b'.repeat(31)),
            entry(PARK, PROFILE, '2026-13'),
            entry(PARK, PROFILE, '2026-1'),
            `${PARK}:${PROFILE}`,
            `${entry()}:extra`,
            `${entry()};${entry(PARK, 'd'.repeat(32))}`,
        ]) {
            expect(parseOwnerPilotAdmissionsV1(raw, [PARK])).toEqual({ admissions: [], error: 'admission_entry_malformed' })
        }
    })

    it('never widens the pilot: a park outside the enabled scope voids the list', () => {
        expect(parseOwnerPilotAdmissionsV1(`${entry()},${entry(OTHER_PARK)}`, [PARK]))
            .toEqual({ admissions: [], error: 'admission_park_not_enabled' })
        expect(parseOwnerPilotAdmissionsV1(entry(), []))
            .toEqual({ admissions: [], error: 'admission_park_not_enabled' })
    })

    it('refuses a repeated entry and a list longer than the pilot bound', () => {
        expect(parseOwnerPilotAdmissionsV1(`${entry()},${entry()}`, [PARK]))
            .toEqual({ admissions: [], error: 'admission_duplicate' })
        const many = Array.from({ length: OWNER_PILOT_ADMISSION_MAX_ENTRIES_V1 + 1 },
            (_, index) => entry(PARK, index.toString(16).padStart(32, '0'))).join(',')
        expect(parseOwnerPilotAdmissionsV1(many, [PARK]))
            .toEqual({ admissions: [], error: 'admission_limit_exceeded' })
    })

    it('matches only the exact park and profile', () => {
        const { admissions } = parseOwnerPilotAdmissionsV1(`${entry()},${entry(PARK, PROFILE, '2026-11')}`, [PARK])
        expect(ownerPilotAdmissionForV1(admissions, PARK, PROFILE)).toEqual({ monthKeys: ['2026-10', '2026-11'] })
        expect(ownerPilotAdmissionForV1(admissions, OTHER_PARK, PROFILE)).toBeNull()
        expect(ownerPilotAdmissionForV1(admissions, PARK, 'd'.repeat(32))).toBeNull()
        expect(ownerPilotAdmissionForV1(admissions, null, PROFILE)).toBeNull()
        expect(ownerPilotAdmissionForV1(admissions, PARK, null)).toBeNull()
    })

    it('attaches the admission to a matching read only, and never alters the stated facts', () => {
        const { admissions } = parseOwnerPilotAdmissionsV1(entry(), [PARK])
        const stated = { isSelfEmployed: false, employmentType: 'park_employee', parkHireDate: new Date('2026-10-12T00:00:00.000Z') }
        const row = { externalParkId: PARK, externalDriverProfileId: PROFILE, facts: stated }
        const admitted = withOwnerPilotAdmissionV1(row, admissions)
        expect(admitted.facts).toEqual({ ...stated, ownerPilotAdmission: { monthKeys: ['2026-10'] } })
        expect(row.facts).toBe(stated)
        expect(stated).not.toHaveProperty('ownerPilotAdmission')
        const other = { externalParkId: PARK, externalDriverProfileId: 'd'.repeat(32), facts: stated }
        expect(withOwnerPilotAdmissionV1(other, admissions)).toBe(other)
    })
})

describe('Owner pilot admission: the facts gate', () => {
    // A park employee hired in October, with a stated hire date.
    const parkEmployee = (overrides: Partial<CompensationEligibilityFactsV1> = {}) => facts({
        isSelfEmployed: false,
        employmentType: 'park_employee',
        parkHireDate: new Date('2026-10-12T00:00:00.000Z'),
        ...overrides,
    })
    const october = { monthKeys: ['2026-10'] }

    it('admits a park employee for the named first month, with the same window as park-SMZ', () => {
        const admitted = compensationPilotFirstMonthV1(parkEmployee({ ownerPilotAdmission: october }))
        const smz = compensationPilotFirstMonthV1(parkEmployee({ isSelfEmployed: true, employmentType: 'selfemployed' }))
        expect(admitted).toEqual(smz)
        expect(admitted).toMatchObject({ ok: true, firstMonthKey: '2026-10' })
        expect(compensationPilotAdmissionBasisV1(parkEmployee({ ownerPilotAdmission: october }))).toBe('owner_pilot_admission')
    })

    it('admits an unknown SMZ status the same way, because the admission is the decision', () => {
        expect(compensationPilotFirstMonthV1(parkEmployee({ isSelfEmployed: null, ownerPilotAdmission: october })))
            .toMatchObject({ ok: true, firstMonthKey: '2026-10' })
    })

    it('keeps the original refusal when the admission names another month', () => {
        expect(compensationPilotFirstMonthV1(parkEmployee({ ownerPilotAdmission: { monthKeys: ['2026-11'] } })))
            .toEqual({ ok: false, reason: 'not_self_employed' })
        expect(compensationPilotFirstMonthV1(parkEmployee({ isSelfEmployed: null, ownerPilotAdmission: { monthKeys: ['2026-09'] } })))
            .toEqual({ ok: false, reason: 'self_employment_unknown' })
        expect(compensationPilotAdmissionBasisV1(parkEmployee({ ownerPilotAdmission: { monthKeys: ['2026-11'] } }))).toBeNull()
    })

    it('never stands in for the hire date', () => {
        expect(compensationPilotFirstMonthV1(parkEmployee({ parkHireDate: null, ownerPilotAdmission: october })))
            .toEqual({ ok: false, reason: 'hire_date_unknown' })
    })

    it('reports park-SMZ, not the admission, when the driver is park-SMZ anyway', () => {
        expect(compensationPilotAdmissionBasisV1(parkEmployee({ isSelfEmployed: true, ownerPilotAdmission: october }))).toBe('park_smz')
        expect(compensationPilotAdmissionBasisV1(parkEmployee())).toBeNull()
    })

    it('keeps the month window: eligible on 21 October, refused once 3 November ends in Yekaterinburg', () => {
        const admitted = parkEmployee({ ownerPilotAdmission: october })
        expect(compensationPilotEligibilityV1(admitted, new Date('2026-10-21T13:00:00.000Z')))
            .toMatchObject({ eligible: true, firstMonthKey: '2026-10' })
        expect(compensationPilotEligibilityV1(admitted, new Date('2026-11-03T18:59:59.999Z')))
            .toMatchObject({ eligible: true, firstMonthKey: '2026-10' })
        expect(compensationPilotEligibilityV1(admitted, new Date('2026-11-03T19:00:00.000Z')))
            .toMatchObject({ eligible: false, reason: 'outside_first_calendar_month' })
        expect(compensationPilotEligibilityV1(parkEmployee(), new Date('2026-10-21T13:00:00.000Z')))
            .toMatchObject({ eligible: false, reason: 'not_self_employed' })
    })

    it('lists first-month orders in the catalogue for an admitted driver and none without the admission', () => {
        const order: StoredCashOrderV1 = {
            id: 'row-1',
            provider: 'yandex_fleet',
            externalParkId: 'a'.repeat(32),
            externalOrderId: 'e'.repeat(32),
            shortOrderIdDisplay: '1000001',
            externalDriverProfileId: 'b'.repeat(32),
            rawPrice: '412.0000',
            amountKopecks: 41_200,
            endedAt: new Date('2026-10-15T12:00:00.000Z'),
        }
        const now = new Date('2026-10-21T13:00:00.000Z')
        expect(cashOrderCatalogueV1(parkEmployee({ ownerPilotAdmission: october }), [order], now))
            .toEqual({ eligible: true, firstMonthKey: '2026-10', orders: [order] })
        expect(cashOrderCatalogueV1(parkEmployee(), [order], now))
            .toEqual({ eligible: false, reason: 'not_self_employed', orders: [] })
    })
})
