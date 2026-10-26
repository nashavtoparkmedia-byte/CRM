/**
 * The contact communication policy semantic, proven over in-memory ports.
 *
 * What matters here is the decision order and the fail-closed defaults, not
 * that rows are copied: an unknown Contact, an unavailable store, an unsupported
 * class and a broken lineage are all denies; a replay answers from the event
 * before anything else; a stale version never writes; the merge composition is
 * deny-wins; and recovery reverses a composition only when the append-only event
 * chain proves nothing newer was decided.
 */
import { describe, expect, it } from 'vitest'

import {
  CONTACT_COMMUNICATION_PERMISSION_QUERY_V1,
  CONTACT_COMMUNICATION_PERMISSION_RESULT_V1,
  SET_CONTACT_COMMUNICATION_POLICY_COMMAND_V1,
  SET_CONTACT_COMMUNICATION_POLICY_RESULT_V1,
  type ContactCommunicationRestrictionStateV1,
} from '@/contracts/contacts/v1'

import {
  CONTACT_COMMUNICATION_MERGE_ACTOR_FALLBACK_V1,
  CONTACT_COMMUNICATION_NO_RESTRICTION_V1,
  composeContactCommunicationPolicyV1,
  contactCommunicationPolicyActorV1,
  contactCommunicationPolicyRequestDigestV1,
  createContactCommunicationPermissionQueryHandlerV1,
  createSetContactCommunicationPolicyHandlerV1,
  decideContactCommunicationPolicyRecoveryV1,
  evaluateContactCommunicationRestrictionV1,
  parseContactMergeCommunicationPolicyEvidenceV1,
  type ContactCommunicationPermissionStateV1,
  type ContactCommunicationPolicyEventInputV1,
  type ContactCommunicationPolicyLockedScopeV1,
  type ContactCommunicationPolicyMutationPortV1,
  type ContactCommunicationPolicyReadPortV1,
  type ContactCommunicationPolicySnapshotV1,
} from './contact-communication-policy'
import { createResolveContactLineageHandlerV1 } from './contact-lineage-handler'

const ALL: ContactCommunicationRestrictionStateV1 = { denyAll: true, denyMessage: false, denyVoice: false }
const MESSAGE: ContactCommunicationRestrictionStateV1 = { denyAll: false, denyMessage: true, denyVoice: false }
const VOICE: ContactCommunicationRestrictionStateV1 = { denyAll: false, denyMessage: false, denyVoice: true }
const NONE: ContactCommunicationRestrictionStateV1 = { denyAll: false, denyMessage: false, denyVoice: false }

const query = (contactId: string, communicationClass: string) => ({
  contract: CONTACT_COMMUNICATION_PERMISSION_QUERY_V1, contactId, communicationClass,
})

// ---------------------------------------------------------------------------
// Permission query
// ---------------------------------------------------------------------------

function readPort(state: ContactCommunicationPermissionStateV1 | (() => never)) {
  const calls: string[] = []
  const port: ContactCommunicationPolicyReadPortV1 = {
    async readPermissionState(requestedContactId) {
      calls.push(requestedContactId)
      if (typeof state === 'function') state()
      return state as ContactCommunicationPermissionStateV1
    },
  }
  return { port, calls }
}

