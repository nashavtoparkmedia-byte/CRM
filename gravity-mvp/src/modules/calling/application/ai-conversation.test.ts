import { describe, expect, it, vi } from 'vitest'
import {
  AI_CONVERSATIONS_FOR_CONTACT_QUERY_V1,
  START_AI_CONVERSATION_COMMAND_V1,
  AiConversationContractValidationError,
  AiConversationRequestConflictError,
  type AiConversationRuntimeModeV1,
} from '@/contracts/calling/v1/ai-conversation'
import type { ContactCommunicationPermissionResultV1, ContactPersonCardResultV1, ContactPersonCardV1 } from '@/contracts/contacts/v1'
import {
  aiConversationId,
  aiConversationTimingPolicyV1,
  aiConversationPersonEligibility,
  createAiConversationOperations,
  maskAiConversationDestination,
  type AiConversationClaimResult,
  type AiConversationProviderPort,
  type AiConversationRecordV1,
  type AiConversationSnapshotV1,
  type AiConversationStorePort,
} from './ai-conversation'

const TIMING = aiConversationTimingPolicyV1()
const CONTACT = 'contact-allowed'
const PHONE = '+79161234567'

function card(overrides: Partial<ContactPersonCardV1> = {}): ContactPersonCardV1 {
  return {
    contactId: CONTACT,
    displayName: 'Иван Петров',
    displayTitle: 'Иван Петров',
    primaryPhone: PHONE,
    displayNameSource: 'yandex',
    source: 'yandex',
    personConfirmation: { state: 'confirmed', confirmedPersonName: 'Иван Петров', confirmedClusterKeyCount: 1, representativeDriverId: 'driver-1' },
    mainDriverId: 'driver-1',
    legacyYandexDriverId: null,
    phones: [{
      phoneId: 'phone-1', phone: PHONE, isPrimary: true, isActive: true, lifecycle: 'current', trust: 'provider_bound',
      freshness: 'fresh', resolutionState: 'unique', verifiedAt: null, lastSeenAt: null,
    }],
    channels: [],
    lineage: { contactIds: [CONTACT], mergedFromCount: 0, mergeHistory: [] } as unknown as ContactPersonCardV1['lineage'],
    conflicts: [],
    hasOpenConflict: false,
    hasPersonBlockingConflict: false,
    candidates: [],
    automation: { doNotMerge: false, canonicalPinned: false, mergeRecoveryState: null },
    isArchived: false,
    linkHistory: [],
    ...overrides,
  }
}

function confirmed(value: ContactPersonCardV1 = card()): ContactPersonCardResultV1 {
  return { contract: 'contacts.ContactPersonCardResult.v1', status: 'confirmed', card: value } as ContactPersonCardResultV1
}

function permission(decision: 'allow' | 'deny', reason = decision === 'allow' ? 'no_restriction' : 'restricted_voice', retryable = false, canonical: string | null = CONTACT): ContactCommunicationPermissionResultV1 {
  return {
    contract: 'contacts.ContactCommunicationPermissionResult.v1',
    decision, retryable, reason: reason as ContactCommunicationPermissionResultV1['reason'],
    requestedContactId: CONTACT, communicationClass: 'voice', canonicalContactId: canonical, policyVersion: 3,
  }
}

