/**
 * Merge-safe mapping from canonical-person evidence to a stable monetary
 * identity.
 *
 * The rule that carries the invariant is small: a binding row claims one
 * contact id for one CompensationPerson and is never re-pointed. A merge only
 * ever extends the lineage of the surviving contact with ids that already
 * exist, so any member of the lineage still finds the same monetary person.
 * Nothing here touches a Contact row, and nothing here writes into Contacts.
 */

import type { ProvenCanonicalPersonV1 } from './compensation-ports'

export interface CompensationPersonBindingRecordV1 {
    compensationPersonId: string
    contactId: string
}

export type CompensationPersonResolutionV1 =
    | {
        /** No binding exists yet for any lineage member. */
        status: 'create'
        contactIds: string[]
    }
    | {
        /** Exactly one monetary person owns part of the lineage. */
        status: 'existing'
        compensationPersonId: string
        /** Lineage members not yet bound; binding them is idempotent. */
        missingContactIds: string[]
    }
    | {
        /** Equivalent lineage resolves to several monetary people. */
        status: 'fail_closed'
        compensationPersonIds: string[]
    }

export type CompensationPersonResolutionErrorCodeV1 =
    | 'EVIDENCE_INVALID'
    | 'LINEAGE_EMPTY'

export class CompensationPersonResolutionErrorV1 extends Error {
    readonly code: CompensationPersonResolutionErrorCodeV1
    constructor(code: CompensationPersonResolutionErrorCodeV1, message: string) {
        super(message)
        this.name = 'CompensationPersonResolutionErrorV1'
        this.code = code
    }
}

/**
 * Every contact id the evidence covers, deduplicated and sorted. Sorted output
 * is what makes the adapter's row locking deterministic.
 */
export function compensationLineageContactIdsV1(evidence: ProvenCanonicalPersonV1): string[] {
    if (typeof evidence?.canonicalContactId !== 'string' || evidence.canonicalContactId.trim() === '') {
        throw new CompensationPersonResolutionErrorV1('EVIDENCE_INVALID', 'canonicalContactId is required')
    }
    if (!Array.isArray(evidence.lineage)) {
        throw new CompensationPersonResolutionErrorV1('EVIDENCE_INVALID', 'lineage must be an array')
    }
    const ids = new Set<string>([evidence.canonicalContactId])
    for (const contactId of evidence.lineage) {
        if (typeof contactId !== 'string' || contactId.trim() === '') {
            throw new CompensationPersonResolutionErrorV1('EVIDENCE_INVALID', 'lineage entries must be non-empty strings')
        }
        ids.add(contactId)
    }
    if (ids.size === 0) {
        throw new CompensationPersonResolutionErrorV1('LINEAGE_EMPTY', 'lineage resolved to nothing')
    }
    return [...ids].sort()
}

/**
 * Decide what the adapter should do, given the evidence and the owner-local
 * bindings currently visible for that lineage.
 *
 * This function is also the retry body: after a unique-constraint conflict the
 * adapter rereads bindings and calls it again rather than surfacing the raw
 * database failure.
 */
export function resolveCompensationPersonV1(
    evidence: ProvenCanonicalPersonV1,
    bindings: readonly CompensationPersonBindingRecordV1[],
): CompensationPersonResolutionV1 {
    const lineage = compensationLineageContactIdsV1(evidence)
    const lineageSet = new Set(lineage)

    const relevant = bindings.filter((binding) => lineageSet.has(binding.contactId))
    const personIds = [...new Set(relevant.map((binding) => binding.compensationPersonId))].sort()

    if (personIds.length === 0) {
        return { status: 'create', contactIds: lineage }
    }
    if (personIds.length > 1) {
        return { status: 'fail_closed', compensationPersonIds: personIds }
    }

    const bound = new Set(relevant.map((binding) => binding.contactId))
    return {
        status: 'existing',
        compensationPersonId: personIds[0],
        missingContactIds: lineage.filter((contactId) => !bound.has(contactId)),
    }
}

/** Deterministic lock order for several monetary people in one transaction. */
export function compensationPersonLockOrderV1(compensationPersonIds: readonly string[]): string[] {
    return [...new Set(compensationPersonIds)].sort()
}
