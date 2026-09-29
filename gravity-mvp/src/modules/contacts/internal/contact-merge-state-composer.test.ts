import { describe, expect, test } from 'vitest'

import {
  hasPersonBlockingIdentityConflictV1,
  isProvenTransportOnlyIdentityConflictV1,
} from '../public/v1/contact-evidence-state'
import { resolveMergeIdentityRemapV1 } from '../public/v1/contact-merge-handler'
import { composeContactCustomFieldsV1 } from './contact-merge-state-composer'

function confirmation(input: {
  id: string
  status: 'confirmed' | 'needs_reconciliation'
  contactId?: string
  root: string
}) {
  return {
    id: input.id,
    profileClusterKey: 'vu:1234567890',
    status: input.status,
    reconciliationContactId: input.contactId ?? null,
    evidenceRoot: input.root,
  }
}

describe('Contact merge custom-field composition', () => {
  test('promotes an exact pending confirmation only when the counterpart is confirmed', () => {
    const composed = composeContactCustomFieldsV1({
      sourceContactId: 'source',
      targetContactId: 'target',
      sourceFields: {
        driverConfirmations: [confirmation({
          id: 'pending', status: 'needs_reconciliation', contactId: 'target', root: 'operator:source',
        })],
      },
      targetFields: {
        driverConfirmations: [confirmation({ id: 'confirmed', status: 'confirmed', root: 'operator:target' })],
      },
    })

    expect(composed.driverConfirmations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'pending', status: 'confirmed' }),
      expect.objectContaining({ id: 'confirmed', status: 'confirmed' }),
    ]))
    expect(composed.confirmedDriverClusterKeys).toEqual(['vu:1234567890'])
  })

  test.each([
    ['no confirmed counterpart', [], 'target'],
    ['pending bound to another Contact', [confirmation({ id: 'confirmed', status: 'confirmed', root: 'operator:target' })], 'third'],
  ])('keeps pending state with %s', (_label, targetConfirmations, reconciliationContactId) => {
    const composed = composeContactCustomFieldsV1({
      sourceContactId: 'source',
      targetContactId: 'target',
      sourceFields: {
        driverConfirmations: [confirmation({
          id: 'pending', status: 'needs_reconciliation', contactId: reconciliationContactId, root: 'operator:source',
        })],
      },
      targetFields: { driverConfirmations: targetConfirmations },
    })

    expect(composed.driverConfirmations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'pending', status: 'needs_reconciliation' }),
    ]))
  })

  test('preserves hard flags, conflicts, phone evidence, and automatic-block audit from both owners', () => {
    const composed = composeContactCustomFieldsV1({
      sourceContactId: 'source',
      targetContactId: 'target',
      sourceFields: {
        doNotMerge: true,
        phoneEvidenceByPhoneId: { sourcePhone: { evidenceRoot: 'phone:source' } },
        identityConflicts: [{ id: 'conflict-source' }],
        automaticMergeBlocks: [{ id: 'block-source' }],
      },
      targetFields: {
        phoneEvidenceByPhoneId: { targetPhone: { evidenceRoot: 'phone:target' } },
        identityConflicts: [{ id: 'conflict-target' }],
        automaticMergeBlocks: [{ id: 'block-target' }],
      },
    })

    expect(composed).toMatchObject({
      doNotMerge: true,
      phoneEvidenceByPhoneId: {
        sourcePhone: { evidenceRoot: 'phone:source' },
        targetPhone: { evidenceRoot: 'phone:target' },
      },
    })
    expect(composed.identityConflicts).toEqual(expect.arrayContaining([
      { id: 'conflict-source' }, { id: 'conflict-target' },
    ]))
    expect(composed.automaticMergeBlocks).toEqual(expect.arrayContaining([
      { id: 'block-source' }, { id: 'block-target' },
    ]))
  })

  test('does not materialize absent evidence arrays', () => {
    const composed = composeContactCustomFieldsV1({
      sourceContactId: 'source',
      targetContactId: 'target',
      sourceFields: { retainedSource: true },
      targetFields: { retainedTarget: true },
    })
    expect(composed).toMatchObject({ retainedSource: true, retainedTarget: true })
    expect(composed).not.toHaveProperty('driverConfirmations')
    expect(composed).not.toHaveProperty('identityConflicts')
    expect(composed).not.toHaveProperty('automaticMergeBlocks')
  })

  test('keeps the newest complete park truth and newest attempt independently', () => {
    const newerComplete = { checkStatus: 'complete', checkedAt: '2026-09-02T12:00:00.000Z', marker: 'source-complete' }
    const newerAttempt = { checkStatus: 'partial', checkedAt: '2026-09-02T13:00:00.000Z', marker: 'target-attempt' }
    const composed = composeContactCustomFieldsV1({
      sourceContactId: 'source',
      targetContactId: 'target',
      sourceFields: {
        parkCheckResult: newerComplete,
        parkCheckLastAttempt: newerComplete,
      },
      targetFields: {
        parkCheckResult: { checkStatus: 'complete', checkedAt: '2026-09-02T10:00:00.000Z', marker: 'target-old' },
        parkCheckLastAttempt: newerAttempt,
      },
    })

    expect(composed.parkCheckResult).toEqual(newerComplete)
    expect(composed.parkCheckLastAttempt).toEqual(newerAttempt)
  })

  test('never promotes a newer partial attempt into the complete park snapshot', () => {
    const lastComplete = { checkStatus: 'complete', checkedAt: '2026-09-01T10:00:00.000Z' }
    const newerPartial = { checkStatus: 'partial', checkedAt: '2026-09-02T10:00:00.000Z' }
    const composed = composeContactCustomFieldsV1({
      sourceContactId: 'source',
      targetContactId: 'target',
      sourceFields: { parkCheckResult: newerPartial },
      targetFields: { parkCheckResult: lastComplete },
    })

    expect(composed.parkCheckResult).toEqual(lastComplete)
  })
})