/** In-memory store with the adapter's guarantees: per-contact serialised claim, CAS transitions. */
function memoryStore() {
  const rows = new Map<string, AiConversationSnapshotV1>()
  const locks = new Map<string, Promise<unknown>>()
  const clone = (snapshot: AiConversationSnapshotV1): AiConversationSnapshotV1 => structuredClone(snapshot)
  const store: AiConversationStorePort & { rows: typeof rows; patchFacts(id: string, facts: Partial<AiConversationSnapshotV1['facts']>): void } = {
    rows,
    patchFacts(id, facts) {
      const row = rows.get(id)!
      rows.set(id, { ...row, facts: { ...row.facts, ...facts } })
    },
    async find(id) {
      const row = rows.get(id)
      return row ? clone(row) : null
    },
    async claim(record, occupies) {
      const previous = locks.get(record.contactId) ?? Promise.resolve()
      let release!: () => void
      const held = new Promise<void>(resolve => { release = resolve })
      locks.set(record.contactId, previous.then(() => held))
      await previous
      try {
        await new Promise(resolve => setTimeout(resolve, 1))
        const existing = rows.get(record.conversationId)
        if (existing) return { kind: 'existing', snapshot: clone(existing) } satisfies AiConversationClaimResult
        const now = new Date(record.createdAt)
        for (const row of rows.values()) {
          if (row.record.contactId === record.contactId && occupies(row, now)) {
            return { kind: 'busy', activeConversationId: row.record.conversationId } satisfies AiConversationClaimResult
          }
        }
        const snapshot: AiConversationSnapshotV1 = {
          record: structuredClone(record),
          facts: {
            callStatus: 'ringing', aiSessionStatus: 'starting', lifecycleState: 'starting', startedAt: record.createdAt,
            answeredAt: null, endedAt: null, updatedAt: record.createdAt, aiOutcome: null, aiSummary: null,
            qualificationScore: null, qualification: null, transcript: [],
          },
        }
        rows.set(record.conversationId, snapshot)
        return { kind: 'created', snapshot: clone(snapshot) } satisfies AiConversationClaimResult
      } finally {
        release()
      }
    },
    async transition(id, expected, next) {
      const row = rows.get(id)
      if (!row || row.record.revision !== expected || next.revision !== expected + 1) return null
      rows.set(id, { ...row, record: structuredClone(next) })
      return clone(rows.get(id)!)
    },
    async listForContact(contactId, limit) {
      return [...rows.values()].filter(row => row.record.contactId === contactId)
        .sort((a, b) => b.record.createdAt.localeCompare(a.record.createdAt)).slice(0, limit).map(clone)
    },
  }
  return store
}

function setup(options: {
  mode?: AiConversationRuntimeModeV1
  principal?: { kind: string } | null
  person?: ContactPersonCardResultV1 | ((id: string) => ContactPersonCardResultV1)
  permissions?: Array<ContactCommunicationPermissionResultV1 | Error>
} = {}) {
  let clock = Date.parse('2026-11-08T10:00:00.000Z')
  const store = memoryStore()
  const permissions = [...(options.permissions ?? [])]
  const voicePermission = vi.fn(async () => {
    const next = permissions.length > 1 ? permissions.shift()! : permissions[0] ?? permission('allow')
    if (next instanceof Error) throw next
    return next
  })
  const effectsAtOriginate: string[] = []
  const provider = {
    originate: vi.fn<AiConversationProviderPort['originate']>(async ({ conversationId }) => {
      effectsAtOriginate.push(store.rows.get(conversationId)!.record.effect.phase)
      return { kind: 'accepted' as const, providerReference: `ref:${conversationId}` }
    }),
    progress: vi.fn<AiConversationProviderPort['progress']>(async snapshot => {
      store.patchFacts(snapshot.record.conversationId, { lifecycleState: 'greeting', answeredAt: new Date(clock).toISOString() })
      return null
    }),
  }
  const wake = vi.fn()
  const ops = createAiConversationOperations({
    mode: async () => options.mode ?? 'simulated',
    principal: async () => options.principal === undefined ? { kind: 'integration_admin_session' } : options.principal,
    readPerson: vi.fn(async (id: string) => {
      const person = options.person ?? confirmed()
      return typeof person === 'function' ? person(id) : person
    }),
    voicePermission,
    store,
    provider,
    now: () => new Date(clock),
    wake,
  })
  return { ops, store, provider, voicePermission, wake, effectsAtOriginate, tick: (ms: number) => { clock += ms } }
}

