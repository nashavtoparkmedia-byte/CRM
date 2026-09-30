/**
 * ContactReachabilityEvidenceView.v1 proven as a provider-neutral evidence read.
 *
 * Three things matter beyond the field mapping. The public vocabulary must never
 * read as current availability. Every ContactIdentity row must survive — the
 * channel row counts, it does not conclude. And no provider or runtime value
 * present on the source may reach the response, proven by walking every value of
 * the serialized result rather than checking top-level keys.
 */
import { describe, expect, it } from 'vitest'

import {
  buildContactReachabilityEvidenceViewV1,
  createContactReachabilityEvidenceViewHandlerV1,
  type ContactReachabilityEvidenceSourceV1,
  type ContactReachabilityEvidenceViewV1,
} from './contact-reachability-evidence-view'

const VIEW_FIELDS = ['contactId', 'identities', 'channels']
const IDENTITY_FIELDS = ['identityId', 'channel', 'identityState', 'evidenceStatus', 'evidenceAt']
const CHANNEL_FIELDS = [
  'channel', 'identityCount', 'activeIdentityCount',
  'recordedConfirmedCount', 'recordedUnreachableCount', 'noEvidenceCount', 'latestEvidenceAt',
]

/** Vocabulary that would assert present availability. None may appear anywhere. */
const AVAILABILITY_WORDS = [
  'available', 'reachable', 'ready', 'deliverable', 'online',
  'sendable', 'usable', 'canWrite', 'isReachable', 'blocked', 'permitted',
]

/**
 * The mandated public vocabulary literally contains the substring "unreachable",
 * which in turn contains "reachable". That is the persisted fact's own word, not an
 * availability claim, so it is removed before the availability scan — otherwise the
 * scan would forbid the very naming the contract requires.
 */
const SANCTIONED_VOCABULARY = /recorded_unreachable|recordedUnreachableCount/giu

function withoutSanctionedVocabulary(text: string): string {
  return text.replace(SANCTIONED_VOCABULARY, '')
}

/** Source-side values that must never reach the response. */
const FORBIDDEN_VALUES = [
  '900000000001', 'tg-user-77012345678', 'tg-bot-7712345678',
  'wa-slot-a', 'max-personal-0123456789abcdef01234567',
  'chat-1', 'message-1', 'route-1', 'session-1', 'driver-1',
]
const FORBIDDEN_KEYS = [
  'externalId', 'externalUserId', 'providerTargetId', 'providerAccountId',
  'transportConnectionId', 'transportRef', 'connectionId', 'metadata',
  'chatId', 'messageId', 'conversationId', 'conversationRoute', 'sessionId',
  'driverId', 'reachabilityStatus', 'reachabilityCheckedAt', 'isActive',
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

function expectNoLeak(view: ContactReachabilityEvidenceViewV1): void {
  walk(view, (key, node) => {
    if (key !== null) {
      expect(FORBIDDEN_KEYS, `key ${key}`).not.toContain(key)
      const scannableKey = withoutSanctionedVocabulary(key).toLowerCase()
      for (const word of AVAILABILITY_WORDS) {
        expect(scannableKey, `key ${key} asserts availability`).not.toContain(word.toLowerCase())
      }
    }
    if (typeof node === 'string') expect(FORBIDDEN_VALUES, `value ${node}`).not.toContain(node)
  })
}

/** A source row carrying every provider value the real table holds beside the evidence. */
function identityRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'identity-tg',
    channel: 'telegram',
    isActive: true,
    reachabilityStatus: 'confirmed',
    reachabilityCheckedAt: new Date('2026-09-20T10:00:00.000Z'),
    ...overrides,
  }
}

function source(identities: ReadonlyArray<Record<string, unknown>>): ContactReachabilityEvidenceSourceV1 {
  return { id: 'contact-1', identities: identities as ContactReachabilityEvidenceSourceV1['identities'] }
}

