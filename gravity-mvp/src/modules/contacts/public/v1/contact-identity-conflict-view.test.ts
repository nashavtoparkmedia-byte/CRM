/**
 * ContactIdentityConflictView.v1 proven as a provider-neutral public read.
 *
 * Two things matter beyond the field mapping. The view must return only OPEN
 * conflicts while still telling the card how many were closed, and no provider,
 * runtime or infrastructure value present on the source may reach the response —
 * proven by walking every value of the serialized result, not by checking the
 * top-level keys.
 */
import { describe, expect, it } from 'vitest'

import { buildContactCardSummaryV1 } from './contact-card-summary'
import {
  buildContactIdentityConflictViewV1,
  createContactIdentityConflictViewHandlerV1,
  type ContactIdentityConflictViewSourceV1,
  type ContactIdentityConflictViewV1,
} from './contact-identity-conflict-view'
import { resolveContactIdentityConflictStateV1 } from './contact-identity-conflict-state'

const VIEW_FIELDS = [
  'contactId', 'hasOpenConflict', 'hasPersonBlockingConflict',
  'closedConflictCount', 'channels', 'conflicts',
]
const ENTRY_FIELDS = [
  'identityId', 'channel', 'conflictClass', 'scope',
  'blocksPersonOperations', 'identityState', 'detectedAt',
]
const CHANNEL_FIELDS = ['channel', 'openConflictCount', 'personBlockingCount']

/**
 * Values that exist on the source and must never appear in the response. They
 * stand in for the real production ones, which are not reproduced here.
 */
const FORBIDDEN_VALUES = [
  '900000000001', '900000000002', '900000000099', 'wa-slot-a', 'wa-slot-b',
  'sender_identity_mismatch', 'transport_mismatch', 'private',
  'channel-collision:max:900000000001:900000000099:sender_identity_mismatch',
  'channel-ingress', 'cluster-1', 'driver-1',
  '/var/backups/crm-placeholder/REPORT.md', '0.0.0-placeholder', 'deadbeefcafe',
  'tg-bot-7712345678', 'max-personal-0123456789abcdef01234567',
]
const FORBIDDEN_KEYS = [
  'externalId', 'externalUserId', 'providerAccountId', 'transportConnectionId',
  'transportRef', 'connectionId', 'evidenceRoot', 'details', 'reason', 'resolution',
  'resolvedAt', 'senderId', 'peerId', 'chatId', 'conversationId', 'deliveryStatus',
  'profileClusterKey', 'driverId', 'driverIds', 'otherContactIds', 'status',
  'origin', 'journalIndex', 'personBlocking', 'runtimeVersion', 'releaseCandidate',
]

function walk(value: unknown, visit: (key: string | null, node: unknown) => void, key: string | null = null): void {
  visit(key, value)
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit)
    return
  }
  if (value && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) walk(child, visit, childKey)
  }
}

function expectNoLeak(view: ContactIdentityConflictViewV1): void {
  walk(view, (key, node) => {
    if (key !== null) expect(FORBIDDEN_KEYS, `key ${key}`).not.toContain(key)
    if (typeof node === 'string') expect(FORBIDDEN_VALUES, `value ${node}`).not.toContain(node)
  })
}

const MAX_IDENTITY = {
  id: 'identity-max', channel: 'max', externalId: '900000000001', isActive: true, metadata: {},
}
const WHATSAPP_IDENTITY = {
  id: 'identity-wa', channel: 'whatsapp', externalId: '79990001122', isActive: true, metadata: {},
}

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
      externalUserId: '900000000001',
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

function transportOnlyConflict() {
  return {
    otherContactIds: [],
    identityId: WHATSAPP_IDENTITY.id,
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
    detectedAt: '2026-09-20T10:00:00.000Z',
    status: 'open',
  }
}

/**
 * The production shape of a closed record: an out-of-band resolution payload that
 * carries a host path, a runtime version and a release sha. The values below are
 * placeholders; the structure is the observed one.
 */
function closedConflictWithResolution() {
  return maxPersonConflict({
    status: 'resolved',
    resolvedAt: '2026-09-23T20:36:44.674Z',
    resolution: {
      reason: 'false_positive_dom_fallback_before_repair',
      evidence: '/var/backups/crm-placeholder/REPORT.md',
      runtimeVersion: '0.0.0-placeholder',
      releaseCandidate: 'deadbeefcafe',
    },
  })
}

function source(overrides: Partial<ContactIdentityConflictViewSourceV1> = {}): ContactIdentityConflictViewSourceV1 {
  return {
    id: 'contact-1',
    customFields: {},
    identities: [MAX_IDENTITY],
    ...overrides,
  }
}

