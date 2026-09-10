/**
 * Boundary types the monetary core consumes.
 *
 * Both of these are ports, not implementations. The Contacts resolver and the
 * Yandex order adapter live outside this stage; the monetary core is written
 * and tested entirely against these two shapes, so it does not depend on the
 * current Driver-to-Contact population or on live fleet data.
 */

/**
 * Canonical-person evidence, as Contacts will eventually supply it.
 *
 * `lineage` is the transitive closure of contact ids that have been merged into
 * the canonical contact, including the canonical contact itself. Contacts keeps
 * merges as an append-only journal and archives rather than deletes a merged
 * contact, so the closure only ever grows — which is what lets a merge extend a
 * monetary identity instead of creating a new one.
 */
export interface ProvenCanonicalPersonV1 {
    canonicalContactId: string
    resolutionStatus: 'live' | 'merged_into'
    lineage: readonly string[]
    lineageDigest: string
    evidenceAt: Date
}

/**
 * A cash order that has already been verified against the provider by a trusted
 * adapter. The monetary core never fetches this itself and never re-derives it.
 *
 * `externalParkId` comes from the connection the order was fetched through: the
 * provider's order payload carries no park identifier of its own.
 */
export interface VerifiedCashOrderV1 {
    provider: string
    externalParkId: string
    externalOrderId: string
    /** Provider-local display number. Never part of an identity key. */
    shortOrderIdDisplay: string | null
    /** Raw provider price string, retained verbatim as evidence. */
    rawPrice: string
    /** Completion instant, the anchor for the business month and the deadline. */
    endedAt: Date
    /** When the trusted adapter verified this order against the provider. */
    verifiedAt: Date
}

export interface CompensationOrderKeyV1 {
    provider: string
    externalParkId: string
    externalOrderId: string
}

export function compensationOrderKeyV1(order: VerifiedCashOrderV1): CompensationOrderKeyV1 {
    return {
        provider: order.provider,
        externalParkId: order.externalParkId,
        externalOrderId: order.externalOrderId,
    }
}

export function compensationOrderKeyEqualsV1(
    left: CompensationOrderKeyV1,
    right: CompensationOrderKeyV1,
): boolean {
    return left.provider === right.provider
        && left.externalParkId === right.externalParkId
        && left.externalOrderId === right.externalOrderId
}

/** Stable printable form of the logical order key, for audit and diagnostics. */
export function compensationOrderKeyLabelV1(key: CompensationOrderKeyV1): string {
    return `${key.provider}:${key.externalParkId}:${key.externalOrderId}`
}

/** Authenticated operator behind a monetary operation. No new RBAC is introduced. */
export interface CompensationPrincipalV1 {
    principalId: string
    principalKind: 'crm_user' | 'integration_admin' | 'system'
    operatorLabel: string | null
}