const command = (requestId = 'request-0000000001', extra: Record<string, unknown> = {}) => ({
  contract: START_AI_CONVERSATION_COMMAND_V1, requestId, contactId: CONTACT, ...extra,
})

describe('AI conversation admission', () => {
  it('is OFF unless the runtime is simulated, and creates nothing', async () => {
    const { ops, store, voicePermission } = setup({ mode: 'disabled' })
    await expect(ops.start(command())).resolves.toMatchObject({ status: 'refused', reason: 'disabled' })
    expect(store.rows.size).toBe(0)
    expect(voicePermission).not.toHaveBeenCalled()
  })

  it('refuses without a verified principal (expired manager session) and lists nothing', async () => {
    const { ops, store } = setup({ principal: null })
    await expect(ops.start(command())).resolves.toMatchObject({ status: 'refused', reason: 'unauthenticated' })
    await expect(ops.listForContact({ contract: AI_CONVERSATIONS_FOR_CONTACT_QUERY_V1, contactId: CONTACT }))
      .resolves.toMatchObject({ status: 'unauthenticated' })
    expect(store.rows.size).toBe(0)
  })

  it('rejects a malformed command before reading anything', async () => {
    const { ops, voicePermission } = setup()
    await expect(ops.start({ ...command(), requestId: 'short' })).rejects.toBeInstanceOf(AiConversationContractValidationError)
    await expect(ops.start({ ...command(), phone: PHONE })).rejects.toBeInstanceOf(AiConversationContractValidationError)
    await expect(ops.start({ ...command(), simulationVariant: 'live' })).rejects.toBeInstanceOf(AiConversationContractValidationError)
    expect(voicePermission).not.toHaveBeenCalled()
  })

  it.each([
    ['unconfirmed person', card({ personConfirmation: { state: 'unconfirmed', confirmedPersonName: null, confirmedClusterKeyCount: 0, representativeDriverId: null } }), 'identity_unconfirmed'],
    ['pending reconciliation', card({ personConfirmation: { state: 'needs_reconciliation', confirmedPersonName: null, confirmedClusterKeyCount: 0, representativeDriverId: null } }), 'identity_conflict'],
    ['contradiction', card({ personConfirmation: { state: 'contradiction', confirmedPersonName: null, confirmedClusterKeyCount: 2, representativeDriverId: null } }), 'identity_conflict'],
    ['blocking conflict', card({ hasPersonBlockingConflict: true }), 'identity_conflict'],
    ['archived contact', card({ isArchived: true }), 'contact_changed'],
    ['shared phone', card({ phones: [{ ...card().phones[0], resolutionState: 'shared' }] }), 'no_primary_phone'],
    ['disputed phone', card({ phones: [{ ...card().phones[0], resolutionState: 'disputed' }] }), 'no_primary_phone'],
    ['superseded phone', card({ phones: [{ ...card().phones[0], lifecycle: 'superseded' }] }), 'no_primary_phone'],
    ['inactive phone', card({ phones: [{ ...card().phones[0], isActive: false }] }), 'no_primary_phone'],
    ['only a secondary phone', card({ phones: [{ ...card().phones[0], isPrimary: false }] }), 'no_primary_phone'],
    ['no phone', card({ phones: [] }), 'no_primary_phone'],
  ])('fails closed for %s', async (_name, value, reason) => {
    const { ops, store, voicePermission } = setup({ person: confirmed(value) })
    await expect(ops.start(command())).resolves.toMatchObject({ status: 'refused', reason })
    expect(store.rows.size).toBe(0)
    expect(voicePermission).not.toHaveBeenCalled()
  })

  it.each([
    ['missing', 'contact_changed', false],
    ['forbidden', 'unauthenticated', false],
    ['refused', 'contact_changed', false],
  ] as const)('maps a Contacts %s answer to %s', async (status, reason, retryable) => {
    const { ops, store } = setup({ person: { contract: 'contacts.ContactPersonCardResult.v1', status } as ContactPersonCardResultV1 })
    await expect(ops.start(command())).resolves.toMatchObject({ status: 'refused', reason, retryable })
    expect(store.rows.size).toBe(0)
  })

  it('never follows a merge redirect: the card on screen is no longer the canonical person', async () => {
    const person = vi.fn((id: string) => id === 'contact-old'
      ? { contract: 'contacts.ContactPersonCardResult.v1', status: 'redirected', canonicalContactId: CONTACT } as ContactPersonCardResultV1
      : confirmed())
    const { ops, store, voicePermission } = setup({ person })
    await expect(ops.start({ ...command(), contactId: 'contact-old' })).resolves.toMatchObject({ status: 'refused', reason: 'contact_changed' })
    expect(person).toHaveBeenCalledTimes(1)
    expect(voicePermission).not.toHaveBeenCalled()
    expect(store.rows.size).toBe(0)
    await expect(ops.listForContact({ contract: AI_CONVERSATIONS_FOR_CONTACT_QUERY_V1, contactId: 'contact-old' }))
      .resolves.toMatchObject({ status: 'contact_changed' })
  })

  it('refuses a confirmed answer that names another Contact than the one asked about', async () => {
    const { ops, store } = setup({ person: confirmed(card({ contactId: 'contact-other' })) })
    await expect(ops.start(command())).resolves.toMatchObject({ status: 'refused', reason: 'contact_changed' })
    expect(store.rows.size).toBe(0)
  })

  it.each([
    ['denyVoice', permission('deny', 'restricted_voice'), 'voice_restricted', false],
    ['denyAll', permission('deny', 'restricted_all'), 'voice_restricted', false],
    ['an unknown Contact', permission('deny', 'contact_unknown', false, null), 'voice_restricted', false],
    ['an unavailable policy store', permission('deny', 'policy_unavailable', true, null), 'voice_permission_unavailable', true],
    ['a throwing permission service', new Error('contacts down'), 'voice_permission_unavailable', true],
    ['an unknown decision value', { ...permission('allow'), decision: 'maybe' } as unknown as ContactCommunicationPermissionResultV1, 'voice_restricted', false],
  ])('refuses at admission for %s and creates no Call', async (_name, answer, reason, retryable) => {
    const { ops, store, provider } = setup({ permissions: [answer] })
    await expect(ops.start(command())).resolves.toMatchObject({ status: 'refused', reason, retryable })
    expect(store.rows.size).toBe(0)
    expect(provider.originate).not.toHaveBeenCalled()
  })

  it.each([
    ['without a canonical Contact', permission('allow', 'no_restriction', false, null)],
    ['for another requested Contact', { ...permission('allow'), requestedContactId: 'contact-other' }],
  ])('refuses an allow decided %s', async (_name, answer) => {
    const { ops, store } = setup({ permissions: [answer] })
    await expect(ops.start(command())).resolves.toMatchObject({ status: 'refused', reason: 'identity_conflict' })
    expect(store.rows.size).toBe(0)
  })

  it('refuses when Contacts made the permission decision for a different canonical person', async () => {
    const { ops, store } = setup({ permissions: [permission('allow', 'no_restriction', false, 'contact-other')] })
    await expect(ops.start(command())).resolves.toMatchObject({ status: 'refused', reason: 'identity_conflict' })
    expect(store.rows.size).toBe(0)
  })

  it('names the destination only masked', async () => {
    const { ops } = setup()
    const result = await ops.start(command())
    expect(result.status === 'accepted' && result.conversation.destinationMasked).toBe('+•••••••4567')
    expect(JSON.stringify(result)).not.toContain(PHONE)
    expect(maskAiConversationDestination('+12')).toBe('••••')
  })

  it('dials only the primary phone and never falls back to another phone of the card', () => {
    const primary = { ...card().phones[0], phoneId: 'primary', phone: '+79990000002', isPrimary: true }
    const secondary = { ...card().phones[0], phoneId: 'secondary', phone: '+79990000001', isPrimary: false }
    expect(aiConversationPersonEligibility(card({ phones: [secondary, primary] }), 'simulated')).toEqual({ ok: true, destination: '+79990000002' })
    expect(aiConversationPersonEligibility(card({ phones: [secondary, { ...primary, resolutionState: 'disputed' }] }), 'simulated'))
      .toEqual({ ok: false, reason: 'no_primary_phone' })
  })

  it('accepts an unknown phone resolution only in the simulated runtime', () => {
    const legacy = card({ phones: [{ ...card().phones[0], resolutionState: 'unknown' }] })
    expect(aiConversationPersonEligibility(legacy, 'simulated')).toEqual({ ok: true, destination: PHONE })
    expect(aiConversationPersonEligibility(legacy, 'disabled')).toEqual({ ok: false, reason: 'no_primary_phone' })
  })
})