describe('buildContactIdentityConflictViewV1', () => {
  it('returns the exact declared field set and nothing else', () => {
    const view = buildContactIdentityConflictViewV1(source({
      customFields: { identityConflicts: [maxPersonConflict()] },
    }))
    expect(Object.keys(view).sort()).toEqual([...VIEW_FIELDS].sort())
    expect(Object.keys(view.conflicts[0]).sort()).toEqual([...ENTRY_FIELDS].sort())
    expect(Object.keys(view.channels[0]).sort()).toEqual([...CHANNEL_FIELDS].sort())
  })

  it('reports a clean contact', () => {
    expect(buildContactIdentityConflictViewV1(source())).toEqual({
      contactId: 'contact-1',
      hasOpenConflict: false,
      hasPersonBlockingConflict: false,
      closedConflictCount: 0,
      channels: [],
      conflicts: [],
    })
  })

  it('projects an open person conflict with its channel rollup', () => {
    const view = buildContactIdentityConflictViewV1(source({
      customFields: { identityConflicts: [maxPersonConflict()] },
    }))
    expect(view).toEqual({
      contactId: 'contact-1',
      hasOpenConflict: true,
      hasPersonBlockingConflict: true,
      closedConflictCount: 0,
      channels: [{ channel: 'max', openConflictCount: 1, personBlockingCount: 1 }],
      conflicts: [{
        identityId: 'identity-max',
        channel: 'max',
        conflictClass: 'channel_identity_collision',
        scope: 'person',
        blocksPersonOperations: true,
        identityState: 'active',
        detectedAt: '2026-09-22T11:44:50.459Z',
      }],
    })
    expectNoLeak(view)
  })

  it('marks a transport-only conflict open but not blocking', () => {
    const view = buildContactIdentityConflictViewV1(source({
      identities: [WHATSAPP_IDENTITY],
      customFields: { identityConflicts: [transportOnlyConflict()] },
    }))
    expect(view.hasOpenConflict).toBe(true)
    expect(view.hasPersonBlockingConflict).toBe(false)
    expect(view.conflicts[0]).toMatchObject({ scope: 'transport_only', blocksPersonOperations: false })
    expect(view.channels).toEqual([{ channel: 'whatsapp', openConflictCount: 1, personBlockingCount: 0 }])
    expectNoLeak(view)
  })

  it('counts a closed conflict but returns neither it nor its resolution payload', () => {
    const view = buildContactIdentityConflictViewV1(source({
      customFields: { identityConflicts: [closedConflictWithResolution(), maxPersonConflict()] },
    }))
    expect(view.conflicts).toHaveLength(1)
    expect(view.closedConflictCount).toBe(1)
    const serialized = JSON.stringify(view)
    for (const secret of ['/var/backups', 'runtimeVersion', 'releaseCandidate', 'resolution', 'resolvedAt', 'false_positive']) {
      expect(serialized, `leaked ${secret}`).not.toContain(secret)
    }
    expectNoLeak(view)
  })

  it('returns closed-only conflicts as a count with an empty list', () => {
    const view = buildContactIdentityConflictViewV1(source({
      customFields: { identityConflicts: [closedConflictWithResolution()] },
    }))
    expect(view).toMatchObject({
      hasOpenConflict: false, hasPersonBlockingConflict: false, closedConflictCount: 1, channels: [], conflicts: [],
    })
    expectNoLeak(view)
  })

  it('sorts channels and exposes several of them', () => {
    const telegram = { id: 'identity-tg', channel: 'telegram', externalId: 'tg-1', isActive: true, metadata: {} }
    const view = buildContactIdentityConflictViewV1(source({
      identities: [MAX_IDENTITY, WHATSAPP_IDENTITY, telegram],
      customFields: {
        identityConflicts: [
          transportOnlyConflict(),
          maxPersonConflict(),
          maxPersonConflict({ identityId: telegram.id, details: { channel: 'telegram', reason: 'peer_identity_mismatch' } }),
        ],
      },
    }))
    expect(view.channels.map(channel => channel.channel)).toEqual(['max', 'telegram', 'whatsapp'])
    expectNoLeak(view)
  })

  it('surfaces a latch-only identity', () => {
    const view = buildContactIdentityConflictViewV1(source({
      identities: [{ ...MAX_IDENTITY, metadata: { conflictState: 'conflicted' } }],
    }))
    expect(view.conflicts).toEqual([{
      identityId: 'identity-max',
      channel: 'max',
      conflictClass: 'identity_conflict_flag',
      scope: 'person',
      blocksPersonOperations: true,
      identityState: 'active',
      detectedAt: null,
    }])
    expectNoLeak(view)
  })

  it('reports a conflict on an identity the contact no longer has as missing', () => {
    const view = buildContactIdentityConflictViewV1(source({
      customFields: { identityConflicts: [maxPersonConflict({ identityId: 'identity-gone' })] },
    }))
    expect(view.conflicts[0]).toMatchObject({
      identityId: 'identity-gone', identityState: 'missing', blocksPersonOperations: false,
    })
    expectNoLeak(view)
  })

  it('never leaks a provider value even when every stored field is populated', () => {
    const view = buildContactIdentityConflictViewV1(source({
      identities: [
        { ...MAX_IDENTITY, metadata: { providerAccountId: 'tg-bot-7712345678', transportRef: 'max-personal-0123456789abcdef01234567' } },
        WHATSAPP_IDENTITY,
      ],
      customFields: {
        identityConflicts: [maxPersonConflict(), transportOnlyConflict(), closedConflictWithResolution()],
      },
    }))
    expectNoLeak(view)
  })

  it('is total for malformed stored state', () => {
    for (const customFields of [undefined, null, 'x', 7, [], { identityConflicts: 'x' }, { identityConflicts: [null, {}] }]) {
      expect(() => buildContactIdentityConflictViewV1(source({ customFields }))).not.toThrow()
    }
  })
})

