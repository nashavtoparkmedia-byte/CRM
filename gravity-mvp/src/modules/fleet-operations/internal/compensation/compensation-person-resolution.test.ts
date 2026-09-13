import { describe, expect, it } from 'vitest'
import {
    CompensationPersonResolutionErrorV1,
    compensationLineageContactIdsV1,
    compensationPersonLockOrderV1,
    resolveCompensationPersonV1,
    type CompensationPersonBindingRecordV1,
} from './compensation-person-resolution'
import type { ProvenCanonicalPersonV1 } from './compensation-ports'

function evidence(canonicalContactId: string, lineage: string[] = []): ProvenCanonicalPersonV1 {
    return {
        canonicalContactId,
        resolutionStatus: lineage.length === 0 ? 'live' : 'merged_into',
        lineage,
        lineageDigest: `digest:${[canonicalContactId, ...lineage].sort().join('|')}`,
        evidenceAt: new Date('2026-09-10T00:00:00.000Z'),
    }
}

describe('compensationLineageContactIdsV1', () => {
    it('includes the canonical contact and deduplicates', () => {
        expect(compensationLineageContactIdsV1(evidence('c_b', ['c_a', 'c_b', 'c_c'])))
            .toEqual(['c_a', 'c_b', 'c_c'])
    })

    it('sorts, so row locking is deterministic', () => {
        expect(compensationLineageContactIdsV1(evidence('c_z', ['c_m', 'c_a'])))
            .toEqual(['c_a', 'c_m', 'c_z'])
    })

    it('refuses malformed evidence rather than guessing', () => {
        expect(() => compensationLineageContactIdsV1({ ...evidence('c_a'), canonicalContactId: '' }))
            .toThrowError(CompensationPersonResolutionErrorV1)
        expect(() => compensationLineageContactIdsV1(
            { ...evidence('c_a'), lineage: [''] } as ProvenCanonicalPersonV1,
        )).toThrowError(CompensationPersonResolutionErrorV1)
    })
})

describe('resolveCompensationPersonV1', () => {
    it('creates a person when nothing in the lineage is bound', () => {
        expect(resolveCompensationPersonV1(evidence('c_a'), [])).toEqual({
            status: 'create',
            contactIds: ['c_a'],
        })
    })

    it('returns the existing person when one lineage member is bound', () => {
        const bindings: CompensationPersonBindingRecordV1[] = [
            { compensationPersonId: 'p1', contactId: 'c_a' },
        ]
        expect(resolveCompensationPersonV1(evidence('c_b', ['c_a']), bindings)).toEqual({
            status: 'existing',
            compensationPersonId: 'p1',
            missingContactIds: ['c_b'],
        })
    })

    it('reports nothing missing when the whole lineage is already bound', () => {
        const bindings: CompensationPersonBindingRecordV1[] = [
            { compensationPersonId: 'p1', contactId: 'c_a' },
            { compensationPersonId: 'p1', contactId: 'c_b' },
        ]
        expect(resolveCompensationPersonV1(evidence('c_b', ['c_a']), bindings)).toEqual({
            status: 'existing',
            compensationPersonId: 'p1',
            missingContactIds: [],
        })
    })

    it('ignores bindings outside the lineage', () => {
        const bindings: CompensationPersonBindingRecordV1[] = [
            { compensationPersonId: 'p9', contactId: 'c_unrelated' },
        ]
        expect(resolveCompensationPersonV1(evidence('c_a'), bindings)).toEqual({
            status: 'create',
            contactIds: ['c_a'],
        })
    })

    it('fails closed when equivalent lineage resolves to several people', () => {
        const bindings: CompensationPersonBindingRecordV1[] = [
            { compensationPersonId: 'p2', contactId: 'c_b' },
            { compensationPersonId: 'p1', contactId: 'c_a' },
        ]
        expect(resolveCompensationPersonV1(evidence('c_b', ['c_a']), bindings)).toEqual({
            status: 'fail_closed',
            compensationPersonIds: ['p1', 'p2'],
        })
    })

    it('keeps the same monetary identity after a merge', () => {
        // Before: contact A alone, bound to p1.
        const before = resolveCompensationPersonV1(evidence('c_a'), [])
        expect(before).toEqual({ status: 'create', contactIds: ['c_a'] })

        const bindings: CompensationPersonBindingRecordV1[] = [
            { compensationPersonId: 'p1', contactId: 'c_a' },
        ]

        // After: A merged into B. Evidence now leads with B and carries A.
        const after = resolveCompensationPersonV1(evidence('c_b', ['c_a']), bindings)
        expect(after).toMatchObject({ status: 'existing', compensationPersonId: 'p1' })

        // And again after a second merge, B into C.
        const chained = resolveCompensationPersonV1(
            evidence('c_c', ['c_a', 'c_b']),
            [...bindings, { compensationPersonId: 'p1', contactId: 'c_b' }],
        )
        expect(chained).toMatchObject({ status: 'existing', compensationPersonId: 'p1' })
    })

    it('resolves the same person from any lineage member', () => {
        const bindings: CompensationPersonBindingRecordV1[] = [
            { compensationPersonId: 'p1', contactId: 'c_a' },
            { compensationPersonId: 'p1', contactId: 'c_b' },
            { compensationPersonId: 'p1', contactId: 'c_c' },
        ]
        for (const canonical of ['c_a', 'c_b', 'c_c']) {
            const others = ['c_a', 'c_b', 'c_c'].filter((id) => id !== canonical)
            expect(resolveCompensationPersonV1(evidence(canonical, others), bindings))
                .toMatchObject({ status: 'existing', compensationPersonId: 'p1' })
        }
    })
})

describe('compensationPersonLockOrderV1', () => {
    it('deduplicates and sorts by id', () => {
        expect(compensationPersonLockOrderV1(['p2', 'p1', 'p2'])).toEqual(['p1', 'p2'])
    })
})