describe('AI conversation idempotency and concurrency', () => {
  it('replays a double click (same requestId) as the same conversation, never a second one', async () => {
    const { ops, store, provider } = setup()
    const [first, second] = await Promise.all([ops.start(command()), ops.start(command())])
    expect(first).toMatchObject({ status: 'accepted' })
    expect(second).toMatchObject({ status: 'accepted' })
    expect([first, second].filter(result => result.status === 'accepted' && result.duplicate)).toHaveLength(1)
    expect(store.rows.size).toBe(1)
    const id = aiConversationId(CONTACT, 'request-0000000001')
    await Promise.all([ops.advance(id), ops.advance(id)])
    expect(provider.originate).toHaveBeenCalledTimes(1)
  })

  it('refuses a reused requestId that carries a different request', async () => {
    const { ops } = setup()
    await ops.start(command())
    await expect(ops.start(command(undefined, { simulationVariant: 'interrupted' }))).rejects.toBeInstanceOf(AiConversationRequestConflictError)
  })

  it('lets only one of two managers start a conversation with the same person', async () => {
    const { ops, store } = setup()
    const results = await Promise.all([ops.start(command('manager-a-00000001')), ops.start(command('manager-b-00000001'))])
    const acceptedOnes = results.filter(result => result.status === 'accepted')
    const busy = results.filter(result => result.status === 'refused')
    expect(acceptedOnes).toHaveLength(1)
    expect(busy).toEqual([expect.objectContaining({ reason: 'busy', activeConversationId: acceptedOnes[0].status === 'accepted' ? acceptedOnes[0].conversation.conversationId : null })])
    expect(store.rows.size).toBe(1)
  })

  it('originates exactly once when several drivers advance the same conversation', async () => {
    const { ops, provider } = setup()
    await ops.start(command())
    const id = aiConversationId(CONTACT, 'request-0000000001')
    await Promise.all([ops.advance(id), ops.advance(id), ops.advance(id)])
    expect(provider.originate).toHaveBeenCalledTimes(1)
  })
})

