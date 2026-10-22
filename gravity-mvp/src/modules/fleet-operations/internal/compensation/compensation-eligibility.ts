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
 * One exception replaces the park-SMZ gate, and only that gate: an Owner
 * pilot admission names an exact park, driver profile and month, and admits
 * that profile whatever its SMZ status, but only when the named month is the
 * driver's first calendar month. The hire date, the month window and every
 * monetary rule still apply. The admission travels with the facts and is never
 * written back, so the stated `is_selfemployed` stays exactly what Yandex said.
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
import { compensationPeriodSubmissionClosesAtV1 } from './compensation-submission-window'

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
    /**
     * The Owner pilot admission for this exact park and profile, if one is
     * configured. Absent means none: the park-SMZ gate applies unchanged.
     */
    ownerPilotAdmission?: OwnerPilotAdmissionV1 | null
}

/** The months an Owner pilot admission covers for one park and profile. */
export interface OwnerPilotAdmissionV1 {
    monthKeys: readonly string[]
}

/** Which rule admitted a driver past the park-SMZ gate. */
export type CompensationPilotAdmissionBasisV1 = 'park_smz' | 'owner_pilot_admission'

/** One configured admission: `<externalParkId>:<externalDriverProfileId>:<YYYY-MM>`. */
export interface OwnerPilotAdmissionEntryV1 {
    externalParkId: string
    externalDriverProfileId: string
    monthKey: string
}

export const OWNER_PILOT_ADMISSION_ERRORS_V1 = [
    'admission_entry_malformed',
    'admission_park_not_enabled',
    'admission_duplicate',
    'admission_limit_exceeded',
] as const

export type OwnerPilotAdmissionErrorV1 = typeof OWNER_PILOT_ADMISSION_ERRORS_V1[number]

/** A pilot exception, not a second eligibility class: the list stays short. */
export const OWNER_PILOT_ADMISSION_MAX_ENTRIES_V1 = 10

export interface OwnerPilotAdmissionsV1 {
    admissions: readonly OwnerPilotAdmissionEntryV1[]
    error: OwnerPilotAdmissionErrorV1 | null
}

const OWNER_PILOT_ADMISSION_ENTRY = /^([0-9a-f]{32}):([0-9a-f]{32}):(\d{4}-(?:0[1-9]|1[0-2]))$/

/**
 * Parses the comma-separated admission list. Any fault discards the whole list
 * rather than the faulty entry alone: a typo must not leave an operator
 * believing a different set is live. Only the admission is lost; the park-SMZ
 * path does not depend on this value at all. An admitted park must already be
 * an enabled pilot park, so this can never widen the pilot's park scope.
 */
export function parseOwnerPilotAdmissionsV1(
    raw: string | null | undefined,
    enabledParks: readonly string[],
): OwnerPilotAdmissionsV1 {
    const refuse = (error: OwnerPilotAdmissionErrorV1): OwnerPilotAdmissionsV1 => ({ admissions: [], error })
    if (raw === null || raw === undefined || raw.trim() === '') return { admissions: [], error: null }

    const admissions: OwnerPilotAdmissionEntryV1[] = []
    const seen = new Set<string>()
    for (const part of raw.split(',')) {
        const entry = part.trim()
        const match = OWNER_PILOT_ADMISSION_ENTRY.exec(entry)
        if (match === null) return refuse('admission_entry_malformed')
        if (!enabledParks.includes(match[1])) return refuse('admission_park_not_enabled')
        if (seen.has(entry)) return refuse('admission_duplicate')
        seen.add(entry)
        admissions.push({ externalParkId: match[1], externalDriverProfileId: match[2], monthKey: match[3] })
    }
    if (admissions.length > OWNER_PILOT_ADMISSION_MAX_ENTRIES_V1) return refuse('admission_limit_exceeded')
    return { admissions, error: null }
}

/** The admission for one exact park and profile, or null. */
export function ownerPilotAdmissionForV1(
    admissions: readonly OwnerPilotAdmissionEntryV1[],
    externalParkId: string | null,
    externalDriverProfileId: string | null,
): OwnerPilotAdmissionV1 | null {
    if (externalParkId === null || externalDriverProfileId === null) return null
    const monthKeys = admissions
        .filter((entry) => entry.externalParkId === externalParkId && entry.externalDriverProfileId === externalDriverProfileId)
        .map((entry) => entry.monthKey)
    return monthKeys.length === 0 ? null : { monthKeys }
}

/**
 * Attaches the configured admission to a driver's facts read. The stated facts
 * are copied unchanged; only the admission field is set, and only on an exact
 * park and profile match.
 */
