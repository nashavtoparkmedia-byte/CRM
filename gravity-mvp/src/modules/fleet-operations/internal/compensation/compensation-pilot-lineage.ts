/**
 * Lineage digest for a canonical person the pilot resolved.
 *
 * The pilot presents a single canonical contact, because the identity repair
 * has already merged any duplicate away. The digest must therefore be computed
 * over exactly the lineage presented, using the same rule everywhere, so two
 * callers never disagree about the same person.
 */

import { createHash } from 'node:crypto'

export function compensationLineageDigestV1(lineage: readonly string[]): string {
    const ordered = [...new Set(lineage)].sort()
    return createHash('sha256').update(ordered.join(',')).digest('hex')
}

export function compensationLineageDigestForContactV1(contactId: string): string {
    return compensationLineageDigestV1([contactId])
}