describe('ContactCommunicationPermissionQuery.v1', () => {
  it('allows a known canonical Contact without a policy row and reports version 0', async () => {
    const { port } = readPort({ kind: 'found', canonicalContactId: 'c1', isArchived: false, policy: null })
    await expect(createContactCommunicationPermissionQueryHandlerV1(port)(query('c1', 'message'))).resolves.toEqual({
      contract: CONTACT_COMMUNICATION_PERMISSION_RESULT_V1,
      decision: 'allow',
      retryable: false,
      reason: 'no_restriction',
      requestedContactId: 'c1',
      communicationClass: 'message',
      canonicalContactId: 'c1',
      policyVersion: 0,
    })
  })

  it('denies an unknown Contact, non-retryable', async () => {
    const { port } = readPort({ kind: 'unknown' })
    await expect(createContactCommunicationPermissionQueryHandlerV1(port)(query('ghost', 'voice'))).resolves.toMatchObject({
      decision: 'deny', retryable: false, reason: 'contact_unknown', canonicalContactId: null, policyVersion: null,
    })
  })

  it('denies retryably when the policy or lineage store is unavailable', async () => {
    const { port } = readPort(() => { throw new Error('connection refused') })
    await expect(createContactCommunicationPermissionQueryHandlerV1(port)(query('c1', 'message'))).resolves.toMatchObject({
      decision: 'deny', retryable: true, reason: 'policy_unavailable', canonicalContactId: null,
    })
  })

  it('denies retryably when the lineage is unsafe to establish', async () => {
    for (const code of ['CONTACT_MERGE_REDIRECT_CYCLE', 'CONTACT_MERGE_REDIRECT_DEPTH_EXCEEDED']) {
      const { port } = readPort(() => { throw new Error(code) })
      await expect(createContactCommunicationPermissionQueryHandlerV1(port)(query('c1', 'message'))).resolves.toMatchObject({
        decision: 'deny', retryable: true, reason: 'lineage_unsafe',
      })
    }
  })

  it('denies an unsupported class, non-retryable, without touching any store', async () => {
    const { port, calls } = readPort(() => { throw new Error('must not be reached') })
    for (const unsupported of ['telegram', 'fax', 'all', 'Message']) {
      await expect(createContactCommunicationPermissionQueryHandlerV1(port)(query('c1', unsupported))).resolves.toMatchObject({
        decision: 'deny', retryable: false, reason: 'unsupported_communication_class', communicationClass: unsupported,
      })
    }
    expect(calls).toEqual([])
  })

  it('ALL denies message and voice', async () => {
    const { port } = readPort({ kind: 'found', canonicalContactId: 'c1', isArchived: false, policy: { ...ALL, version: 3 } })
    const handler = createContactCommunicationPermissionQueryHandlerV1(port)
    for (const cls of ['message', 'voice']) {
      await expect(handler(query('c1', cls))).resolves.toMatchObject({
        decision: 'deny', retryable: false, reason: 'restricted_all', canonicalContactId: 'c1', policyVersion: 3,
      })
    }
  })

  it('MESSAGE denies message and does not deny voice', async () => {
    const { port } = readPort({ kind: 'found', canonicalContactId: 'c1', isArchived: false, policy: { ...MESSAGE, version: 1 } })
    const handler = createContactCommunicationPermissionQueryHandlerV1(port)
    await expect(handler(query('c1', 'message'))).resolves.toMatchObject({ decision: 'deny', reason: 'restricted_message' })
    await expect(handler(query('c1', 'voice'))).resolves.toMatchObject({ decision: 'allow', reason: 'no_restriction', policyVersion: 1 })
  })

  it('VOICE denies voice and does not deny message', async () => {
    const { port } = readPort({ kind: 'found', canonicalContactId: 'c1', isArchived: false, policy: { ...VOICE, version: 1 } })
    const handler = createContactCommunicationPermissionQueryHandlerV1(port)
    await expect(handler(query('c1', 'voice'))).resolves.toMatchObject({ decision: 'deny', reason: 'restricted_voice' })
    await expect(handler(query('c1', 'message'))).resolves.toMatchObject({ decision: 'allow', reason: 'no_restriction' })
  })

  it('an all-false row is as permitted as no row', async () => {
    const { port } = readPort({ kind: 'found', canonicalContactId: 'c1', isArchived: false, policy: { ...NONE, version: 4 } })
    await expect(createContactCommunicationPermissionQueryHandlerV1(port)(query('c1', 'message'))).resolves.toMatchObject({
      decision: 'allow', policyVersion: 4,
    })
  })

  it('denies an archived canonical Contact, non-retryable', async () => {
    const { port } = readPort({ kind: 'found', canonicalContactId: 'c1', isArchived: true, policy: null })
    await expect(createContactCommunicationPermissionQueryHandlerV1(port)(query('c1', 'message'))).resolves.toMatchObject({
      decision: 'deny', retryable: false, reason: 'contact_archived', canonicalContactId: 'c1', policyVersion: 0,
    })
  })

  it('resolves a merged-away id through the existing lineage handler to the survivor policy', async () => {
    // A port built the way the Prisma adapter builds it: the real lineage
    // handler over an in-memory redirect table, then the canonical policy.
    const redirects = new Map([['loser', 'survivor'], ['survivor', null]])
    const policies = new Map<string, ContactCommunicationPolicySnapshotV1>([['survivor', { ...MESSAGE, version: 2 }]])
    const resolveLineage = createResolveContactLineageHandlerV1({
      async findRedirect(id) { return redirects.has(id) ? { id, mergedIntoContactId: redirects.get(id) ?? null } : null },
      async findMergedContactIds() { return [] },
    })
    const port: ContactCommunicationPolicyReadPortV1 = {
      async readPermissionState(requestedContactId) {
        const lineage = await resolveLineage(requestedContactId)
        if (lineage === null) return { kind: 'unknown' }
        return { kind: 'found', canonicalContactId: lineage.canonicalContactId, isArchived: false, policy: policies.get(lineage.canonicalContactId) ?? null }
      },
    }
    const handler = createContactCommunicationPermissionQueryHandlerV1(port)
    await expect(handler(query('loser', 'message'))).resolves.toMatchObject({
      decision: 'deny', reason: 'restricted_message', requestedContactId: 'loser', canonicalContactId: 'survivor', policyVersion: 2,
    })
    await expect(handler(query('loser', 'voice'))).resolves.toMatchObject({ decision: 'allow', canonicalContactId: 'survivor' })
  })

  it('refuses structural garbage by throwing, like every other Contacts contract', async () => {
    const { port } = readPort({ kind: 'unknown' })
    await expect(createContactCommunicationPermissionQueryHandlerV1(port)({ contactId: 'c1' })).rejects.toThrow(/contract must equal/u)
  })
})