// M3A4 S2 — identity-conflict reference preservation across merge identity dedup.
//
// Person-blocking is an inner join between an immutable conflict journal entry
// and a mutable ContactIdentity row on identityId, and an empty join reads as
// "no conflict". Merge dedup deletes one side of that join, so without the remap
// a conflict that blocked the person silently stops blocking. These cases pin the
// substitution and, just as importantly, everything it must NOT touch.
describe('Contact merge identity-conflict reference preservation', () => {
  const remaps = [{ oldId: 'identity-source-dup', newId: 'identity-target-survivor' }]

  function ingressConflict(overrides: Record<string, unknown> = {}) {
    // The exact production shape: channel-ingress entries carry no entry `id`.
    return {
      otherContactIds: [],
      identityId: 'identity-source-dup',
      conflictType: 'channel_identity_collision',
      evidenceRoot: 'channel-collision:max:902454841098:902171753248:sender_identity_mismatch',
      source: 'channel-ingress',
      details: {
        channel: 'max',
        reason: 'sender_identity_mismatch',
        externalUserId: '902454841098',
        existingSenderId: '902264026154',
        incomingSenderId: '902454841098',
        existingChatKind: 'private',
        incomingChatKind: 'private',
        existingProviderAccountId: '902171753248',
        incomingProviderAccountId: '902171753248',
      },
      detectedAt: '2026-09-22T11:44:50.459Z',
      status: 'open',
      ...overrides,
    }
  }

  function compose(input: {
    sourceFields: Record<string, unknown>
    targetFields?: Record<string, unknown>
    identityRemaps?: ReadonlyArray<{ oldId: string; newId: string }>
  }) {
    return composeContactCustomFieldsV1({
      sourceContactId: 'source',
      targetContactId: 'target',
      sourceFields: input.sourceFields,
      targetFields: input.targetFields ?? {},
      ...(input.identityRemaps ? { identityRemaps: input.identityRemaps } : {}),
    })
  }

  test('remaps a deleted source identity to the surviving target identity', () => {
    const composed = compose({
      sourceFields: { identityConflicts: [ingressConflict()] },
      identityRemaps: remaps,
    })

    expect(composed.identityConflicts).toEqual([
      ingressConflict({ identityId: 'identity-target-survivor' }),
    ])
  })

  test('rewrites identityId and nothing else', () => {
    const before = ingressConflict()
    const [after] = compose({
      sourceFields: { identityConflicts: [before] },
      identityRemaps: remaps,
    }).identityConflicts as Array<Record<string, unknown>>

    for (const key of Object.keys(before)) {
      if (key === 'identityId') continue
      expect(after[key]).toEqual((before as Record<string, unknown>)[key])
    }
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort())
    expect(after.identityId).toBe('identity-target-survivor')
    // The stored entry itself is not mutated in place.
    expect(before.identityId).toBe('identity-source-dup')
  })

  test('keeps a surviving source identity reference unchanged', () => {
    // No dedup happened for this identity, so it is absent from the table.
    const kept = ingressConflict({ identityId: 'identity-source-kept' })
    const composed = compose({
      sourceFields: { identityConflicts: [kept] },
      identityRemaps: remaps,
    })

    expect(composed.identityConflicts).toEqual([kept])
  })

  test('leaves an entry that already references the survivor unchanged', () => {
    const already = ingressConflict({ identityId: 'identity-target-survivor' })
    const composed = compose({
      sourceFields: {},
      targetFields: { identityConflicts: [already] },
      identityRemaps: remaps,
    })

    expect(composed.identityConflicts).toEqual([already])
  })

  test('remaps every entry that referenced one deleted identity', () => {
    const composed = compose({
      sourceFields: {
        identityConflicts: [
          ingressConflict(),
          ingressConflict({ detectedAt: '2026-09-23T21:00:18.983Z' }),
          ingressConflict({ status: 'resolved', resolvedAt: '2026-09-26T06:34:01.768Z' }),
        ],
      },
      identityRemaps: remaps,
    })

    const entries = composed.identityConflicts as Array<Record<string, unknown>>
    expect(entries).toHaveLength(3)
    expect(entries.every(entry => entry.identityId === 'identity-target-survivor')).toBe(true)
  })

  test('remaps a closed entry without otherwise changing it', () => {
    // Production holds exactly this shape, written out of band: a resolved entry
    // with a resolution payload no repository writer produces.
    const resolution = {
      reason: 'false_positive_dom_fallback_before_repair',
      evidence: '/var/backups/crm-messaging-c7e29a24-window-20260922/WINDOW_REPORT.md',
      runtimeVersion: '2.0.0-19',
      releaseCandidate: 'fb9fb30d9eb221a04342fe0ef7324f78d8ff7576',
    }
    const closed = ingressConflict({
      status: 'resolved',
      resolvedAt: '2026-09-23T20:36:44.674Z',
      resolution,
    })
    const [after] = compose({
      sourceFields: { identityConflicts: [closed] },
      identityRemaps: remaps,
    }).identityConflicts as Array<Record<string, unknown>>

    expect(after.identityId).toBe('identity-target-survivor')
    expect(after.status).toBe('resolved')
    expect(after.resolvedAt).toBe('2026-09-23T20:36:44.674Z')
    expect(after.resolution).toEqual(resolution)
  })

  test('remaps a transport-only entry without reclassifying it', () => {
    const transportOnly = ingressConflict({
      evidenceRoot: 'channel-collision:whatsapp:79990001122:wa-slot-b:transport_mismatch',
      details: {
        channel: 'whatsapp',
        reason: 'transport_mismatch',
        externalUserId: '79990001122',
        incomingConnectionId: 'wa-slot-b',
        existingConnectionId: 'wa-slot-a',
      },
    })
    const [after] = compose({
      sourceFields: { identityConflicts: [transportOnly] },
      identityRemaps: remaps,
    }).identityConflicts as Array<Record<string, unknown>>

    expect(after.identityId).toBe('identity-target-survivor')
    expect(after.conflictType).toBe('channel_identity_collision')
    expect(after.source).toBe('channel-ingress')
    expect(after.details).toEqual(transportOnly.details)
  })

  test('leaves an entry with no identityId alone', () => {
    // The driver and fleet contradictions are contact-scoped and carry none.
    const driverContradiction = {
      id: 'conflict-driver',
      otherContactId: null,
      conflictType: 'confirmed_driver_cluster_contradiction',
      source: 'operator-confirmation',
      evidenceRoot: 'operator-confirmation:source:vu:1234567890',
      details: { profileClusterKey: 'vu:1234567890' },
      detectedAt: '2026-09-20T10:00:00.000Z',
      status: 'open',
    }
    const composed = compose({
      sourceFields: { identityConflicts: [driverContradiction] },
      identityRemaps: remaps,
    })

    expect(composed.identityConflicts).toEqual([driverContradiction])
  })

  test('leaves an unknown historical dangling identityId alone', () => {
    // S2 repairs merge-time references only; it does not sweep history.
    const dangling = ingressConflict({ identityId: 'identity-deleted-long-ago' })
    const composed = compose({
      sourceFields: { identityConflicts: [dangling] },
      identityRemaps: remaps,
    })

    expect(composed.identityConflicts).toEqual([dangling])
  })

  test('tolerates malformed journal members while remapping the rest', () => {
    const composed = compose({
      sourceFields: {
        identityConflicts: [null, 42, 'x', [], {}, ingressConflict(), { identityId: 7 }],
      },
      identityRemaps: remaps,
    })

    const entries = composed.identityConflicts as unknown[]
    expect(entries).toHaveLength(7)
    expect((entries[5] as Record<string, unknown>).identityId).toBe('identity-target-survivor')
    expect(entries[0]).toBeNull()
    expect(entries[6]).toEqual({ identityId: 7 })
  })

  test('remaps several dedup pairs independently', () => {
    const composed = compose({
      sourceFields: {
        identityConflicts: [
          ingressConflict({ identityId: 'identity-a-dup' }),
          ingressConflict({ identityId: 'identity-b-dup' }),
          ingressConflict({ identityId: 'identity-c-kept' }),
        ],
      },
      identityRemaps: [
        { oldId: 'identity-a-dup', newId: 'identity-a-survivor' },
        { oldId: 'identity-b-dup', newId: 'identity-b-survivor' },
      ],
    })

    expect((composed.identityConflicts as Array<Record<string, unknown>>).map(entry => entry.identityId))
      .toEqual(['identity-a-survivor', 'identity-b-survivor', 'identity-c-kept'])
  })

  test('is idempotent: composing the remapped result again changes nothing', () => {
    const once = compose({
      sourceFields: { identityConflicts: [ingressConflict()] },
      identityRemaps: remaps,
    })
    const twice = compose({
      sourceFields: { identityConflicts: once.identityConflicts as unknown[] },
      identityRemaps: remaps,
    })

    expect(twice.identityConflicts).toEqual(once.identityConflicts)
  })

  test('a merge with no identity dedup composes byte-equivalently to the unpatched path', () => {
    const journal = [ingressConflict(), ingressConflict({ identityId: 'identity-other' })]
    const withEmptyTable = compose({
      sourceFields: { identityConflicts: journal },
      targetFields: { identityConflicts: [ingressConflict({ identityId: 'identity-target' })] },
      identityRemaps: [],
    })
    const withoutTable = compose({
      sourceFields: { identityConflicts: journal },
      targetFields: { identityConflicts: [ingressConflict({ identityId: 'identity-target' })] },
    })

    expect(JSON.stringify(withEmptyTable)).toBe(JSON.stringify(withoutTable))
    expect(withEmptyTable.identityConflicts).toEqual([...journal, ingressConflict({ identityId: 'identity-target' })])
  })

  test('the journal union and its cap are unchanged by remapping', () => {
    // id-less entries are keyed by value AND index, so they never collapse —
    // before or after a remap. The remap therefore cannot alter dedup behaviour.
    const composed = compose({
      sourceFields: { identityConflicts: [ingressConflict()] },
      targetFields: { identityConflicts: [ingressConflict({ identityId: 'identity-target-survivor' })] },
      identityRemaps: remaps,
    })

    const entries = composed.identityConflicts as Array<Record<string, unknown>>
    expect(entries).toHaveLength(2)
    expect(entries.every(entry => entry.identityId === 'identity-target-survivor')).toBe(true)
  })

  test('does not materialize a conflict array that neither side had', () => {
    const composed = compose({ sourceFields: { retained: true }, identityRemaps: remaps })
    expect(composed).not.toHaveProperty('identityConflicts')
  })
})

