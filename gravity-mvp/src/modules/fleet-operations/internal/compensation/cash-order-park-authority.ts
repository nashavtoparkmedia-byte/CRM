/**
 * Which connection a compensation-enabled park is ingested through.
 *
 * The credential capability cannot answer this on its own: it returns every
 * active link without deduplicating, overwrites the connection's park id with
 * the link's, and falls back to every stored connection when no link is
 * active. Authority therefore comes from connection metadata first, with no
 * credential read at all, and the credential list is only cross-checked
 * against it afterwards.
 *
 * Every rule fails closed. A park that is not provably served by exactly one
 * consistent active link gets no provider request and no checkpoint progress,
 * and there is never a first-wins choice between candidates. Other parks are
 * unaffected.
 */

export const CASH_ORDER_AUTHORITY_FAILURES_V1 = [
    'park_not_active',
    'park_connection_missing',
    'ambiguous_active_connection',
    'connection_park_mismatch',
    'authority_credential_mismatch',
] as const

export type CashOrderAuthorityFailureV1 = typeof CASH_ORDER_AUTHORITY_FAILURES_V1[number]

/** An active Park row. */
export interface CashOrderActiveParkV1 {
    id: string
    externalParkId: string
}

/**
 * An active link: enabled, not archived, on an active park. Metadata only; the
 * read that produces it never selects a client id or key.
 */
export interface CashOrderActiveLinkV1 {
    linkId: string
    /** ParkConnection.parkId, the local park the link is attached to. */
    localParkId: string
    /** ParkConnection.externalParkId, the park id actually sent to Yandex. */
    linkExternalParkId: string
    /** Park.externalParkId of the park the link is attached to. */
    parkExternalParkId: string
    apiConnectionId: string
    /** ApiConnection.parkId as stored on the connection itself. */
    apiConnectionParkId: string
}

export interface CashOrderAuthoritySnapshotV1 {
    parks: readonly CashOrderActiveParkV1[]
    links: readonly CashOrderActiveLinkV1[]
}

export type CashOrderParkAuthorityV1 =
    | {
        status: 'authoritative'
        externalParkId: string
        localParkId: string
        linkId: string
        connectionId: string
    }
    | {
        status: 'failed'
        externalParkId: string
        code: Exclude<CashOrderAuthorityFailureV1, 'authority_credential_mismatch'>
    }

/**
 * Classifies one enabled park against the whole active-link set.
 *
 * The candidates are the links attached to the park plus any link on another
 * park that carries this park's external id, because that value is what would
 * be sent to Yandex. Exactly one candidate whose three ids agree, and whose
 * external id no other active link carries, is authoritative.
 */
export function classifyCashOrderParkAuthorityV1(
    externalParkId: string,
    snapshot: CashOrderAuthoritySnapshotV1,
): CashOrderParkAuthorityV1 {
    const failed = (code: Exclude<CashOrderAuthorityFailureV1, 'authority_credential_mismatch'>): CashOrderParkAuthorityV1 =>
        ({ status: 'failed', externalParkId, code })

    const parks = snapshot.parks.filter((park) => park.externalParkId === externalParkId)
    if (parks.length === 0) return failed('park_not_active')
    // Park.externalParkId is unique, so two rows mean the snapshot itself is
    // not trustworthy. Refuse rather than pick one.
    if (parks.length > 1) return failed('ambiguous_active_connection')
    const park = parks[0]

    const candidates = new Map<string, CashOrderActiveLinkV1>()
    for (const link of snapshot.links) {
        if (link.localParkId === park.id || link.linkExternalParkId === externalParkId) {
            candidates.set(link.linkId, link)
        }
    }
    if (candidates.size === 0) return failed('park_connection_missing')
    if (candidates.size > 1) return failed('ambiguous_active_connection')

    const [link] = [...candidates.values()]
    const sharedExternalId = snapshot.links.some((other) => (
        other.linkId !== link.linkId && other.linkExternalParkId === link.linkExternalParkId
    ))
    if (sharedExternalId) return failed('ambiguous_active_connection')

    const consistent = link.localParkId === park.id
        && link.linkExternalParkId === externalParkId
        && link.parkExternalParkId === externalParkId
        && link.apiConnectionParkId === externalParkId
    if (!consistent) return failed('connection_park_mismatch')

    return {
        status: 'authoritative',
        externalParkId,
        localParkId: park.id,
        linkId: link.linkId,
        connectionId: link.apiConnectionId,
    }
}

/** The fields of a credential entry the cross-check reads. Never the secrets. */
export interface CashOrderCredentialIdentityV1 {
    connectionId: string
    localParkId: string | null
    parkId: string
}

export type CashOrderCredentialCrossCheckV1<T> =
    | { ok: true; entry: T }
    | { ok: false; code: 'authority_credential_mismatch' }

/**
 * Binds an authoritative park to exactly one credential entry.
 *
 * Exactly one entry must carry the park's external id, exactly one must carry
 * its local id, they must be the same entry, and that entry must be the
 * authoritative connection. This catches the capability's legacy fallback
 * (whose entries carry no local park) and a duplicate link added between the
 * metadata read and the credential read.
 */
export function crossCheckCashOrderCredentialsV1<T extends CashOrderCredentialIdentityV1>(
    authority: Extract<CashOrderParkAuthorityV1, { status: 'authoritative' }>,
    entries: readonly T[],
): CashOrderCredentialCrossCheckV1<T> {
    const byExternal = entries.filter((entry) => entry.parkId === authority.externalParkId)
    const byLocal = entries.filter((entry) => entry.localParkId === authority.localParkId)
    if (byExternal.length !== 1 || byLocal.length !== 1) return { ok: false, code: 'authority_credential_mismatch' }
    const [entry] = byExternal
    if (entry !== byLocal[0] || entry.connectionId !== authority.connectionId) {
        return { ok: false, code: 'authority_credential_mismatch' }
    }
    return { ok: true, entry }
}
