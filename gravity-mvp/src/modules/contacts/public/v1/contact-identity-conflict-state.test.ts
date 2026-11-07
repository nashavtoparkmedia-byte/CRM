/**
 * The one Contacts-owned conflict semantic, proven against the runtime it must
 * agree with.
 *
 * The anchor here is the runtime-parity property: the projection's per-identity
 * blocking count must equal the exact disjunction the three deny paths evaluate
 * (`conflictState === 'conflicted'` OR `hasPersonBlockingIdentityConflictV1`). It
 * is asserted over every fixture rather than spot-checked, because a read model
 * that quietly disagrees with the deny paths is worse than no read model.
 */
import { describe, expect, it } from 'vitest'

import {
  hasPersonBlockingIdentityConflictV1,
  identityEvidenceState,
  isPersonBlockingIdentityConflictEntryV1,
  isProvenTransportOnlyIdentityConflictV1,
} from './contact-evidence-state'
import {
  resolveContactIdentityConflictStateV1,
  type ContactIdentityConflictIdentityV1,
} from './contact-identity-conflict-state'

const MAX_IDENTITY: ContactIdentityConflictIdentityV1 = {
  id: 'identity-max', channel: 'max', externalId: '900000000001', isActive: true, metadata: {},
}
const TELEGRAM_IDENTITY: ContactIdentityConflictIdentityV1 = {
  id: 'identity-tg', channel: 'telegram', externalId: 'tg-1', isActive: true, metadata: {},
}
const WHATSAPP_IDENTITY: ContactIdentityConflictIdentityV1 = {
  id: 'identity-wa', channel: 'whatsapp', externalId: '79990001122', isActive: true, metadata: {},
}

/**
 * The shape production actually holds: a MAX sender contradiction, open, with no
 * entry id. The provider values here are placeholders, not the observed ones.
 */
function maxPersonConflict(overrides: Record<string, unknown> = {}) {
  return {
    otherContactIds: [],
    identityId: MAX_IDENTITY.id,
    conflictType: 'channel_identity_collision',
    evidenceRoot: 'channel-collision:max:900000000001:900000000099:sender_identity_mismatch',
    source: 'channel-ingress',
    details: {
      channel: 'max',
      reason: 'sender_identity_mismatch',
      externalUserId: MAX_IDENTITY.externalId,
      existingSenderId: '900000000002',
      incomingSenderId: '900000000001',
      existingChatKind: 'private',
      incomingChatKind: 'private',
      existingProviderAccountId: '900000000099',
      incomingProviderAccountId: '900000000099',
    },
    detectedAt: '2026-09-22T11:44:50.459Z',
    status: 'open',
    ...overrides,
  }
}

/** A WhatsApp transport collision whose own details prove it touched no person. */
function transportOnlyConflict(overrides: Record<string, unknown> = {}) {
  return {
    otherContactIds: [],
    identityId: WHATSAPP_IDENTITY.id,
    conflictType: 'channel_identity_collision',
    evidenceRoot: 'channel-collision:whatsapp:79990001122:wa-slot-b:transport_mismatch',
    source: 'channel-ingress',
    details: {
      channel: 'whatsapp',
      reason: 'transport_mismatch',
      externalUserId: WHATSAPP_IDENTITY.externalId,
      incomingConnectionId: 'wa-slot-b',
      existingConnectionId: 'wa-slot-a',
    },
    detectedAt: '2026-09-20T10:00:00.000Z',
    status: 'open',
    ...overrides,
  }
}

function driverContradiction(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conflict-driver',
    otherContactId: null,
    conflictType: 'confirmed_driver_cluster_contradiction',
    source: 'operator-confirmation',
    evidenceRoot: 'operator-confirmation:contact-1:cluster-1',
    details: { profileClusterKey: 'cluster-1', representativeDriverId: 'driver-1' },
    detectedAt: '2026-09-21T09:00:00.000Z',
    status: 'open',
    ...overrides,
  }
}

function resolve(
  identityConflicts: unknown,
  identities: ReadonlyArray<ContactIdentityConflictIdentityV1> = [MAX_IDENTITY],
  extraFields: Record<string, unknown> = {},
) {
  return resolveContactIdentityConflictStateV1({
    customFields: { ...extraFields, ...(identityConflicts === undefined ? {} : { identityConflicts }) },
    identities,
  })
}