// M3A4 S2 business invariant, stated as an executable proof.
//
// A conflict that blocked the person before identity dedup must still be visible
// to the EXISTING person-blocking predicate through the surviving identity after
// merge. The predicate is not re-implemented here: the same function the three
// runtime deny paths call is applied to the composed survivor state, so this test
// fails if the repair stops reaching the runtime for any reason.
describe('Contact merge must not weaken identity-conflict protection', () => {
  const deletedIdentity = {
    id: 'identity-source-dup',
    channel: 'max',
    providerAccountId: '902171753248',
    externalId: '902454841098',
  }
  const survivingIdentity = {
    id: 'identity-target-survivor',
    channel: 'max',
    providerAccountId: '902171753248',
    externalId: '902454841098',
  }

  /** The production shape: a MAX sender contradiction, open, with no entry id. */
  function personConflict(identityId: string) {
    return {
      otherContactIds: [],
      identityId,
      conflictType: 'channel_identity_collision',
      evidenceRoot: 'channel-collision:max:902454841098:902171753248:sender_identity_mismatch',
      source: 'channel-ingress',
      details: {
        channel: 'max',
        reason: 'sender_identity_mismatch',
        externalUserId: '902454841098',
        existingSenderId: '902264026154',
        incomingSenderId: '902454841098',
        existingChatKind: 'private',
        incomingChatKind: 'private',
        existingProviderAccountId: '902171753248',
        incomingProviderAccountId: '902171753248',
      },
      detectedAt: '2026-09-22T11:44:50.459Z',
      status: 'open',
    }
  }

  function mergeSurvivorState(identityRemaps: ReadonlyArray<{ oldId: string; newId: string }>) {
    return composeContactCustomFieldsV1({
      sourceContactId: 'source',
      targetContactId: 'target',
      sourceFields: { identityConflicts: [personConflict(deletedIdentity.id)] },
      targetFields: {},
      identityRemaps,
    })
  }

  test('the conflict blocks the source identity before the merge', () => {
    expect(hasPersonBlockingIdentityConflictV1(
      { identityConflicts: [personConflict(deletedIdentity.id)] },
      deletedIdentity,
    )).toBe(true)
  })

  test('without the remap the surviving identity would not be blocked', () => {
    // This is the defect, reproduced: an empty table leaves the deleted id in
    // place and the inner join against the surviving row finds nothing.
    const survivorState = mergeSurvivorState([])

    expect(hasPersonBlockingIdentityConflictV1(survivorState, survivingIdentity)).toBe(false)
  })

  test('with the remap the surviving identity is still blocked', () => {
    const identityRemaps = resolveMergeIdentityRemapV1([deletedIdentity], [survivingIdentity])
    expect(identityRemaps).toEqual([{ oldId: deletedIdentity.id, newId: survivingIdentity.id }])

    const survivorState = mergeSurvivorState(identityRemaps)

    expect(hasPersonBlockingIdentityConflictV1(survivorState, survivingIdentity)).toBe(true)
  })

  test('protection survives a second merge of the same survivor', () => {
    const first = mergeSurvivorState(resolveMergeIdentityRemapV1([deletedIdentity], [survivingIdentity]))
    const secondSurvivor = {
      id: 'identity-final-survivor',
      channel: 'max',
      providerAccountId: '902171753248',
      externalId: '902454841098',
    }
    const second = composeContactCustomFieldsV1({
      sourceContactId: 'target',
      targetContactId: 'final',
      sourceFields: first,
      targetFields: {},
      identityRemaps: resolveMergeIdentityRemapV1([survivingIdentity], [secondSurvivor]),
    })

    expect(hasPersonBlockingIdentityConflictV1(second, secondSurvivor)).toBe(true)
  })

  test('a transport-only conflict stays non-blocking through the remap', () => {
    // The repair preserves the reference, never the classification: a proven
    // transport-only collision must not become person-blocking by being remapped.
    const deletedWhatsapp = {
      id: 'identity-wa-dup', channel: 'whatsapp', providerAccountId: 'legacy', externalId: '79990001122',
    }
    const survivingWhatsapp = {
      id: 'identity-wa-survivor', channel: 'whatsapp', providerAccountId: 'legacy', externalId: '79990001122',
    }
    const transportOnly = {
      otherContactIds: [],
      identityId: deletedWhatsapp.id,
      conflictType: 'channel_identity_collision',
      evidenceRoot: 'channel-collision:whatsapp:79990001122:wa-slot-b:transport_mismatch',
      source: 'channel-ingress',
      details: {
        channel: 'whatsapp',
        reason: 'transport_mismatch',
        externalUserId: '79990001122',
        incomingConnectionId: 'wa-slot-b',
        existingConnectionId: 'wa-slot-a',
      },
      detectedAt: '2026-09-22T11:44:50.459Z',
      status: 'open',
    }
    expect(isProvenTransportOnlyIdentityConflictV1(transportOnly, deletedWhatsapp)).toBe(true)

    const survivorState = composeContactCustomFieldsV1({
      sourceContactId: 'source',
      targetContactId: 'target',
      sourceFields: { identityConflicts: [transportOnly] },
      targetFields: {},
      identityRemaps: resolveMergeIdentityRemapV1([deletedWhatsapp], [survivingWhatsapp]),
    })

    const [remapped] = survivorState.identityConflicts as Array<Record<string, unknown>>
    expect(remapped.identityId).toBe(survivingWhatsapp.id)
    expect(isProvenTransportOnlyIdentityConflictV1(remapped, survivingWhatsapp)).toBe(true)
    expect(hasPersonBlockingIdentityConflictV1(survivorState, survivingWhatsapp)).toBe(false)
  })

  test('a closed conflict stays non-blocking through the remap', () => {
    const survivorState = composeContactCustomFieldsV1({
      sourceContactId: 'source',
      targetContactId: 'target',
      sourceFields: {
        identityConflicts: [{ ...personConflict(deletedIdentity.id), status: 'resolved' }],
      },
      targetFields: {},
      identityRemaps: resolveMergeIdentityRemapV1([deletedIdentity], [survivingIdentity]),
    })

    expect((survivorState.identityConflicts as Array<Record<string, unknown>>)[0].identityId)
      .toBe(survivingIdentity.id)
    expect(hasPersonBlockingIdentityConflictV1(survivorState, survivingIdentity)).toBe(false)
  })

  test('an identity the merge did not deduplicate keeps its own protection', () => {
    const unrelated = {
      id: 'identity-unrelated', channel: 'telegram', providerAccountId: 'legacy', externalId: 'tg-1',
    }
    const survivorState = composeContactCustomFieldsV1({
      sourceContactId: 'source',
      targetContactId: 'target',
      sourceFields: {
        identityConflicts: [
          personConflict(deletedIdentity.id),
          { ...personConflict(unrelated.id), details: { channel: 'telegram', reason: 'peer_identity_mismatch', externalUserId: 'tg-1' } },
        ],
      },
      targetFields: {},
      identityRemaps: resolveMergeIdentityRemapV1([deletedIdentity], [survivingIdentity]),
    })

    expect(hasPersonBlockingIdentityConflictV1(survivorState, survivingIdentity)).toBe(true)
    expect(hasPersonBlockingIdentityConflictV1(survivorState, unrelated)).toBe(true)
  })
})