describe('AI conversation provider effect', () => {
  it('re-reads permission fresh and commits dispatch_started before the provider is asked', async () => {
    const { ops, provider, voicePermission, effectsAtOriginate, store } = setup()
    const started = await ops.start(command())
    expect(started).toMatchObject({ status: 'accepted', duplicate: false, conversation: { state: 'queued' } })
    const id = aiConversationId(CONTACT, 'request-0000000001')
    await ops.advance(id)
    expect(voicePermission).toHaveBeenCalledTimes(2)
    expect(provider.originate).toHaveBeenCalledWith({ conversationId: id, destination: PHONE, variant: 'success' })
    expect(effectsAtOriginate).toEqual(['dispatch_started'])
    const record = store.rows.get(id)!.record
    expect(record.effect.phase).toBe('accepted')
    expect(record.step).toBe('connected')
    expect(record.permissionChecks.map(check => [check.phase, check.decision])).toEqual([['admission', 'allow'], ['pre_originate', 'allow']])
  })

  it('never originates when denyVoice is set between the start and the provider effect', async () => {
    const { ops, provider, store } = setup({ permissions: [permission('allow'), permission('deny', 'restricted_voice')] })
    await ops.start(command())
    const id = aiConversationId(CONTACT, 'request-0000000001')
    const result = await ops.advance(id)
    expect(provider.originate).not.toHaveBeenCalled()
    expect(result?.record.terminal).toMatchObject({ state: 'refused', failure: 'voice_restricted' })
    expect(store.rows.get(id)!.record.effect.phase).toBe('prepared')
    // A refusal never occupied anything physical: the next start is decided by permission
    // (still denied), not refused as busy.
    await expect(ops.start(command('request-0000000002'))).resolves.toMatchObject({ status: 'refused', reason: 'voice_restricted' })
  })

  it('never originates when the permission service is down at the provider effect', async () => {
    const { ops, provider } = setup({ permissions: [permission('allow'), new Error('timeout')] })
    await ops.start(command())
    const result = await ops.advance(aiConversationId(CONTACT, 'request-0000000001'))
    expect(provider.originate).not.toHaveBeenCalled()
    expect(result?.record.terminal).toMatchObject({ state: 'refused', failure: 'voice_permission_unavailable' })
  })

  it('records a provider rejection as failed and frees the person', async () => {
    const { ops, provider } = setup()
    provider.originate.mockResolvedValueOnce({ kind: 'rejected', providerReplyExcerpt: '-ERR NO_ROUTE_DESTINATION'.repeat(10) })
    await ops.start(command())
    const result = await ops.advance(aiConversationId(CONTACT, 'request-0000000001'))
    expect(result?.record.effect.phase).toBe('rejected')
    expect(result?.record.effect.providerReplyExcerpt?.length).toBeLessThanOrEqual(120)
    expect(result?.record.terminal).toMatchObject({ state: 'failed', failure: 'provider_rejected' })
    await expect(ops.start(command('request-0000000002'))).resolves.toMatchObject({ status: 'accepted' })
  })

  it('treats a lost originate reply as outcome_unknown: no automatic re-originate, the person stays occupied', async () => {
    const { ops, provider, tick } = setup()
    provider.originate.mockRejectedValueOnce(new Error('reply lost'))
    await ops.start(command())
    const id = aiConversationId(CONTACT, 'request-0000000001')
    const result = await ops.advance(id)
    expect(result?.record.terminal).toMatchObject({ state: 'outcome_unknown' })
    tick(5_000)
    await ops.advance(id)
    await ops.listForContact({ contract: AI_CONVERSATIONS_FOR_CONTACT_QUERY_V1, contactId: CONTACT })
    expect(provider.originate).toHaveBeenCalledTimes(1)
    await expect(ops.start(command('request-0000000002'))).resolves.toMatchObject({ status: 'refused', reason: 'busy', activeConversationId: id })
    tick(TIMING.unknownOccupancyMs)
    await expect(ops.start(command('request-0000000003'))).resolves.toMatchObject({ status: 'accepted' })
  })

  it('resolves a dispatch interrupted by a process restart as outcome_unknown after the originate ceiling, never re-sending', async () => {
    const { ops, provider, store, tick } = setup()
    await ops.start(command())
    const id = aiConversationId(CONTACT, 'request-0000000001')
    // The process died right after committing dispatch_started.
    const row = store.rows.get(id)!
    store.rows.set(id, { ...row, record: { ...row.record, step: 'dispatching', revision: row.record.revision + 1, effect: { ...row.record.effect, phase: 'dispatch_started', dispatchStartedAt: row.record.createdAt } } })
    tick(1_000)
    await ops.advance(id)
    expect(store.rows.get(id)!.record.terminal).toBeNull()
    tick(TIMING.originateTimeoutMs)
    const result = await ops.advance(id)
    expect(result?.record.terminal).toMatchObject({ state: 'outcome_unknown' })
    expect(result?.record.effect.phase).toBe('outcome_unknown')
    expect(provider.originate).not.toHaveBeenCalled()
  })

  it('abandons a conversation that never reached its provider effect in time, without dialling late', async () => {
    const { ops, provider, tick } = setup()
    await ops.start(command())
    tick(TIMING.queueHorizonMs + 1)
    const result = await ops.advance(aiConversationId(CONTACT, 'request-0000000001'))
    expect(result?.record.terminal).toMatchObject({ state: 'failed', failure: 'expired' })
    expect(provider.originate).not.toHaveBeenCalled()
  })

  it('resumes from durable state when the list is read after a restart (no in-process timer)', async () => {
    const { ops, provider, store } = setup()
    await ops.start(command())
    const answer = await ops.listForContact({ contract: AI_CONVERSATIONS_FOR_CONTACT_QUERY_V1, contactId: CONTACT })
    expect(provider.originate).toHaveBeenCalledTimes(1)
    expect(answer).toMatchObject({ status: 'ok', mode: 'simulated', conversations: [expect.objectContaining({ state: 'ringing' })] })
    const id = aiConversationId(CONTACT, 'request-0000000001')
    expect(store.rows.get(id)!.record.step).toBe('connected')
  })

  it('derives the conversation lifecycle from the Core facts', async () => {
    const { ops, store } = setup()
    await ops.start(command())
    const id = aiConversationId(CONTACT, 'request-0000000001')
    await ops.advance(id)
    const read = async () => (await ops.listForContact({ contract: AI_CONVERSATIONS_FOR_CONTACT_QUERY_V1, contactId: CONTACT }))
    store.patchFacts(id, { lifecycleState: 'active', answeredAt: '2026-11-08T10:00:01.000Z', transcript: [{ ordinal: 1, speaker: 'assistant', text: 'Здравствуйте' }] })
    expect(await read()).toMatchObject({ conversations: [expect.objectContaining({ state: 'in_conversation', transcript: [expect.objectContaining({ text: 'Здравствуйте' })] })] })
    store.patchFacts(id, { lifecycleState: 'ended', aiSessionStatus: 'ended', endedAt: '2026-11-08T10:00:09.000Z', aiOutcome: 'qualified', qualification: 'qualified', aiSummary: 'ok', qualificationScore: 82 })
    expect(await read()).toMatchObject({ conversations: [expect.objectContaining({ state: 'completed', outcome: { qualification: 'qualified', summary: 'ok', score: 82, classification: 'qualified' } })] })
    store.patchFacts(id, { aiOutcome: 'dropped_mid_call', qualification: null })
    expect(await read()).toMatchObject({ conversations: [expect.objectContaining({ state: 'interrupted', failure: 'interrupted' })] })
  })
})

describe('AI conversation record shape', () => {
  it('keeps the request identity deterministic per person and request', () => {
    expect(aiConversationId(CONTACT, 'request-0000000001')).toBe(aiConversationId(CONTACT, 'request-0000000001'))
    expect(aiConversationId(CONTACT, 'request-0000000001')).not.toBe(aiConversationId('contact-other', 'request-0000000001'))
    expect(aiConversationId(CONTACT, 'request-0000000001')).toMatch(/^aiconv_[0-9a-f]{32}$/u)
  })

  it('stores the admission decision it acted on', async () => {
    const { ops, store } = setup()
    await ops.start(command())
    const record: AiConversationRecordV1 = store.rows.get(aiConversationId(CONTACT, 'request-0000000001'))!.record
    expect(record).toMatchObject({ initiation: 'manual', mode: 'simulated', principalKind: 'integration_admin_session', destination: PHONE, step: 'queued' })
    expect(record.permissionChecks).toEqual([expect.objectContaining({ phase: 'admission', decision: 'allow', policyVersion: 3 })])
  })
})