/** The invariant the whole slice rests on, asserted for every identity. */
function expectRuntimeParity(
  customFields: unknown,
  identities: ReadonlyArray<ContactIdentityConflictIdentityV1>,
): void {
  const state = resolveContactIdentityConflictStateV1({ customFields, identities })
  for (const identity of identities) {
    const runtimeBlocks = identityEvidenceState(identity.metadata).conflictState === 'conflicted'
      || hasPersonBlockingIdentityConflictV1(customFields, identity)
    const projected = (state.byIdentityId[identity.id]?.personBlocking ?? 0) > 0
    expect(projected, `runtime parity for ${identity.id}`).toBe(runtimeBlocks)
  }
}

describe('resolveContactIdentityConflictStateV1', () => {
  it('reports nothing for a contact with no conflicts', () => {
    const state = resolve(undefined)
    expect(state).toEqual({
      entries: [],
      hasOpenConflict: false,
      hasPersonBlockingConflict: false,
      openCount: 0,
      closedCount: 0,
      byIdentityId: {},
      byChannel: {},
    })
  })

  it('projects one open person conflict as blocking', () => {
    const state = resolve([maxPersonConflict()])
    expect(state.entries).toHaveLength(1)
    expect(state.entries[0]).toMatchObject({
      origin: 'journal',
      journalIndex: 0,
      identityId: MAX_IDENTITY.id,
      identityState: 'active',
      channel: 'max',
      conflictClass: 'channel_identity_collision',
      scope: 'person',
      status: 'open',
      personBlocking: true,
      detectedAt: '2026-09-22T11:44:50.459Z',
    })
    expect(state.hasOpenConflict).toBe(true)
    expect(state.hasPersonBlockingConflict).toBe(true)
    expect(state.byIdentityId[MAX_IDENTITY.id]).toEqual({ open: 1, personBlocking: 1 })
    expect(state.byChannel.max).toEqual({ open: 1, personBlocking: 1 })
  })

  it('projects one proven transport-only conflict as open but not blocking', () => {
    // Guard the premise: the shared classifier really does prove this one clean.
    expect(isProvenTransportOnlyIdentityConflictV1(transportOnlyConflict(), WHATSAPP_IDENTITY)).toBe(true)
    const state = resolve([transportOnlyConflict()], [WHATSAPP_IDENTITY])
    expect(state.entries[0]).toMatchObject({ scope: 'transport_only', status: 'open', personBlocking: false })
    expect(state.hasOpenConflict).toBe(true)
    expect(state.hasPersonBlockingConflict).toBe(false)
    expect(state.byChannel.whatsapp).toEqual({ open: 1, personBlocking: 0 })
  })

  it('keeps person and transport conflicts separate when both are present', () => {
    const identities = [MAX_IDENTITY, WHATSAPP_IDENTITY]
    const state = resolve([maxPersonConflict(), transportOnlyConflict()], identities)
    expect(state.hasOpenConflict).toBe(true)
    expect(state.hasPersonBlockingConflict).toBe(true)
    expect(state.byIdentityId[MAX_IDENTITY.id]).toEqual({ open: 1, personBlocking: 1 })
    expect(state.byIdentityId[WHATSAPP_IDENTITY.id]).toEqual({ open: 1, personBlocking: 0 })
    expectRuntimeParity({ identityConflicts: [maxPersonConflict(), transportOnlyConflict()] }, identities)
  })

  it('surfaces a latch-only identity as person-blocking', () => {
    const latched = { ...MAX_IDENTITY, metadata: { conflictState: 'conflicted' } }
    const state = resolve(undefined, [latched])
    expect(state.entries).toEqual([{
      origin: 'identity_latch',
      journalIndex: null,
      identityId: latched.id,
      identityState: 'active',
      channel: 'max',
      conflictClass: 'identity_conflict_flag',
      scope: 'person',
      status: 'open',
      personBlocking: true,
      detectedAt: null,
    }])
    expect(state.hasPersonBlockingConflict).toBe(true)
    expectRuntimeParity({}, [latched])
  })

  it('does not double-report a latch already explained by a blocking journal entry', () => {
    const latched = { ...MAX_IDENTITY, metadata: { conflictState: 'conflicted' } }
    const state = resolve([maxPersonConflict()], [latched])
    expect(state.entries).toHaveLength(1)
    expect(state.entries[0].origin).toBe('journal')
    expect(state.byIdentityId[latched.id]).toEqual({ open: 1, personBlocking: 1 })
    expectRuntimeParity({ identityConflicts: [maxPersonConflict()] }, [latched])
  })

  it('still reports the latch when the only open journal entry is transport-only', () => {
    // The case that forbids the simpler "suppress on any open entry" rule: the
    // transport entry explains nothing about a person-blocking latch.
    const latched = { ...WHATSAPP_IDENTITY, metadata: { conflictState: 'conflicted' } }
    const state = resolve([transportOnlyConflict()], [latched])
    expect(state.entries.map(entry => entry.origin)).toEqual(['journal', 'identity_latch'])
    expect(state.byIdentityId[latched.id]).toEqual({ open: 2, personBlocking: 1 })
    expect(state.hasPersonBlockingConflict).toBe(true)
    expectRuntimeParity({ identityConflicts: [transportOnlyConflict()] }, [latched])
  })

  it('counts a closed conflict without treating it as open', () => {
    const state = resolve([maxPersonConflict({
      status: 'resolved',
      resolvedAt: '2026-09-26T06:34:01.768Z',
      resolution: { reason: 'false_positive', evidence: '/var/backups/report.md', runtimeVersion: '0.0.0' },
    })])
    expect(state.entries[0]).toMatchObject({ status: 'closed', personBlocking: false })
    expect(state.hasOpenConflict).toBe(false)
    expect(state.openCount).toBe(0)
    expect(state.closedCount).toBe(1)
  })

  it('fails closed on an unknown conflict type', () => {
    const state = resolve([maxPersonConflict({ conflictType: 'something_new_v9' })])
    expect(state.entries[0]).toMatchObject({ conflictClass: 'unknown', scope: 'person', personBlocking: true })
  })

  it('does not promote a non-open status to open', () => {
    for (const status of ['OPEN', 'opened', '', null, undefined, 7]) {
      const state = resolve([maxPersonConflict({ status })])
      expect(state.entries[0].status, `status ${String(status)}`).toBe('closed')
      expect(state.entries[0].personBlocking).toBe(false)
    }
  })

  it('reports an entry with no identityId as contact-scoped', () => {
    const advisory = maxPersonConflict({
      identityId: null,
      conflictType: 'stable_identity_phone_contradiction',
    })
    const state = resolve([advisory])
    expect(state.entries[0]).toMatchObject({ identityId: null, identityState: 'contact', personBlocking: false })
    expect(state.byIdentityId).toEqual({})
  })

  it('blocks on a contact-scoped driver contradiction that names no identity', () => {
    const state = resolve([driverContradiction()])
    expect(state.entries[0]).toMatchObject({
      identityId: null,
      identityState: 'contact',
      conflictClass: 'confirmed_driver_cluster_contradiction',
      personBlocking: true,
    })
    expect(state.hasPersonBlockingConflict).toBe(true)
  })

  it('reports a conflict naming an identity this contact no longer has as missing and non-blocking', () => {
    // Faithful to the runtime: the deny paths join on identityId and an empty
    // join reads as no conflict. S1 surfaces the weakness; S4 would repair it.
    const state = resolve([maxPersonConflict({ identityId: 'identity-deleted-long-ago' })])
    expect(state.entries[0]).toMatchObject({
      identityId: 'identity-deleted-long-ago',
      identityState: 'missing',
      channel: 'max',
      scope: 'person',
      personBlocking: false,
    })
    expect(state.hasOpenConflict).toBe(true)
    expect(state.byIdentityId).toEqual({})
    expectRuntimeParity({ identityConflicts: [maxPersonConflict({ identityId: 'identity-deleted-long-ago' })] }, [MAX_IDENTITY])
  })

  it('reports an inactive identity as inactive and still blocking', () => {
    // isActive is deliberately not a blocking input: reachability rejects an
    // inactive identity earlier, and the conflict predicate never checks it.
    const inactive = { ...MAX_IDENTITY, isActive: false }
    const state = resolve([maxPersonConflict()], [inactive])
    expect(state.entries[0]).toMatchObject({ identityState: 'inactive', personBlocking: true })
    expectRuntimeParity({ identityConflicts: [maxPersonConflict()] }, [inactive])
  })

  it('keeps several identities on one channel distinct', () => {
    const second = { ...MAX_IDENTITY, id: 'identity-max-2', externalId: '900000000002' }
    const third = { ...MAX_IDENTITY, id: 'identity-max-3', externalId: '900000000003' }
    const identities = [MAX_IDENTITY, second, third]
    const state = resolve([maxPersonConflict(), maxPersonConflict({ identityId: second.id })], identities)
    expect(state.byIdentityId[MAX_IDENTITY.id]).toEqual({ open: 1, personBlocking: 1 })
    expect(state.byIdentityId[second.id]).toEqual({ open: 1, personBlocking: 1 })
    expect(state.byIdentityId[third.id]).toBeUndefined()
    expect(state.byChannel.max).toEqual({ open: 2, personBlocking: 2 })
    expectRuntimeParity({ identityConflicts: [maxPersonConflict(), maxPersonConflict({ identityId: second.id })] }, identities)
  })

  it('aggregates across channels', () => {
    const identities = [MAX_IDENTITY, TELEGRAM_IDENTITY, WHATSAPP_IDENTITY]
    const telegramConflict = maxPersonConflict({
      identityId: TELEGRAM_IDENTITY.id,
      details: { channel: 'telegram', reason: 'peer_identity_mismatch', externalUserId: TELEGRAM_IDENTITY.externalId },
    })
    const state = resolve([maxPersonConflict(), telegramConflict, transportOnlyConflict()], identities)
    expect(Object.keys(state.byChannel).sort()).toEqual(['max', 'telegram', 'whatsapp'])
    expect(state.byChannel.telegram).toEqual({ open: 1, personBlocking: 1 })
    expectRuntimeParity({ identityConflicts: [maxPersonConflict(), telegramConflict, transportOnlyConflict()] }, identities)
  })

  it('treats an S2-remapped identityId as an ordinary live reference', () => {
    // After the merge remap the entry names the surviving row; nothing about it
    // is special here, which is the point.
    const survivor = { ...MAX_IDENTITY, id: 'identity-max-survivor' }
    const remapped = maxPersonConflict({ identityId: survivor.id })
    const state = resolve([remapped], [survivor])
    expect(state.entries[0]).toMatchObject({ identityState: 'active', personBlocking: true })
    expectRuntimeParity({ identityConflicts: [remapped] }, [survivor])
  })

  it('tolerates malformed members and a non-array journal without throwing', () => {
    expect(resolve('not-an-array').entries).toEqual([])
    expect(resolve({ nested: true } as unknown).entries).toEqual([])
    const state = resolve([null, 42, 'x', [], {}, maxPersonConflict(), { identityId: 7 }])
    // The two object members are projected; the five non-objects are skipped.
    expect(state.entries).toHaveLength(3)
    expect(state.entries.map(entry => entry.journalIndex)).toEqual([4, 5, 6])
    expect(state.entries[0]).toMatchObject({ conflictClass: 'unknown', status: 'closed', identityState: 'contact' })
    expect(state.entries[2]).toMatchObject({ identityId: null, identityState: 'contact' })
  })

  it('never throws on structurally random input', () => {
    const shapes: unknown[] = [
      undefined, null, 0, '', [], {}, { identityConflicts: null }, { identityConflicts: {} },
      { identityConflicts: [undefined] }, { identityConflicts: [{ details: 'x' }] },
      { identityConflicts: [{ identityId: {}, status: {}, conflictType: [] }] },
      { identityConflicts: [{ detectedAt: 'not-a-date' }] },
      { identityConflicts: [{ detectedAt: 12345 }] },
    ]
    for (const customFields of shapes) {
      for (const identities of [[], [MAX_IDENTITY], undefined as unknown as never]) {
        expect(() => resolveContactIdentityConflictStateV1({ customFields, identities })).not.toThrow()
      }
    }
  })

  it('does not echo an unparseable detectedAt', () => {
    expect(resolve([maxPersonConflict({ detectedAt: 'yesterday' })]).entries[0].detectedAt).toBeNull()
    expect(resolve([maxPersonConflict({ detectedAt: undefined })]).entries[0].detectedAt).toBeNull()
  })

  it('does not trust a recorded channel that this domain does not project', () => {
    const state = resolve([maxPersonConflict({
      identityId: 'identity-gone',
      details: { channel: 'carrier-pigeon', reason: 'x' },
    })])
    expect(state.entries[0].channel).toBeNull()
    expect(state.byChannel).toEqual({})
  })

  it('agrees with the entry-level primitive for every journal entry', () => {
    const identities = [MAX_IDENTITY, WHATSAPP_IDENTITY]
    const journal = [maxPersonConflict(), transportOnlyConflict(), maxPersonConflict({ status: 'resolved' })]
    const state = resolveContactIdentityConflictStateV1({ customFields: { identityConflicts: journal }, identities })
    for (const entry of state.entries) {
      if (entry.origin !== 'journal' || entry.journalIndex === null) continue
      const identity = identities.find(candidate => candidate.id === entry.identityId)
      if (identity === undefined) continue
      expect(entry.personBlocking).toBe(
        isPersonBlockingIdentityConflictEntryV1(journal[entry.journalIndex], identity),
      )
    }
  })
})
