/**
 * Which contact lineages the pilot admits as one monetary person, and the
 * digest of the lineage it admitted.
 *
 * The lineage comes from Contacts' public lineage read. Both the admission rule
 * and the digest must be the same rule everywhere, so two callers never
 * disagree about the same person: the Telegram submission path and the
 * readiness proof ask this module rather than each keeping a copy of the rule.
 * A second copy could drift, and a readiness proof that admitted a person the
 * submission path refuses would report a driver the product cannot serve.
 *
 * The admitted contract is deliberately narrow: exactly one contact, which is
 * its own canonical contact. Contacts' lineage read does not yet exclude
 * recovered merges or follow a chain transitively, so binding a wider lineage
 * could attach an unrelated person to a monetary identity, and C1 never
 * re-points a binding once made. Widening this is a separate milestone; this
 * module decides admission only and never widens it.
 */

import { createHash } from 'node:crypto'

export function compensationLineageDigestV1(lineage: readonly string[]): string {
    const ordered = [...new Set(lineage)].sort()
    return createHash('sha256').update(ordered.join(',')).digest('hex')
}

/** Contacts' lineage read, as every pilot caller receives it. */
export type PilotContactLineageReadV1 =
    | { status: 'resolved'; canonicalContactId: string; contactIds: readonly string[] }
    | { status: 'missing' }
    /** Contacts could not walk the merge redirects to one canonical contact. */
    | { status: 'unresolvable' }

/**
 * Why a lineage is not admissible. These are classifications, not messages:
 * each caller maps them onto its own refusal vocabulary, so the shared rule
 * decides admission without dictating how a surface words it.
 */
export const PILOT_LINEAGE_ADMISSION_REFUSALS_V1 = [
    'lineage_missing',
    'lineage_unresolvable',
    /** Resolved, but to a different contact than the one presented. */
    'lineage_not_canonical',
    /** Resolved to this contact, but joined with others into one person. */
    'lineage_not_singleton',
] as const

export type PilotLineageAdmissionRefusalV1 = typeof PILOT_LINEAGE_ADMISSION_REFUSALS_V1[number]

export type PilotLineageAdmissionV1 =
    | {
        admitted: true
        canonicalContactId: string
        /** Exactly the admitted lineage. Callers bind this, never a rebuilt one. */
        lineage: readonly string[]
    }
    | { admitted: false; refusal: PilotLineageAdmissionRefusalV1 }

/**
 * Whether one contact may be bound as a monetary person.
 *
 * The order of the checks is part of the contract: an unresolvable lineage is
 * an unknown and is reported as such before anything is said about canonical
 * identity, and canonical identity is settled before the lineage's breadth.
 */
export function admitPilotContactLineageV1(
    requestedContactId: string,
    read: PilotContactLineageReadV1,
): PilotLineageAdmissionV1 {
    if (read.status === 'unresolvable') return { admitted: false, refusal: 'lineage_unresolvable' }
    if (read.status !== 'resolved') return { admitted: false, refusal: 'lineage_missing' }
    if (read.canonicalContactId !== requestedContactId) {
        return { admitted: false, refusal: 'lineage_not_canonical' }
    }
    if (read.contactIds.length !== 1 || read.contactIds[0] !== requestedContactId) {
        return { admitted: false, refusal: 'lineage_not_singleton' }
    }
    return {
        admitted: true,
        canonicalContactId: read.canonicalContactId,
        lineage: read.contactIds,
    }
}
