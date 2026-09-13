import { describe, expect, it } from 'vitest'

import {
    compensationPilotEligibilityV1,
    isParkSelfEmployedV1,
    parkFirstCalendarMonthV1,
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

    it('refuses the month after hire', () => {
        const decision = compensationPilotEligibilityV1(facts(), new Date('2026-10-01T06:00:00.000Z'))
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

    it('keeps a driver hired late in the month eligible until that month ends', () => {
        const lateHire = facts({ parkHireDate: new Date('2026-09-28T06:00:00.000Z') })
        expect(compensationPilotEligibilityV1(lateHire, new Date('2026-09-30T12:00:00.000Z')))
            .toMatchObject({ eligible: true, firstMonthKey: '2026-09' })
        expect(compensationPilotEligibilityV1(lateHire, new Date('2026-10-01T06:00:00.000Z')))
            .toMatchObject({ eligible: false, reason: 'outside_first_calendar_month' })
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