describe('createContactIdentityConflictViewHandlerV1', () => {
  it('trims the id, rejects an empty one and never calls the port for it', async () => {
    let calls = 0
    const handler = createContactIdentityConflictViewHandlerV1({
      async findContactIdentityConflictSource(contactId) {
        calls += 1
        expect(contactId).toBe('contact-1')
        return source()
      },
    })
    expect(await handler('   ')).toBeNull()
    expect(await handler(undefined as unknown as string)).toBeNull()
    expect(calls).toBe(0)
    expect(await handler('  contact-1 ')).toMatchObject({ contactId: 'contact-1' })
    expect(calls).toBe(1)
  })

  it('returns null for an unknown contact', async () => {
    const handler = createContactIdentityConflictViewHandlerV1({
      findContactIdentityConflictSource: async () => null,
    })
    expect(await handler('missing')).toBeNull()
  })
})

describe('summary and detailed view cannot disagree', () => {
  function summarySource(customFields: unknown, identities: typeof MAX_IDENTITY[]) {
    return {
      id: 'contact-1',
      displayName: 'Иван Петров',
      displayNameSource: 'manual',
      masterSource: 'chat',
      primaryPhoneId: 'phone-1',
      customFields,
      phones: [{ id: 'phone-1', phone: '79001234567', isPrimary: true, isActive: true, lifecycle: 'current' }],
      identities,
      mergedFromCount: 0,
    }
  }

  const cases: Array<{ name: string; customFields: unknown; identities: typeof MAX_IDENTITY[] }> = [
    { name: 'clean', customFields: {}, identities: [MAX_IDENTITY] },
    { name: 'open person', customFields: { identityConflicts: [maxPersonConflict()] }, identities: [MAX_IDENTITY] },
    { name: 'transport only', customFields: { identityConflicts: [transportOnlyConflict()] }, identities: [WHATSAPP_IDENTITY] },
    { name: 'closed only', customFields: { identityConflicts: [closedConflictWithResolution()] }, identities: [MAX_IDENTITY] },
    { name: 'latch only', customFields: {}, identities: [{ ...MAX_IDENTITY, metadata: { conflictState: 'conflicted' } }] },
    { name: 'missing identity', customFields: { identityConflicts: [maxPersonConflict({ identityId: 'gone' })] }, identities: [MAX_IDENTITY] },
    { name: 'unknown type', customFields: { identityConflicts: [maxPersonConflict({ conflictType: 'new_v9' })] }, identities: [MAX_IDENTITY] },
    { name: 'malformed', customFields: { identityConflicts: [null, 'x', {}] }, identities: [MAX_IDENTITY] },
  ]

  for (const scenario of cases) {
    it(`agrees on hasIdentityConflict and per-channel state: ${scenario.name}`, () => {
      const summary = buildContactCardSummaryV1(summarySource(scenario.customFields, scenario.identities))
      const view = buildContactIdentityConflictViewV1({
        id: 'contact-1', customFields: scenario.customFields, identities: scenario.identities,
      })
      const state = resolveContactIdentityConflictStateV1({
        customFields: scenario.customFields, identities: scenario.identities,
      })

      expect(summary.hasIdentityConflict).toBe(view.hasOpenConflict)
      expect(summary.hasIdentityConflict).toBe(state.hasOpenConflict)
      for (const channel of summary.channels) {
        const open = view.channels.find(candidate => candidate.channel === channel.channel)?.openConflictCount ?? 0
        expect(channel.conflictState === 'conflicted', `channel ${channel.channel}`).toBe(open > 0)
      }
    })
  }

  it('keeps the summary field set unchanged', () => {
    const summary = buildContactCardSummaryV1(summarySource({ identityConflicts: [maxPersonConflict()] }, [MAX_IDENTITY]))
    expect(Object.keys(summary).sort()).toEqual([
      'channels', 'contactId', 'displayName', 'displayTitle', 'hasIdentityConflict',
      'lineage', 'phoneCount', 'primaryPhone', 'source',
    ])
    expect(Object.keys(summary.channels[0]).sort()).toEqual([
      'channel', 'conflictState', 'hasActiveIdentity', 'identityCount',
    ])
    // The two fields the source gained for the projection must not reach the card.
    expect(JSON.stringify(summary)).not.toContain('identity-max')
    expect(JSON.stringify(summary)).not.toContain('900000000001')
  })
})
