/**
 * Pilot eligibility for the Telegram cash-compensation flow.
 *
 * Two gates, both fail-closed, both fed only by fields Yandex states directly
 * about the driver profile in the park:
 *
 *   park-SMZ        `driver_profile.is_selfemployed`
 *   first month     `driver_profile.hire_date`
 *
 * `employment_type` is carried for audit only. It agrees with the boolean on
 * live data, and its `individual_entrepreneur` value is deliberately NOT
 * self-employed: an entrepreneur is a different tax status and must not pass a
 * park-SMZ gate. The opaque `work_rule_id` is never consulted.
 *
 * The month window is the driver's first calendar month in the park, measured
 * on the same Asia/Yekaterinburg calendar the monetary core already uses, so a
 * pilot decision and a budget period never disagree about which month it is.
 *
 * This module decides eligibility only. It never touches money, and the C1
 * monetary rules remain the sole authority on amounts, idempotency and payouts.
 */

import {
    compensationCalendarMonthV1,
    compensationMonthEndInstantV1,
    compensationMonthStartInstantV1,
    compensationPeriodKeyV1,
    type CompensationCalendarMonthV1,
} from './compensation-calendar'

/** Values observed live across all six parks. */
export const YANDEX_EMPLOYMENT_TYPES_V1 = [
    'park_employee',
    'selfemployed',
    'individual_entrepreneur',
] as const

export type YandexEmploymentTypeV1 = typeof YANDEX_EMPLOYMENT_TYPES_V1[number]

export const COMPENSATION_INELIGIBILITY_REASONS_V1 = [
    'self_employment_unknown',
    'not_self_employed',
    'hire_date_unknown',
    'outside_first_calendar_month',
] as const

export type CompensationIneligibilityReasonV1 =
    typeof COMPENSATION_INELIGIBILITY_REASONS_V1[number]

/** Exactly what the eligibility gate is allowed to read about a driver. */
export interface CompensationEligibilityFactsV1 {
    /** `driver_profile.is_selfemployed`; null when the park never stated it. */
    isSelfEmployed: boolean | null
    /** `driver_profile.employment_type`; diagnostics only, never decisive. */
    employmentType: string | null
    /** `driver_profile.hire_date`; null when the park never stated it. */
    parkHireDate: Date | null
}

export type CompensationEligibilityDecisionV1 =
    | {
        eligible: true
        /** The driver's first calendar month in the park. */
        firstMonth: CompensationCalendarMonthV1
        firstMonthKey: string
        windowEndsAt: Date
    }
    | {
        eligible: false
        reason: CompensationIneligibilityReasonV1
        firstMonthKey: string | null
    }

/**
 * Park-SMZ is the stated boolean and nothing else. An absent value is not a
 * "no" that might later become a "yes" by accident; it is an unknown, and an
 * unknown never passes.
 */
export function isParkSelfEmployedV1(facts: CompensationEligibilityFactsV1): boolean {
    return facts.isSelfEmployed === true
}

/** The calendar month the driver was hired into the park, Yekaterinburg time. */
export function parkFirstCalendarMonthV1(parkHireDate: Date): CompensationCalendarMonthV1 {
    return compensationCalendarMonthV1(parkHireDate)
}

/**
 * The pilot window runs from the hire instant to the end of that same calendar
 * month. A driver hired on the 28th gets a short window; that is the product
 * rule, not an accident, and widening it is a product decision rather than a
 * rounding choice.
 */
export function compensationPilotEligibilityV1(
    facts: CompensationEligibilityFactsV1,
    now: Date,
): CompensationEligibilityDecisionV1 {
    if (facts.isSelfEmployed === null || facts.isSelfEmployed === undefined) {
        return { eligible: false, reason: 'self_employment_unknown', firstMonthKey: null }
    }
    if (!isParkSelfEmployedV1(facts)) {
        return { eligible: false, reason: 'not_self_employed', firstMonthKey: null }
    }
    if (!facts.parkHireDate) {
        return { eligible: false, reason: 'hire_date_unknown', firstMonthKey: null }
    }

    const firstMonth = parkFirstCalendarMonthV1(facts.parkHireDate)
    const firstMonthKey = compensationPeriodKeyV1(firstMonth)
    const windowStartsAt = compensationMonthStartInstantV1(firstMonth)
    const windowEndsAt = compensationMonthEndInstantV1(firstMonth)

    if (now.getTime() < windowStartsAt.getTime() || now.getTime() >= windowEndsAt.getTime()) {
        return { eligible: false, reason: 'outside_first_calendar_month', firstMonthKey }
    }

    return { eligible: true, firstMonth, firstMonthKey, windowEndsAt }
}

/**
 * Reads the eligibility facts from one Fleet `driver_profile` object.
 *
 * The Fleet reconciler owns Driver ingestion, so this is the single place the
 * facts are lifted out of a profile. A value the park did not state, or one
 * that does not parse, stays null so the gate above fails closed on it rather
 * than reading absence as "not self-employed" or as a hire date.
 */
export function compensationEligibilityFactsFromFleetProfileV1(
    profile: unknown,
): CompensationEligibilityFactsV1 {
    const record = profile && typeof profile === 'object' && !Array.isArray(profile)
        ? profile as Record<string, unknown>
        : {}
    const hireDate = typeof record.hire_date === 'string' && record.hire_date.trim() !== ''
        ? new Date(record.hire_date)
        : null
    return {
        isSelfEmployed: typeof record.is_selfemployed === 'boolean' ? record.is_selfemployed : null,
        employmentType: typeof record.employment_type === 'string' && record.employment_type.trim() !== ''
            ? record.employment_type
            : null,
        parkHireDate: hireDate && !Number.isNaN(hireDate.getTime()) ? hireDate : null,
    }
}
