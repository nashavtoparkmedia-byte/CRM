/**
 * M2A2-TG1 Telegram provider-account domain.
 *
 * Pure decision logic. The identity authority is the provider-authenticated
 * `getMe()` id and nothing else: no phone number, no display name, no session
 * row id, no environment string, and not the `TelegramConnection` primary key
 * even though today's single row happens to be keyed by its account id.
 *
 * The durable decision is made from the account the open binding already names,
 * never from a process-local cache, so it has no database, no clock and no I/O
 * and every case in the decision table is directly testable.
 */

/** A Telegram bot is a Telegram user, so both kinds share one provider id space. */
export const TELEGRAM_ACCOUNT_KINDS_V1 = ['mtproto_user', 'bot_api'] as const
export type TelegramAccountKindV1 = (typeof TELEGRAM_ACCOUNT_KINDS_V1)[number]

export const TELEGRAM_TRANSPORT_KINDS_V1 = ['mtproto_session', 'bot_runtime'] as const
export type TelegramTransportKindV1 = (typeof TELEGRAM_TRANSPORT_KINDS_V1)[number]

/** Which transport kind may carry which principal. */
export const TELEGRAM_TRANSPORT_KIND_BY_ACCOUNT_KIND_V1: Readonly<Record<TelegramAccountKindV1, TelegramTransportKindV1>> = Object.freeze({
    mtproto_user: 'mtproto_session',
    bot_api: 'bot_runtime',
})

/**
 * One principal exactly as `getMe()` reported it. The id is kept in provider
 * form: a decimal string, never normalized, parsed or shortened.
 */
export interface AttestedPrincipalV1 {
    providerUserId: string
    accountKind: TelegramAccountKindV1
}

/** The slot's open binding, and the account it names, as the database holds them. */
export interface OpenBindingSnapshotV1 {
    bindingId: string
    accountId: string
    /** The provider id of the account this binding is bound to. */
    accountProviderUserId: string
    accountKind: TelegramAccountKindV1
    trustState: 'pending' | 'verified'
    attestedProviderUserId: string | null
    /** Epoch milliseconds of `attestedUntil`, or null when nothing is attested yet. */
    attestedUntilMs: number | null
    transportGeneration: number
}

export const TELEGRAM_ATTESTATION_ACTIONS_V1 = [
    'none',
    'open_first_generation',
    'reattest_open_generation',
    'replace_on_principal_change',
    'refuse',
] as const
export type TelegramAttestationActionV1 = (typeof TELEGRAM_ATTESTATION_ACTIONS_V1)[number]

export const TELEGRAM_ATTESTATION_OUTCOMES_V1 = [
    'opened_first_generation',
    'reattested',
    'attestation_still_fresh',
    'replaced_on_principal_change',
    'principal_not_usable',
    'transport_kind_mismatch',
] as const
export type TelegramAttestationOutcomeV1 = (typeof TELEGRAM_ATTESTATION_OUTCOMES_V1)[number]

export interface TelegramAttestationDecisionV1 {
    action: TelegramAttestationActionV1
    outcome: TelegramAttestationOutcomeV1
    /** The close reason to record on the previous binding, when one is replaced. */
    closeReason: 'principal_changed' | null
}

/**
 * The database caps an attestation window at one hour. This is shorter so that
 * clock skew between this process and the database can never place a window
 * outside `(lastAttestedAt, lastAttestedAt + 1 hour]`.
 */
export const ATTESTATION_WINDOW_MS_V1 = 45 * 60 * 1000

/** A live attestation is refreshed only once less than this remains. */
export const ATTESTATION_REFRESH_FLOOR_MS_V1 = 15 * 60 * 1000

const PROVIDER_USER_ID = /^[0-9]{1,64}$/u

/** True only for an id in exact provider form: a bare decimal string. */
export function isExactProviderUserIdV1(value: unknown): value is string {
    return typeof value === 'string' && PROVIDER_USER_ID.test(value) && value === value.trim()
}

