/**
 * Lineage digest for a canonical person the pilot resolved.
 *
 * The lineage comes from Contacts' public lineage read. The digest must be
 * computed over exactly the lineage presented, using the same rule everywhere,
 * so two callers never disagree about the same person.
 */

import { createHash } from 'node:crypto'

export function compensationLineageDigestV1(lineage: readonly string[]): string {
    const ordered = [...new Set(lineage)].sort()
    return createHash('sha256').update(ordered.join(',')).digest('hex')
}
