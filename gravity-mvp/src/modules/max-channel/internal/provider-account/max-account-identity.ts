/**
 * M2A2-MAX1A MAX provider-account domain.
 *
 * Pure decision logic. The identity authority is the principal the MAX runtime
 * was authenticated as on the live WebSocket and nothing else: no phone number,
 * no display name, no `MaxConnection` row id, no environment string and no
 * historical `MaxRouteIdentityBinding` value.
 *
 * MAX has no notion of an authentication that expires: the provider confirms the
 * principal in an auth frame and says nothing about how long it remains true.
 * There is therefore no attestation window here and no derived freshness state.
 * `lastAttestedAt` is evidence of when the principal was last seen, never a
 * state. Operational transport health belongs to the MAX runtime surface and is
 * deliberately not represented in this domain.
 *
 * The durable decision is made from the account the open binding already names,
 * so it has no database, no clock and no I/O and every case in the decision
 * table is directly testable.
 */

/** The transport classes this foundation knows. Today MAX runs exactly one. */
export const MAX_TRANSPORT_KINDS_V1 = ['web_session'] as const
export type MaxTransportKindV1 = (typeof MAX_TRANSPORT_KINDS_V1)[number]

/** Which live frame carried the principal. Diagnostic only, never an identity source. */
export const MAX_AUTH_EVENT_KINDS_V1 = ['ws_auth_op19', 'ws_owner_op53'] as const
export type MaxAuthEventKindV1 = (typeof MAX_AUTH_EVENT_KINDS_V1)[number]

/** The only reason a generation is ever closed today. */
export const MAX_BINDING_CLOSE_REASONS_V1 = ['principal_changed'] as const
export type MaxBindingCloseReasonV1 = (typeof MAX_BINDING_CLOSE_REASONS_V1)[number]

/**
 * The YOKO-owned transport locator. It names the configured MAX transport, never
 * the principal, and its shape makes a collision with a provider id impossible.
 */
const TRANSPORT_REF = /^max-personal-[0-9a-f]{24}$/u

/**
 * A provider principal in exact provider form. MAX ids are opaque: they are kept
 * as the provider sent them and are never parsed as a number. The charset
 * follows the account-id shape the MAX runtime already uses.
 */
const PROVIDER_USER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u

/** Values the MAX runtime itself refuses to treat as a principal. */
const PRINCIPAL_SENTINELS: ReadonlySet<string> = new Set(['legacy', 'max-default'])

/** One principal exactly as the live auth frame reported it. */
export interface AttestedPrincipalV1 {
    providerUserId: string
}

/** The transport's open binding, and the account it names, as the database holds them. */
export interface OpenBindingSnapshotV1 {
    bindingId: string
    accountId: string
    /** The provider id of the account this binding is bound to. */
    accountProviderUserId: string
    attestedProviderUserId: string | null
    transportGeneration: number
}

export const MAX_ATTESTATION_ACTIONS_V1 = [
    'none',
    'open_first_generation',
    'reattest_existing_generation',
    'replace_on_principal_change',
    'refuse',
] as const
export type MaxAttestationActionV1 = (typeof MAX_ATTESTATION_ACTIONS_V1)[number]

export const MAX_ATTESTATION_OUTCOMES_V1 = [
    'opened_first_generation',
    'reattested',
    'replaced_on_principal_change',
    'principal_not_usable',
    'transport_kind_mismatch',
    'transport_ref_malformed',
] as const
export type MaxAttestationOutcomeV1 = (typeof MAX_ATTESTATION_OUTCOMES_V1)[number]

export interface MaxAttestationDecisionV1 {
    action: MaxAttestationActionV1
    outcome: MaxAttestationOutcomeV1
    /** The close reason to record on the previous binding, when one is replaced. */
    closeReason: MaxBindingCloseReasonV1 | null
}