export function isUsablePrincipalV1(principal: { providerUserId?: unknown; accountKind?: unknown } | null | undefined): principal is AttestedPrincipalV1 {
    if (!principal) return false
    if (!isExactProviderUserIdV1(principal.providerUserId)) return false
    return (TELEGRAM_ACCOUNT_KINDS_V1 as readonly unknown[]).includes(principal.accountKind)
}

/** The open-binding key that carries one-open-binding-per-transport as a unique constraint. */
export function openTransportKeyV1(transportKind: TelegramTransportKindV1, transportRef: string): string {
    return `${transportKind}:${transportRef}`
}

export interface TelegramAttestationInputV1 {
    /** The principal a live getMe() proved, or null when it was not usable. */
    observed: AttestedPrincipalV1 | null
    /** The transport the attestation arrived on. */
    transportKind: TelegramTransportKindV1
    /** The slot's open binding, or null when none is open. */
    openBinding: OpenBindingSnapshotV1 | null
    /** The database clock, read in the same transaction. */
    dbNowMs: number
    refreshFloorMs?: number
}

/**
 * The single durable decision for one attestation.
 *
 * Identity comes from the account the open binding names, compared against the
 * principal the provider just authenticated. A different principal is never
 * merged into the existing account and never re-points the binding: the old
 * generation closes and a new one opens under the account that owns that
 * principal.
 */
export function decideTelegramTransportAttestationV1(input: TelegramAttestationInputV1): TelegramAttestationDecisionV1 {
    const { observed, openBinding, dbNowMs, transportKind } = input
    const refreshFloorMs = input.refreshFloorMs ?? ATTESTATION_REFRESH_FLOOR_MS_V1

    if (observed === null) {
        return { action: 'none', outcome: 'principal_not_usable', closeReason: null }
    }
    if (TELEGRAM_TRANSPORT_KIND_BY_ACCOUNT_KIND_V1[observed.accountKind] !== transportKind) {
        return { action: 'refuse', outcome: 'transport_kind_mismatch', closeReason: null }
    }
    if (openBinding === null) {
        return { action: 'open_first_generation', outcome: 'opened_first_generation', closeReason: null }
    }

    if (openBinding.accountProviderUserId !== observed.providerUserId || openBinding.accountKind !== observed.accountKind) {
        return { action: 'replace_on_principal_change', outcome: 'replaced_on_principal_change', closeReason: 'principal_changed' }
    }

    // A lapsed window is revived by this attestation rather than superseded:
    // on Telegram the provider authentication is itself the proof, so there is
    // no state a re-attestation cannot restore. Only a changed principal opens
    // a new generation.
    if (openBinding.attestedUntilMs !== null && openBinding.attestedUntilMs - dbNowMs > refreshFloorMs) {
        return { action: 'none', outcome: 'attestation_still_fresh', closeReason: null }
    }

    return { action: 'reattest_open_generation', outcome: 'reattested', closeReason: null }
}

/** The attestation window for a write, derived from the database clock. */
export function attestationWindowUntilV1(dbNowMs: number): Date {
    return new Date(dbNowMs + ATTESTATION_WINDOW_MS_V1)
}

export const TELEGRAM_ACCOUNT_READINESS_V1 = [
    'ready',
    'stale_attestation',
    'not_admitted',
    'no_open_transport',
] as const
export type TelegramAccountReadinessV1 = (typeof TELEGRAM_ACCOUNT_READINESS_V1)[number]

/**
 * Readiness is derived, never stored. Lifecycle answers whether the account is
 * admitted; readiness answers whether a transport is currently proven to be
 * acting as it. They are different questions and a healthy account is routinely
 * stale, because an attestation window is short by design.
 */
export function deriveReadinessV1(input: {
    lifecycle: string
    openBinding: { trustState: string; attestedUntilMs: number | null } | null
    dbNowMs: number
}): TelegramAccountReadinessV1 {
    if (input.lifecycle !== 'active') return 'not_admitted'
    const binding = input.openBinding
    if (binding === null) return 'no_open_transport'
    if (binding.trustState !== 'verified') return 'no_open_transport'
    if (binding.attestedUntilMs === null || binding.attestedUntilMs <= input.dbNowMs) return 'stale_attestation'
    return 'ready'
}