describe('evaluateContactCommunicationRestrictionV1', () => {
  it('lets denyAll win over the class flags and never restricts without a row', () => {
    expect(evaluateContactCommunicationRestrictionV1(null, 'message')).toEqual({ restricted: false, reason: 'no_restriction' })
    expect(evaluateContactCommunicationRestrictionV1({ denyAll: true, denyMessage: false, denyVoice: false }, 'voice')).toEqual({ restricted: true, reason: 'restricted_all' })
    expect(evaluateContactCommunicationRestrictionV1(MESSAGE, 'message').reason).toBe('restricted_message')
    expect(evaluateContactCommunicationRestrictionV1(MESSAGE, 'voice').restricted).toBe(false)
    expect(evaluateContactCommunicationRestrictionV1(VOICE, 'voice').reason).toBe('restricted_voice')
    expect(evaluateContactCommunicationRestrictionV1(VOICE, 'message').restricted).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Mutation
// ---------------------------------------------------------------------------

type Store = {
  contacts: Map<string, { isArchived: boolean; mergedIntoContactId: string | null }>
  policies: Map<string, ContactCommunicationPolicySnapshotV1>
  events: ContactCommunicationPolicyEventInputV1[]
  locks: string[]
  writes: number
  failWrite?: boolean
}

function memoryPort(seed?: Partial<Store>) {
  const store: Store = {
    contacts: new Map([['c1', { isArchived: false, mergedIntoContactId: null }]]),
    policies: new Map(),
    events: [],
    locks: [],
    writes: 0,
    ...seed,
  }
  let busy: Promise<unknown> = Promise.resolve()
  const resolveLineage = createResolveContactLineageHandlerV1({
    async findRedirect(id) {
      const contact = store.contacts.get(id)
      return contact ? { id, mergedIntoContactId: contact.mergedIntoContactId } : null
    },
    async findMergedContactIds() { return [] },
  })
  const scope: ContactCommunicationPolicyLockedScopeV1 = {
    resolveLineage,
    async readContact(id) {
      const contact = store.contacts.get(id)
      return contact ? { isArchived: contact.isArchived } : null
    },
    async findMutationEvent(requestId) {
      const event = store.events.find(item => item.mutationRequestId === requestId)
      return event ? { contactId: event.contactId, requestDigest: event.requestDigest ?? '', version: event.version, after: event.after } : null
    },
    async readPolicy(id) { return store.policies.get(id) ?? null },
    async writePolicy(input) {
      const current = store.policies.get(input.contactId) ?? null
      if (store.failWrite || (current?.version ?? 0) !== input.expectedVersion) {
        throw new Error('CAS_FAILED')
      }
      store.writes += 1
      store.policies.set(input.contactId, { ...input.restriction, version: input.version })
    },
    async appendEvent(input) { store.events.push(input) },
  }
  const port: ContactCommunicationPolicyMutationPortV1 = {
    // The real port serializes through CNT1; the in-memory one serializes
    // through a promise chain so two concurrent calls run one after the other.
    runLocked(contactId, work) {
      const run = busy.then(async () => {
        store.locks.push(contactId)
        return work(scope)
      })
      busy = run.catch(() => undefined)
      return run
    },
  }
  return { store, port, handler: createSetContactCommunicationPolicyHandlerV1(port) }
}

const setCommand = (overrides: Record<string, unknown> = {}) => ({
  contract: SET_CONTACT_COMMUNICATION_POLICY_COMMAND_V1,
  requestId: 'req-1',
  contactId: 'c1',
  expectedVersion: 0,
  restriction: MESSAGE,
  actor: 'operator-1',
  reason: 'asked not to be messaged',
  ...overrides,
})

describe('SetContactCommunicationPolicyCommand.v1', () => {
  it('applies the exact requested state at version 1 under the Contact lock and records one mutation event', async () => {
    const { store, handler } = memoryPort()
    await expect(handler(setCommand())).resolves.toEqual({
      contract: SET_CONTACT_COMMUNICATION_POLICY_RESULT_V1, status: 'applied', contactId: 'c1', version: 1, restriction: MESSAGE,
    })
    expect(store.locks).toEqual(['c1'])
    expect(store.policies.get('c1')).toEqual({ ...MESSAGE, version: 1 })
    expect(store.events).toEqual([expect.objectContaining({
      contactId: 'c1', cause: 'mutation', version: 1, previousVersion: null, before: null, after: MESSAGE,
      actor: 'operator-1', reason: 'asked not to be messaged', mutationRequestId: 'req-1', mergeId: null, sourceContactId: null,
    })])
    expect(store.events[0].requestDigest).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('replays a duplicate identical request without writing again', async () => {
    const { store, handler } = memoryPort()
    await handler(setCommand())
    await expect(handler(setCommand())).resolves.toMatchObject({ status: 'replayed', version: 1, restriction: MESSAGE })
    expect(store.writes).toBe(1)
    expect(store.events).toHaveLength(1)
  })

  it('still replays after the Contact was merged away, instead of becoming a new decision elsewhere', async () => {
    const { store, handler } = memoryPort()
    await handler(setCommand())
    store.contacts.set('c1', { isArchived: true, mergedIntoContactId: 'survivor' })
    store.contacts.set('survivor', { isArchived: false, mergedIntoContactId: null })
    await expect(handler(setCommand())).resolves.toMatchObject({ status: 'replayed', version: 1 })
    expect(store.writes).toBe(1)
  })

  it('conflicts on a duplicate requestId with a different payload, and on the same requestId for another Contact', async () => {
    const { store, handler } = memoryPort()
    await handler(setCommand())
    await expect(handler(setCommand({ restriction: ALL }))).resolves.toEqual({
      contract: SET_CONTACT_COMMUNICATION_POLICY_RESULT_V1, status: 'idempotency_conflict', contactId: 'c1', requestId: 'req-1',
    })
    await expect(handler(setCommand({ reason: 'another reason' }))).resolves.toMatchObject({ status: 'idempotency_conflict' })
    await expect(handler(setCommand({ actor: 'operator-2' }))).resolves.toMatchObject({ status: 'idempotency_conflict' })
    store.contacts.set('c2', { isArchived: false, mergedIntoContactId: null })
    await expect(handler(setCommand({ contactId: 'c2' }))).resolves.toMatchObject({ status: 'idempotency_conflict', contactId: 'c2' })
    expect(store.writes).toBe(1)
  })

  it('conflicts on a stale expected version without writing', async () => {
    const { store, handler } = memoryPort()
    await handler(setCommand())
    await expect(handler(setCommand({ requestId: 'req-2', expectedVersion: 0, restriction: ALL }))).resolves.toEqual({
      contract: SET_CONTACT_COMMUNICATION_POLICY_RESULT_V1, status: 'version_conflict', contactId: 'c1', expectedVersion: 0, currentVersion: 1,
    })
    await expect(handler(setCommand({ requestId: 'req-3', expectedVersion: 5 }))).resolves.toMatchObject({ status: 'version_conflict', currentVersion: 1 })
    expect(store.writes).toBe(1)
    expect(store.events).toHaveLength(1)
  })

  it('serializes concurrent mutations so the second cannot overwrite the newer version', async () => {
    const { store, handler } = memoryPort()
    const [first, second] = await Promise.all([
      handler(setCommand({ requestId: 'req-a', restriction: MESSAGE })),
      handler(setCommand({ requestId: 'req-b', restriction: NONE })),
    ])
    expect(first).toMatchObject({ status: 'applied', version: 1 })
    expect(second).toMatchObject({ status: 'version_conflict', expectedVersion: 0, currentVersion: 1 })
    expect(store.policies.get('c1')).toEqual({ ...MESSAGE, version: 1 })
    expect(store.events).toHaveLength(1)
  })

  it('a failed compare-and-set throws and appends no event', async () => {
    const { store, handler } = memoryPort({ failWrite: true })
    await expect(handler(setCommand())).rejects.toThrow('CAS_FAILED')
    expect(store.events).toEqual([])
  })

  it('advances the version on every applied request, including one that changes nothing', async () => {
    const { store, handler } = memoryPort()
    await handler(setCommand())
    await expect(handler(setCommand({ requestId: 'req-2', expectedVersion: 1 }))).resolves.toMatchObject({ status: 'applied', version: 2 })
    expect(store.policies.get('c1')?.version).toBe(2)
    expect(store.events.map(event => [event.version, event.previousVersion, event.before])).toEqual([[1, null, null], [2, 1, MESSAGE]])
  })

  it('clears a restriction only through an explicit exact state', async () => {
    const { store, handler } = memoryPort()
    await handler(setCommand({ restriction: ALL }))
    await expect(handler(setCommand({ requestId: 'req-2', expectedVersion: 1, restriction: NONE }))).resolves.toMatchObject({ status: 'applied', version: 2, restriction: NONE })
    expect(store.policies.get('c1')).toEqual({ ...NONE, version: 2 })
  })

  it('rejects an unknown Contact', async () => {
    const { store, handler } = memoryPort()
    await expect(handler(setCommand({ contactId: 'ghost' }))).resolves.toEqual({
      contract: SET_CONTACT_COMMUNICATION_POLICY_RESULT_V1, status: 'contact_not_found', contactId: 'ghost',
    })
    expect(store.writes).toBe(0)
  })

  it('rejects a merged-away Contact and names its canonical survivor', async () => {
    const { store, handler } = memoryPort()
    store.contacts.set('loser', { isArchived: true, mergedIntoContactId: 'c1' })
    await expect(handler(setCommand({ contactId: 'loser' }))).resolves.toEqual({
      contract: SET_CONTACT_COMMUNICATION_POLICY_RESULT_V1, status: 'contact_not_canonical', contactId: 'loser', canonicalContactId: 'c1',
    })
    expect(store.writes).toBe(0)
  })

  it('rejects an archived Contact without a redirect and a broken lineage', async () => {
    const { store, handler } = memoryPort()
    store.contacts.set('c1', { isArchived: true, mergedIntoContactId: null })
    await expect(handler(setCommand())).resolves.toMatchObject({ status: 'lineage_unsafe', reason: 'archived_without_redirect' })
    store.contacts.set('a', { isArchived: true, mergedIntoContactId: 'b' })
    store.contacts.set('b', { isArchived: true, mergedIntoContactId: 'a' })
    await expect(handler(setCommand({ contactId: 'a' }))).resolves.toMatchObject({ status: 'lineage_unsafe', reason: 'redirect_cycle' })
    store.contacts.set('dangling', { isArchived: true, mergedIntoContactId: 'nowhere' })
    await expect(handler(setCommand({ contactId: 'dangling' }))).resolves.toMatchObject({ status: 'contact_not_found' })
    expect(store.writes).toBe(0)
  })

  it('refuses a command that carries an override or a channel', async () => {
    const { handler } = memoryPort()
    await expect(handler(setCommand({ override: true }))).rejects.toThrow(/unsupported command field/u)
    await expect(handler(setCommand({ channel: 'telegram' }))).rejects.toThrow(/unsupported command field/u)
  })

  it('leaves the policy untouched by identity changes, because nothing about an identity is an input', async () => {
    // The mutation scope has no identity operation at all; the policy is keyed
    // by Contact id only. Changing identities in the store cannot move it.
    const { store, handler } = memoryPort()
    await handler(setCommand({ restriction: ALL }))
    const before = structuredClone(store.policies.get('c1'))
    const identities = new Map([['id-1', { contactId: 'c1', isActive: true }]])
    identities.set('id-1', { contactId: 'c1', isActive: false })
    identities.delete('id-1')
    identities.set('id-2', { contactId: 'c1', isActive: true })
    expect(store.policies.get('c1')).toEqual(before)
    expect(JSON.stringify(Object.keys(store.policies.get('c1') ?? {}))).not.toMatch(/identity/iu)
  })
})

describe('contactCommunicationPolicyRequestDigestV1', () => {
  it('is deterministic and insensitive to property order, and sensitive to every semantic field', () => {
    const base = { contactId: 'c1', expectedVersion: 0, restriction: MESSAGE, actor: 'op', reason: 'r' }
    const reordered = { reason: 'r', actor: 'op', restriction: { denyVoice: false, denyMessage: true, denyAll: false }, expectedVersion: 0, contactId: 'c1' }
    expect(contactCommunicationPolicyRequestDigestV1(base)).toBe(contactCommunicationPolicyRequestDigestV1(reordered))
    for (const variant of [
      { ...base, contactId: 'c2' }, { ...base, expectedVersion: 1 }, { ...base, restriction: ALL },
      { ...base, actor: 'op2' }, { ...base, reason: 'other' },
    ]) {
      expect(contactCommunicationPolicyRequestDigestV1(variant)).not.toBe(contactCommunicationPolicyRequestDigestV1(base))
    }
  })
})

describe('contactCommunicationPolicyActorV1', () => {
  it('keeps a usable actor and falls back on an unusable one', () => {
    expect(contactCommunicationPolicyActorV1('manager-1', CONTACT_COMMUNICATION_MERGE_ACTOR_FALLBACK_V1)).toBe('manager-1')
    expect(contactCommunicationPolicyActorV1(' manager-1 ', CONTACT_COMMUNICATION_MERGE_ACTOR_FALLBACK_V1)).toBe('manager-1')
    for (const unusable of ['', '   ', 'x'.repeat(129), 'bad\u0000actor', undefined, null, 7]) {
      expect(contactCommunicationPolicyActorV1(unusable, CONTACT_COMMUNICATION_MERGE_ACTOR_FALLBACK_V1)).toBe(CONTACT_COMMUNICATION_MERGE_ACTOR_FALLBACK_V1)
    }
  })
})

// ---------------------------------------------------------------------------
// Merge composition
// ---------------------------------------------------------------------------

describe('composeContactCommunicationPolicyV1', () => {
  it('is deny-wins for every flag: false+true, true+false and true+true all give true', () => {
    for (const flag of ['denyAll', 'denyMessage', 'denyVoice'] as const) {
      const on = { ...NONE, [flag]: true }
      expect(composeContactCommunicationPolicyV1(NONE, on)?.[flag]).toBe(true)
      expect(composeContactCommunicationPolicyV1(on, NONE)?.[flag]).toBe(true)
      expect(composeContactCommunicationPolicyV1(on, on)?.[flag]).toBe(true)
      expect(composeContactCommunicationPolicyV1(NONE, NONE)?.[flag]).toBe(false)
    }
  })

  it('writes nothing for two Contacts without a policy and keeps the one side that has one', () => {
    expect(composeContactCommunicationPolicyV1(null, null)).toBeNull()
    expect(composeContactCommunicationPolicyV1(ALL, null)).toEqual(ALL)
    expect(composeContactCommunicationPolicyV1(null, VOICE)).toEqual(VOICE)
    expect(composeContactCommunicationPolicyV1(MESSAGE, VOICE)).toEqual({ denyAll: false, denyMessage: true, denyVoice: true })
  })

  it('is associative across a chain, so A->B->C composes the same in any order', () => {
    const a = MESSAGE
    const b = VOICE
    const c = NONE
    expect(composeContactCommunicationPolicyV1(composeContactCommunicationPolicyV1(a, b), c))
      .toEqual(composeContactCommunicationPolicyV1(a, composeContactCommunicationPolicyV1(b, c)))
  })
})

// ---------------------------------------------------------------------------
// Merge evidence and recovery
// ---------------------------------------------------------------------------

describe('parseContactMergeCommunicationPolicyEvidenceV1', () => {
  const valid = { sourceBefore: { ...ALL, version: 2 }, survivorBefore: { ...NONE, version: 1 }, composed: { ...ALL, version: 2 } }

  it('reads absent, present and malformed evidence', () => {
    expect(parseContactMergeCommunicationPolicyEvidenceV1(undefined)).toEqual({ kind: 'absent' })
    expect(parseContactMergeCommunicationPolicyEvidenceV1(null)).toEqual({ kind: 'absent' })
    expect(parseContactMergeCommunicationPolicyEvidenceV1(valid)).toEqual({ kind: 'present', evidence: valid })
    expect(parseContactMergeCommunicationPolicyEvidenceV1({ sourceBefore: null, survivorBefore: null, composed: null }))
      .toEqual({ kind: 'present', evidence: { sourceBefore: null, survivorBefore: null, composed: null } })
    for (const malformed of [
      'x', [], {}, { ...valid, extra: 1 }, { ...valid, composed: null },
      { sourceBefore: null, survivorBefore: null, composed: { ...NONE, version: 1 } },
      { ...valid, composed: { ...NONE, version: 2 } },
      { ...valid, composed: { ...ALL, version: 5 } },
      { ...valid, sourceBefore: { denyAll: 'yes', denyMessage: false, denyVoice: false, version: 1 } },
      { ...valid, survivorBefore: { ...NONE, version: 0 } },
    ]) {
      expect(parseContactMergeCommunicationPolicyEvidenceV1(malformed)).toEqual({ kind: 'malformed' })
    }
  })
})

describe('decideContactCommunicationPolicyRecoveryV1', () => {
  const present = (evidence: Parameters<typeof parseContactMergeCommunicationPolicyEvidenceV1>[0]) => parseContactMergeCommunicationPolicyEvidenceV1(evidence)
  const composedAt = (state: ContactCommunicationRestrictionStateV1, version: number) => ({ ...state, version })

  it('restores the survivor pre-merge flags when the composed state is still current', () => {
    const evidence = present({ sourceBefore: composedAt(ALL, 1), survivorBefore: composedAt(MESSAGE, 2), composed: composedAt({ ...ALL, denyMessage: true }, 3) })
    expect(decideContactCommunicationPolicyRecoveryV1({
      evidence, survivorCurrent: composedAt({ ...ALL, denyMessage: true }, 3), sourceCurrent: composedAt(ALL, 1), laterSurvivorEvents: [],
    })).toEqual({ kind: 'restore', currentVersion: 3, before: { ...ALL, denyMessage: true }, restoreTo: MESSAGE })
  })

  it('restores to an explicit all-false row when the survivor had no row before the merge', () => {
    const evidence = present({ sourceBefore: composedAt(VOICE, 1), survivorBefore: null, composed: composedAt(VOICE, 1) })
    expect(decideContactCommunicationPolicyRecoveryV1({
      evidence, survivorCurrent: composedAt(VOICE, 1), sourceCurrent: composedAt(VOICE, 1), laterSurvivorEvents: [],
    })).toEqual({ kind: 'restore', currentVersion: 1, before: VOICE, restoreTo: { ...CONTACT_COMMUNICATION_NO_RESTRICTION_V1 } })
  })

  it('has nothing to restore when the merge composed nothing and nothing was added since', () => {
    const evidence = present({ sourceBefore: null, survivorBefore: null, composed: null })
    expect(decideContactCommunicationPolicyRecoveryV1({ evidence, survivorCurrent: null, sourceCurrent: null, laterSurvivorEvents: [] }))
      .toEqual({ kind: 'nothing_to_restore' })
    expect(decideContactCommunicationPolicyRecoveryV1({ evidence, survivorCurrent: composedAt(ALL, 1), sourceCurrent: null, laterSurvivorEvents: [] }))
      .toEqual({ kind: 'blocked', reason: 'communication_policy_changed_after_merge' })
  })

  it('blocks when a post-merge mutation changed the survivor policy, even to the same flags', () => {
    const evidence = present({ sourceBefore: composedAt(ALL, 1), survivorBefore: null, composed: composedAt(ALL, 1) })
    expect(decideContactCommunicationPolicyRecoveryV1({
      evidence, survivorCurrent: composedAt(NONE, 2), sourceCurrent: composedAt(ALL, 1),
      laterSurvivorEvents: [{ cause: 'mutation', version: 2, mergeId: null }],
    })).toEqual({ kind: 'blocked', reason: 'communication_policy_changed_after_merge' })
    expect(decideContactCommunicationPolicyRecoveryV1({
      evidence, survivorCurrent: composedAt(ALL, 2), sourceCurrent: composedAt(ALL, 1),
      laterSurvivorEvents: [{ cause: 'mutation', version: 2, mergeId: null }],
    })).toEqual({ kind: 'blocked', reason: 'communication_policy_changed_after_merge' })
  })

  it('tolerates later merges that were reversed in last-in-first-out order and blocks an unreversed one', () => {
    const evidence = present({ sourceBefore: composedAt(ALL, 1), survivorBefore: null, composed: composedAt(ALL, 1) })
    const paired = [
      { cause: 'merge' as const, version: 2, mergeId: 'm2' },
      { cause: 'merge' as const, version: 3, mergeId: 'm3' },
      { cause: 'merge_recovery' as const, version: 4, mergeId: 'm3' },
      { cause: 'merge_recovery' as const, version: 5, mergeId: 'm2' },
    ]
    expect(decideContactCommunicationPolicyRecoveryV1({
      evidence, survivorCurrent: composedAt(ALL, 5), sourceCurrent: composedAt(ALL, 1), laterSurvivorEvents: paired,
    })).toMatchObject({ kind: 'restore', currentVersion: 5 })
    expect(decideContactCommunicationPolicyRecoveryV1({
      evidence, survivorCurrent: composedAt(ALL, 2), sourceCurrent: composedAt(ALL, 1), laterSurvivorEvents: paired.slice(0, 1),
    })).toEqual({ kind: 'blocked', reason: 'communication_policy_changed_after_merge' })
    // Out-of-order reversal, a gap, or a row version the chain does not reach all block.
    expect(decideContactCommunicationPolicyRecoveryV1({
      evidence, survivorCurrent: composedAt(ALL, 5), sourceCurrent: composedAt(ALL, 1),
      laterSurvivorEvents: [paired[0], paired[1], { ...paired[2], mergeId: 'm2' }, { ...paired[3], mergeId: 'm3' }],
    })).toMatchObject({ kind: 'blocked' })
    expect(decideContactCommunicationPolicyRecoveryV1({
      evidence, survivorCurrent: composedAt(ALL, 5), sourceCurrent: composedAt(ALL, 1), laterSurvivorEvents: [paired[0], { ...paired[3], version: 5 }],
    })).toMatchObject({ kind: 'blocked' })
    expect(decideContactCommunicationPolicyRecoveryV1({
      evidence, survivorCurrent: composedAt(ALL, 6), sourceCurrent: composedAt(ALL, 1), laterSurvivorEvents: paired,
    })).toMatchObject({ kind: 'blocked' })
  })

  it('blocks when the merged-away Contact row no longer matches what the merge recorded', () => {
    const evidence = present({ sourceBefore: composedAt(ALL, 1), survivorBefore: null, composed: composedAt(ALL, 1) })
    expect(decideContactCommunicationPolicyRecoveryV1({
      evidence, survivorCurrent: composedAt(ALL, 1), sourceCurrent: composedAt(ALL, 2), laterSurvivorEvents: [],
    })).toEqual({ kind: 'blocked', reason: 'source_policy_changed_after_merge' })
  })

  it('blocks a merge without evidence whose survivor already carries a policy, and otherwise restores nothing', () => {
    expect(decideContactCommunicationPolicyRecoveryV1({ evidence: { kind: 'absent' }, survivorCurrent: composedAt(ALL, 1), sourceCurrent: null, laterSurvivorEvents: [] }))
      .toEqual({ kind: 'blocked', reason: 'communication_policy_without_merge_evidence' })
    expect(decideContactCommunicationPolicyRecoveryV1({ evidence: { kind: 'absent' }, survivorCurrent: null, sourceCurrent: null, laterSurvivorEvents: [] }))
      .toEqual({ kind: 'nothing_to_restore' })
    expect(decideContactCommunicationPolicyRecoveryV1({ evidence: { kind: 'malformed' }, survivorCurrent: null, sourceCurrent: null, laterSurvivorEvents: [] }))
      .toEqual({ kind: 'blocked', reason: 'communication_policy_evidence_invalid' })
  })
})
