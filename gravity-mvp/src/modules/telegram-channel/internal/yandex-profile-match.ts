/**
 * Exact phone matching from a Telegram-attested number to a Yandex driver
 * profile.
 *
 * This is the first hop of the identity chain, so it decides whether the
 * Telegram-to-driver link can be used as provenance at all. It previously
 * compared numbers with a two-way substring test and, when several profiles
 * matched, picked whichever was not fired and otherwise the first in the list.
 * A substring test makes a shorter number match a longer one, and picking the
 * first of several is a guess, so the resulting link could not support a
 * monetary claim.
 *
 * The rule here is exact equality on digits, and several matches inside one
 * park is an ambiguity that fails closed. Names are never compared.
 */

/** Digits only, so formatting differences never decide identity. */
export function phoneDigitsV1(raw: string | null | undefined): string | null {
    if (!raw || typeof raw !== 'string') return null
    const digits = raw.replace(/\D/g, '')
    return digits.length === 0 ? null : digits
}

/**
 * Russian numbers reach us as both 8XXXXXXXXXX and 7XXXXXXXXXX for the same
 * line. Comparing the trailing ten digits treats those as equal without
 * matching anything shorter, which a substring test would.
 */
export function comparablePhoneV1(raw: string | null | undefined): string | null {
    const digits = phoneDigitsV1(raw)
    if (!digits || digits.length < 10) return null
    return digits.slice(-10)
}

export interface YandexProfileCandidateV1 {
    /** driver_profile.id */
    id: string
    /** driver_profile.phones */
    phones: readonly string[]
    /** driver_profile.work_status */
    workStatus: string | null
}

export type YandexProfileMatchV1 =
    | { kind: 'matched'; profileId: string }
    | { kind: 'no_match' }
    | { kind: 'ambiguous'; profileIds: readonly string[] }

/**
 * One park, one attested phone. Any profile whose phone list contains that
 * exact line matches; two matching profiles in a single park mean the park
 * data cannot tell the person apart, and that is not ours to resolve.
 */
export function matchYandexProfileByExactPhoneV1(
    attestedPhone: string,
    candidates: readonly YandexProfileCandidateV1[],
): YandexProfileMatchV1 {
    const target = comparablePhoneV1(attestedPhone)
    if (!target) return { kind: 'no_match' }

    const matches = candidates.filter((candidate) =>
        (candidate.phones ?? []).some((phone) => comparablePhoneV1(phone) === target))

    if (matches.length === 0) return { kind: 'no_match' }
    if (matches.length === 1) return { kind: 'matched', profileId: matches[0].id }

    // A fired profile alongside a working one is the documented park "swap":
    // the same person re-registered. One survivor makes that unambiguous.
    const active = matches.filter((candidate) => candidate.workStatus !== 'fired')
    if (active.length === 1) return { kind: 'matched', profileId: active[0].id }

    return { kind: 'ambiguous', profileIds: matches.map((candidate) => candidate.id) }
}