describe('buildContactReachabilityEvidenceViewV1', () => {
  it('returns the exact declared field sets and nothing else', () => {
    const view = buildContactReachabilityEvidenceViewV1(source([identityRow()]))
    expect(Object.keys(view).sort()).toEqual([...VIEW_FIELDS].sort())
    expect(Object.keys(view.identities[0]).sort()).toEqual([...IDENTITY_FIELDS].sort())
    expect(Object.keys(view.channels[0]).sort()).toEqual([...CHANNEL_FIELDS].sort())
  })

  it('reports one recorded_confirmed identity', () => {
    const view = buildContactReachabilityEvidenceViewV1(source([identityRow()]))
    expect(view).toEqual({
      contactId: 'contact-1',
      identities: [{
        identityId: 'identity-tg',
        channel: 'telegram',
        identityState: 'active',
        evidenceStatus: 'recorded_confirmed',
        evidenceAt: '2026-09-20T10:00:00.000Z',
      }],
      channels: [{
        channel: 'telegram',
        identityCount: 1,
        activeIdentityCount: 1,
        recordedConfirmedCount: 1,
        recordedUnreachableCount: 0,
        noEvidenceCount: 0,
        latestEvidenceAt: '2026-09-20T10:00:00.000Z',
      }],
    })
    expectNoLeak(view)
  })

  it('reports one recorded_unreachable identity', () => {
    const view = buildContactReachabilityEvidenceViewV1(source([
      identityRow({ reachabilityStatus: 'unreachable' }),
    ]))
    expect(view.identities[0].evidenceStatus).toBe('recorded_unreachable')
    expect(view.channels[0]).toMatchObject({ recordedUnreachableCount: 1, recordedConfirmedCount: 0, noEvidenceCount: 0 })
  })

  it('maps the stored unknown default to no_evidence with a null timestamp', () => {
    const view = buildContactReachabilityEvidenceViewV1(source([
      identityRow({ reachabilityStatus: 'unknown', reachabilityCheckedAt: null }),
    ]))
    expect(view.identities[0]).toMatchObject({ evidenceStatus: 'no_evidence', evidenceAt: null })
    expect(view.channels[0]).toMatchObject({ noEvidenceCount: 1, latestEvidenceAt: null })
  })

  it('retains recorded_confirmed when the stored timestamp is null', () => {
    // The phone-attachment and maintenance writers make this representable.
    const view = buildContactReachabilityEvidenceViewV1(source([
      identityRow({ reachabilityCheckedAt: null }),
    ]))
    expect(view.identities[0]).toMatchObject({ evidenceStatus: 'recorded_confirmed', evidenceAt: null })
    expect(view.channels[0]).toMatchObject({ recordedConfirmedCount: 1, latestEvidenceAt: null })
  })

  it('keeps every identity on one channel and counts them', () => {
    const view = buildContactReachabilityEvidenceViewV1(source([
      identityRow({ id: 'identity-a', channel: 'max' }),
      identityRow({ id: 'identity-b', channel: 'max', reachabilityStatus: 'unknown', reachabilityCheckedAt: null }),
    ]))
    expect(view.identities).toHaveLength(2)
    expect(view.channels).toHaveLength(1)
    expect(view.channels[0]).toMatchObject({
      channel: 'max', identityCount: 2, activeIdentityCount: 2,
      recordedConfirmedCount: 1, recordedUnreachableCount: 0, noEvidenceCount: 1,
    })
  })

  it('keeps mixed recorded_confirmed and recorded_unreachable on one channel distinct', () => {
    const view = buildContactReachabilityEvidenceViewV1(source([
      identityRow({ id: 'identity-a', channel: 'max' }),
      identityRow({ id: 'identity-b', channel: 'max', reachabilityStatus: 'unreachable' }),
    ]))
    expect(view.identities.map(i => i.evidenceStatus)).toEqual(['recorded_confirmed', 'recorded_unreachable'])
    expect(view.channels[0]).toMatchObject({ recordedConfirmedCount: 1, recordedUnreachableCount: 1 })
    // No verdict field exists to collapse them into.
    expect(Object.keys(view.channels[0])).toEqual(expect.not.arrayContaining(['evidenceSummary', 'available', 'reachable']))
  })

  it('reports two recorded_unreachable identities without concluding the channel is unavailable', () => {
    const view = buildContactReachabilityEvidenceViewV1(source([
      identityRow({ id: 'identity-a', channel: 'max', reachabilityStatus: 'unreachable' }),
      identityRow({ id: 'identity-b', channel: 'max', reachabilityStatus: 'unreachable' }),
    ]))
    expect(view.channels[0]).toMatchObject({ identityCount: 2, recordedUnreachableCount: 2, recordedConfirmedCount: 0 })
    expectNoLeak(view)
  })

  it('reports an inactive identity that carries recorded evidence', () => {
    // Measured in production: one inactive MAX identity holds confirmed evidence.
    const view = buildContactReachabilityEvidenceViewV1(source([
      identityRow({ id: 'identity-old', channel: 'max', isActive: false }),
    ]))
    expect(view.identities[0]).toMatchObject({ identityState: 'inactive', evidenceStatus: 'recorded_confirmed' })
    expect(view.channels[0]).toMatchObject({ identityCount: 1, activeIdentityCount: 0, recordedConfirmedCount: 1 })
  })

  it('separates an inactive recorded_confirmed from an active no_evidence on one channel', () => {
    const view = buildContactReachabilityEvidenceViewV1(source([
      identityRow({ id: 'identity-old', channel: 'max', isActive: false }),
      identityRow({ id: 'identity-new', channel: 'max', reachabilityStatus: 'unknown', reachabilityCheckedAt: null }),
    ]))
    expect(view.channels[0]).toMatchObject({
      identityCount: 2, activeIdentityCount: 1, recordedConfirmedCount: 1, noEvidenceCount: 1,
    })
    expect(view.identities.find(i => i.identityId === 'identity-old')?.identityState).toBe('inactive')
    expect(view.identities.find(i => i.identityId === 'identity-new')?.identityState).toBe('active')
  })

  it('reports the production three-identity MAX shape without losing a row', () => {
    const view = buildContactReachabilityEvidenceViewV1(source([
      identityRow({ id: 'identity-a', channel: 'max' }),
      identityRow({ id: 'identity-b', channel: 'max', reachabilityStatus: 'unreachable' }),
      identityRow({ id: 'identity-c', channel: 'max', reachabilityStatus: 'unknown', reachabilityCheckedAt: null }),
    ]))
    expect(view.identities).toHaveLength(3)
    expect(view.channels[0]).toMatchObject({
      identityCount: 3, recordedConfirmedCount: 1, recordedUnreachableCount: 1, noEvidenceCount: 1,
    })
  })

  it('aggregates several channels and sorts them', () => {
    const view = buildContactReachabilityEvidenceViewV1(source([
      identityRow({ id: 'identity-wa', channel: 'whatsapp' }),
      identityRow({ id: 'identity-tg', channel: 'telegram', reachabilityStatus: 'unreachable' }),
      identityRow({ id: 'identity-max', channel: 'max', reachabilityStatus: 'unknown', reachabilityCheckedAt: null }),
    ]))
    expect(view.channels.map(c => c.channel)).toEqual(['max', 'telegram', 'whatsapp'])
  })

  it('takes latestEvidenceAt as the newest, ignoring nulls', () => {
    const view = buildContactReachabilityEvidenceViewV1(source([
      identityRow({ id: 'identity-a', channel: 'max', reachabilityCheckedAt: new Date('2026-09-01T00:00:00.000Z') }),
      identityRow({ id: 'identity-b', channel: 'max', reachabilityCheckedAt: new Date('2026-09-25T12:00:00.000Z') }),
      identityRow({ id: 'identity-c', channel: 'max', reachabilityStatus: 'unknown', reachabilityCheckedAt: null }),
    ]))
    expect(view.channels[0].latestEvidenceAt).toBe('2026-09-25T12:00:00.000Z')
  })

  it('leaves latestEvidenceAt null when no identity on the channel has one', () => {
    const view = buildContactReachabilityEvidenceViewV1(source([
      identityRow({ id: 'identity-a', channel: 'max', reachabilityStatus: 'unknown', reachabilityCheckedAt: null }),
      identityRow({ id: 'identity-b', channel: 'max', reachabilityStatus: 'unknown', reachabilityCheckedAt: null }),
    ]))
    expect(view.channels[0].latestEvidenceAt).toBeNull()
  })

  it('reports an empty Contact as empty', () => {
    expect(buildContactReachabilityEvidenceViewV1(source([]))).toEqual({
      contactId: 'contact-1', identities: [], channels: [],
    })
  })

  it('is deterministic regardless of the order identities arrive in', () => {
    const rows = [
      identityRow({ id: 'identity-c', channel: 'whatsapp' }),
      identityRow({ id: 'identity-a', channel: 'max', reachabilityStatus: 'unreachable' }),
      identityRow({ id: 'identity-b', channel: 'max', reachabilityStatus: 'unknown', reachabilityCheckedAt: null }),
      identityRow({ id: 'identity-d', channel: 'telegram' }),
    ]
    const forward = JSON.stringify(buildContactReachabilityEvidenceViewV1(source(rows)))
    const reversed = JSON.stringify(buildContactReachabilityEvidenceViewV1(source([...rows].reverse())))
    const rotated = JSON.stringify(buildContactReachabilityEvidenceViewV1(source([rows[2], rows[0], rows[3], rows[1]])))
    expect(reversed).toBe(forward)
    expect(rotated).toBe(forward)
  })

  it('fails soft on an unexpected persisted status rather than throwing', () => {
    for (const stored of ['CONFIRMED', 'pending', '', null, undefined, 7, {}, []]) {
      const view = buildContactReachabilityEvidenceViewV1(source([identityRow({ reachabilityStatus: stored })]))
      expect(view.identities[0].evidenceStatus, `stored ${String(stored)}`).toBe('no_evidence')
    }
  })

  it('drops an unusable timestamp instead of echoing it', () => {
    for (const stored of ['yesterday', '', 12345, {}, new Date('invalid')]) {
      const view = buildContactReachabilityEvidenceViewV1(source([identityRow({ reachabilityCheckedAt: stored })]))
      expect(view.identities[0].evidenceAt, `stored ${String(stored)}`).toBeNull()
    }
  })

  it('accepts an already-serialized timestamp string', () => {
    const view = buildContactReachabilityEvidenceViewV1(source([
      identityRow({ reachabilityCheckedAt: '2026-09-20T10:00:00.000Z' }),
    ]))
    expect(view.identities[0].evidenceAt).toBe('2026-09-20T10:00:00.000Z')
  })

  it('never throws on structurally random input', () => {
    const shapes: unknown[] = [
      { id: 'c', identities: null }, { id: 'c', identities: 'x' }, { id: 'c', identities: [null] },
      { id: 'c', identities: [undefined] }, { id: 'c', identities: [7] }, { id: 'c', identities: [{}] },
      { id: 'c', identities: [{ id: '' }] }, { id: 'c', identities: [{ id: 'a', channel: null }] },
      { id: 'c', identities: [{ id: 'a', channel: {}, isActive: 'yes' }] },
    ]
    for (const shape of shapes) {
      expect(() => buildContactReachabilityEvidenceViewV1(shape as ContactReachabilityEvidenceSourceV1)).not.toThrow()
    }
  })

  it('never leaks a provider or runtime value even when the source carries every one', () => {
    const view = buildContactReachabilityEvidenceViewV1(source([
      {
        ...identityRow(),
        externalId: 'tg-user-77012345678',
        providerAccountId: 'tg-bot-7712345678',
        providerTargetId: '900000000001',
        connectionId: 'wa-slot-a',
        transportRef: 'max-personal-0123456789abcdef01234567',
        metadata: { providerAccountId: 'tg-bot-7712345678', sessionId: 'session-1' },
        chatId: 'chat-1',
        conversationRoute: 'route-1',
        driverId: 'driver-1',
      },
    ]))
    expectNoLeak(view)
    const serialized = JSON.stringify(view)
    for (const secret of FORBIDDEN_VALUES) {
      expect(serialized, `leaked ${secret}`).not.toContain(secret)
    }
    for (const key of ['metadata', 'externalId', 'reachabilityStatus', 'reachabilityCheckedAt']) {
      expect(serialized, `leaked key ${key}`).not.toContain(key)
    }
  })

  it('uses no vocabulary that could be read as current availability', () => {
    const view = buildContactReachabilityEvidenceViewV1(source([
      identityRow(),
      identityRow({ id: 'identity-2', reachabilityStatus: 'unreachable' }),
      identityRow({ id: 'identity-3', reachabilityStatus: 'unknown', reachabilityCheckedAt: null }),
    ]))
    const serialized = withoutSanctionedVocabulary(JSON.stringify(view)).toLowerCase()
    for (const word of AVAILABILITY_WORDS) {
      expect(serialized, `output says ${word}`).not.toContain(word.toLowerCase())
    }
    // Every status value is explicitly a record of the past.
    for (const identity of view.identities) {
      expect(['recorded_confirmed', 'recorded_unreachable', 'no_evidence']).toContain(identity.evidenceStatus)
    }
  })
})