export function withOwnerPilotAdmissionV1<T extends {
    externalParkId: string | null
    externalDriverProfileId: string | null
    facts: CompensationEligibilityFactsV1
}>(row: T, admissions: readonly OwnerPilotAdmissionEntryV1[]): T {
    const admission = ownerPilotAdmissionForV1(admissions, row.externalParkId, row.externalDriverProfileId)
    return admission === null ? row : { ...row, facts: { ...row.facts, ownerPilotAdmission: admission } }
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

/** The facts gate's own refusals: every reason except the clocked one. */
export type CompensationPilotFactsRefusalV1 =
    Exclude<CompensationIneligibilityReasonV1, 'outside_first_calendar_month'>

export type CompensationPilotFirstMonthV1 =
    | {
        ok: true
        /** The driver's first calendar month in the park. */
        firstMonth: CompensationCalendarMonthV1
        firstMonthKey: string
        windowStartsAt: Date
        windowEndsAt: Date
    }
    | { ok: false; reason: CompensationPilotFactsRefusalV1 }

/**
 * The facts half of eligibility, with no clock: park-SMZ and the hire month.
 *
 * Stated on its own because two callers need the month without the "now is
 * inside it" test: the clocked decision below, and the order catalogue, which
 * judges each first-month order by that order's own submission window so that
 * the month's orders stay claimable through the 72 hours after it ends.
 * Both read this one gate, in this one order, so they can never disagree
 * about which month is the first or why a driver is refused on the facts.
 *
 * An Owner pilot admission stands in for park-SMZ and for nothing else. The
 * refusal order is unchanged without one; with one, the SMZ refusal is
 * reported only when the admission does not name the driver's first month.
 */
export function compensationPilotFirstMonthV1(
    facts: CompensationEligibilityFactsV1,
): CompensationPilotFirstMonthV1 {
    const smzRefusal = facts.isSelfEmployed === null || facts.isSelfEmployed === undefined
        ? 'self_employment_unknown' as const
        : isParkSelfEmployedV1(facts) ? null : 'not_self_employed' as const
    const admission = facts.ownerPilotAdmission ?? null
    if (smzRefusal !== null && admission === null) return { ok: false, reason: smzRefusal }
    if (!facts.parkHireDate) return { ok: false, reason: 'hire_date_unknown' }

    const firstMonth = parkFirstCalendarMonthV1(facts.parkHireDate)
    const firstMonthKey = compensationPeriodKeyV1(firstMonth)
    // An admission covers the months it names and never stretches to another:
    // a profile admitted for October whose first month is September is refused
    // exactly as it would be without the admission.
    if (smzRefusal !== null && admission !== null && !admission.monthKeys.includes(firstMonthKey)) {
        return { ok: false, reason: smzRefusal }
    }
    return {
        ok: true,
        firstMonth,
        firstMonthKey,
        windowStartsAt: compensationMonthStartInstantV1(firstMonth),
        windowEndsAt: compensationMonthEndInstantV1(firstMonth),
    }
}

/**
 * The pilot window runs from the hire instant to the end of that same calendar
 * month. A driver hired on the 28th gets a short window; that is the product
 * rule, not an accident, and widening it is a product decision rather than a
 * rounding choice.
 *
 * This is the driver-level statement at one instant: can this driver still be
 * served for first-month orders? Orders count only inside the first month, but
 * the monetary core keeps every order of a month claimable for 72 hours after
 * the month ends, so the driver stays eligible until that same instant
 * (compensationPeriodSubmissionClosesAtV1) and not a moment longer. Which
 * orders are actually still open is decided order by order in the catalogue
 * (cashOrderCatalogueV1).
 */
export function compensationPilotEligibilityV1(
    facts: CompensationEligibilityFactsV1,
    now: Date,
): CompensationEligibilityDecisionV1 {
    const first = compensationPilotFirstMonthV1(facts)
    if (!first.ok) return { eligible: false, reason: first.reason, firstMonthKey: null }

    const submissionClosesAt = compensationPeriodSubmissionClosesAtV1(first.firstMonth)
    if (now.getTime() < first.windowStartsAt.getTime() || now.getTime() >= submissionClosesAt.getTime()) {
        return { eligible: false, reason: 'outside_first_calendar_month', firstMonthKey: first.firstMonthKey }
    }

    return {
        eligible: true,
        firstMonth: first.firstMonth,
        firstMonthKey: first.firstMonthKey,
        windowEndsAt: first.windowEndsAt,
    }
}

/**
 * Which rule passes the facts gate, for reports and logs; null when the facts
 * gate refuses. Park-SMZ wins when both apply, so an admission is only ever
 * reported for a driver who needed it.
 */
export function compensationPilotAdmissionBasisV1(
    facts: CompensationEligibilityFactsV1,
): CompensationPilotAdmissionBasisV1 | null {
    if (!compensationPilotFirstMonthV1(facts).ok) return null
    return isParkSelfEmployedV1(facts) ? 'park_smz' : 'owner_pilot_admission'
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