/** True only for a principal in exact provider form that the runtime would use. */
export function isExactProviderUserIdV1(value: unknown): value is string {
    return typeof value === 'string'
        && value === value.trim()
        && PROVIDER_USER_ID.test(value)
        && !PRINCIPAL_SENTINELS.has(value)
}

export function isUsablePrincipalV1(
    principal: { providerUserId?: unknown } | null | undefined,
): principal is AttestedPrincipalV1 {
    if (!principal) return false
    return isExactProviderUserIdV1(principal.providerUserId)
}

/** True only for the YOKO transport locator shape. */
export function isExactTransportRefV1(value: unknown): value is string {
    return typeof value === 'string' && TRANSPORT_REF.test(value)
}

export function isMaxTransportKindV1(value: unknown): value is MaxTransportKindV1 {
    return (MAX_TRANSPORT_KINDS_V1 as readonly unknown[]).includes(value)
}

export function isMaxAuthEventKindV1(value: unknown): value is MaxAuthEventKindV1 {
    return (MAX_AUTH_EVENT_KINDS_V1 as readonly unknown[]).includes(value)
}

/** The open-binding key that carries one-open-binding-per-transport as a unique constraint. */
export function openTransportKeyV1(transportKind: MaxTransportKindV1, transportRef: string): string {
    return `${transportKind}:${transportRef}`
}

export interface MaxAttestationInputV1 {
    /** The principal a live auth frame proved, or null when it was not usable. */
    observed: AttestedPrincipalV1 | null
    /** The transport the attestation arrived on. */
    transportKind: MaxTransportKindV1
    /** The YOKO locator of that transport. */
    transportRef: string
    /** The transport's open binding, or null when none is open. */
    openBinding: OpenBindingSnapshotV1 | null
}

/**
 * The single durable decision for one observation.
 *
 * Identity comes from the account the open binding already names, compared
 * against the principal the runtime just proved. A different principal is never
 * merged into the existing account and never re-points the binding: the old
 * generation closes and a new one opens under the account that owns that
 * principal.
 *
 * Unlike Telegram there is no freshness branch, because MAX publishes no expiry.
 * Observing the same principal again always records the new evidence on the open
 * generation rather than deciding whether the previous evidence is still valid.
 */
export function decideMaxTransportAttestationV1(input: MaxAttestationInputV1): MaxAttestationDecisionV1 {
    const { observed, openBinding } = input

    if (!isMaxTransportKindV1(input.transportKind)) {
        return { action: 'refuse', outcome: 'transport_kind_mismatch', closeReason: null }
    }
    if (!isExactTransportRefV1(input.transportRef)) {
        return { action: 'refuse', outcome: 'transport_ref_malformed', closeReason: null }
    }
    if (observed === null) {
        return { action: 'none', outcome: 'principal_not_usable', closeReason: null }
    }
    if (openBinding === null) {
        return { action: 'open_first_generation', outcome: 'opened_first_generation', closeReason: null }
    }
    if (openBinding.accountProviderUserId !== observed.providerUserId) {
        return { action: 'replace_on_principal_change', outcome: 'replaced_on_principal_change', closeReason: 'principal_changed' }
    }
    return { action: 'reattest_existing_generation', outcome: 'reattested', closeReason: null }
}

export const MAX_IDENTITY_STATES_V1 = [
    'no_open_transport',
    'not_admitted',
    'identity_established',
] as const
export type MaxIdentityStateV1 = (typeof MAX_IDENTITY_STATES_V1)[number]

/**
 * Identity state is derived, never stored, and it is derived only from durable
 * owner-side facts. It answers "is a transport durably bound to an admitted
 * account", not "is the MAX runtime healthy right now": that second question is
 * answered by the MAX runtime surface and is deliberately absent here.
 */
export function deriveIdentityStateV1(input: {
    lifecycle: string | null
    hasOpenBinding: boolean
}): MaxIdentityStateV1 {
    if (!input.hasOpenBinding) return 'no_open_transport'
    if (input.lifecycle !== 'active') return 'not_admitted'
    return 'identity_established'
}