describe('createContactReachabilityEvidenceViewHandlerV1', () => {
  it('trims the id, rejects a blank one and never calls the port for it', async () => {
    let calls = 0
    const handler = createContactReachabilityEvidenceViewHandlerV1({
      async findContactReachabilityEvidenceSource(contactId) {
        calls += 1
        expect(contactId).toBe('contact-1')
        return source([identityRow()])
      },
    })
    expect(await handler('  ')).toBeNull()
    expect(await handler(undefined as unknown as string)).toBeNull()
    expect(calls).toBe(0)
    expect(await handler(' contact-1 ')).toMatchObject({ contactId: 'contact-1' })
    expect(calls).toBe(1)
  })

  it('returns null for an unknown Contact', async () => {
    const handler = createContactReachabilityEvidenceViewHandlerV1({
      findContactReachabilityEvidenceSource: async () => null,
    })
    expect(await handler('missing')).toBeNull()
  })

  it('reads exactly the requested Contact and follows no redirect', async () => {
    // ContactLineage.v1 owns canonical redirect resolution. A second lookup here
    // would be a second canonicalization layer, so the port is asserted to be
    // called once with the requested id and nothing else.
    const requested: string[] = []
    const handler = createContactReachabilityEvidenceViewHandlerV1({
      async findContactReachabilityEvidenceSource(contactId) {
        requested.push(contactId)
        return source([identityRow()])
      },
    })
    const view = await handler('merged-away-contact')
    expect(requested).toEqual(['merged-away-contact'])
    expect(view?.contactId).toBe('contact-1')
  })

  it('returns an archived Contact normally, because its evidence is still a recorded fact', async () => {
    const handler = createContactReachabilityEvidenceViewHandlerV1({
      findContactReachabilityEvidenceSource: async () => source([identityRow()]),
    })
    const view = await handler('archived-contact')
    expect(view?.identities[0].evidenceStatus).toBe('recorded_confirmed')
  })

  it('performs no provider call and no live probe', async () => {
    // The projection is pure and the handler's only collaborator is the port.
    let portCalls = 0
    const handler = createContactReachabilityEvidenceViewHandlerV1({
      async findContactReachabilityEvidenceSource() {
        portCalls += 1
        return source([identityRow()])
      },
    })
    await handler('contact-1')
    expect(portCalls).toBe(1)
  })
})
