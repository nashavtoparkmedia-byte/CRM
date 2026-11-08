import { describe, expect, it } from 'vitest'
import {
  HOST_AUDIENCE_SUBMISSION_V1,
  START_COMMUNICATION_RUN_COMMAND_V1,
  type CommunicationSandboxConfigV1,
} from '../../../contracts/communication-workspace/v1'
import { createSimulatedCommunicationEffectsV1 } from '../internal/communication-effects'
import { decideGuardV1 } from './communication-policy'
import {
  createCommunicationServiceV1,
  type CommunicationEffectsV1,
  type CommunicationEventRowV1,
  type CommunicationExecutionRowV1,
  type CommunicationMemberRowV1,
  type CommunicationRunRowV1,
  type CommunicationStorePortV1,
  type ContactsPermissionPortV1,
} from './communication-run-service'

// ── A faithful in-memory store: same guard, lease and version semantics ─────

function memoryStore(): CommunicationStorePortV1 & { events: CommunicationEventRowV1[]; executions: Map<string, CommunicationExecutionRowV1 & { leaseOwner: string | null; leaseUntil: Date | null }>; guards: Map<string, { activeParticipantId: string | null; cooldownUntil: Date | null }> } {
  const projects = new Map<string, { id: string; key: string; title: string }>()
  const runs = new Map<string, CommunicationRunRowV1>()
  const members: CommunicationMemberRowV1[] = []
  const executions = new Map<string, CommunicationExecutionRowV1 & { leaseOwner: string | null; leaseUntil: Date | null }>()
  const events: CommunicationEventRowV1[] = []
  const guards = new Map<string, { activeParticipantId: string | null; cooldownUntil: Date | null }>()
  const append = (item: CommunicationEventRowV1) => {
    if (events.some((existing) => existing.dedupeKey === item.dedupeKey)) return false
    events.push(item)
    return true
  }
  return {
    events,
    executions,
    guards,
    async ensureProject(definition) {
      const found = [...projects.values()].find((project) => project.key === definition.key)
      if (found) return { id: found.id }
      const id = `cwp-${definition.key}`
      projects.set(id, { id, key: definition.key, title: definition.title })
      return { id }
    },
    async findRunByIdempotencyKey(key) {
      return [...runs.values()].find((run) => run.idempotencyKey === key) ?? null
    },
    async listRuns(limit) {
      return [...runs.values()].slice(0, limit)
    },
    async createRun({ run, members: rows, candidates, scope, now }) {
      const existing = [...runs.values()].find((candidate) => candidate.idempotencyKey === run.idempotencyKey)
      if (existing) return { created: false, existingRunId: existing.id }
      const project = projects.get(run.projectId)!
      runs.set(run.id, { ...run, projectKey: project.key, projectTitle: project.title, createdAt: now })
      const final = rows.map((row) => ({ ...row }))
      let admitted = 0
      for (const candidate of [...candidates].sort((a, b) => a.canonicalContactId.localeCompare(b.canonicalContactId))) {
        const key = `${scope}|${candidate.canonicalContactId}`
        const verdict = decideGuardV1(guards.get(key) ?? null, now)
        const member = final.find((row) => row.id === candidate.memberId)!
        if (verdict !== 'free') {
          member.admission = 'excluded'
          member.exclusionReason = verdict
          continue
        }
        guards.set(key, { activeParticipantId: candidate.participantId, cooldownUntil: null })
        executions.set(candidate.participantId, {
          id: candidate.participantId, runId: run.id, audienceMemberId: candidate.memberId, canonicalContactId: candidate.canonicalContactId,
          state: 'admitted', nextActionAt: now, version: 0, attempts: 0, messageRequestId: null, messageOutcome: null, messageAcceptedAt: null,
          callRequestId: null, callOutcome: null, outcome: null, leaseOwner: null, leaseUntil: null,
        })
        admitted += 1
      }
      members.push(...final)
      for (const member of final) {
        const participant = [...executions.values()].find((execution) => execution.audienceMemberId === member.id)
        append({ id: `adm-${member.id}`, runId: run.id, participantId: participant?.id ?? null, dedupeKey: `${run.id}:admission:${member.id}`,
          kind: member.admission === 'admitted' ? 'contact_admitted' : 'contact_excluded',
          detail: { audienceMemberId: member.id, exclusionReason: member.exclusionReason }, occurredAt: now })
      }
      return { created: true, admitted, guardExcluded: candidates.length - admitted }
    },
    async readRun(runId) { return runs.get(runId) ?? null },
    async listMembers(runId) { return members.filter((member) => member.runId === runId) },
    async listExecutions(runId) { return [...executions.values()].filter((execution) => execution.runId === runId).map(({ leaseOwner: _o, leaseUntil: _u, ...row }) => row) },
    async readExecution(id) {
      const row = executions.get(id)
      if (!row) return null
      const { leaseOwner: _o, leaseUntil: _u, ...rest } = row
      return rest
    },
    async listEvents(runId, participantId) { return events.filter((item) => item.runId === runId && (!participantId || item.participantId === participantId)) },
    async claimDue({ runId, now, owner, leaseUntil, limit }) {
      const due = [...executions.values()]
        .filter((row) => ['admitted', 'waiting_reply', 'calling'].includes(row.state))
        .filter((row) => !row.nextActionAt || row.nextActionAt.getTime() <= now.getTime())
        .filter((row) => !row.leaseUntil || row.leaseUntil.getTime() < now.getTime())
        .filter((row) => !runId || row.runId === runId)
        .slice(0, limit)
      for (const row of due) { row.leaseOwner = owner; row.leaseUntil = leaseUntil }
      return due.map(({ leaseOwner: _o, leaseUntil: _u, ...row }) => ({ ...row }))
    },
    async transition({ id, owner, fromVersion, patch, events: rows, releaseGuard, now }) {
      const row = executions.get(id)
      if (!row || row.version !== fromVersion) return false
      if (row.leaseOwner && row.leaseOwner !== owner && row.leaseUntil && row.leaseUntil.getTime() >= now.getTime()) return false
      Object.assign(row, patch, { version: row.version + 1 })
      const release = releaseGuard !== null || (patch.nextActionAt instanceof Date && patch.nextActionAt.getTime() > now.getTime())
      if (release) { row.leaseOwner = null; row.leaseUntil = null }
      rows.forEach(append)
      if (releaseGuard) {
        const key = `${releaseGuard.scope}|${releaseGuard.canonicalContactId}`
        if (guards.get(key)?.activeParticipantId === id) guards.set(key, { activeParticipantId: null, cooldownUntil: releaseGuard.cooldownUntil })
      }
      return true
    },
    async appendEvent(item) { return append(item) },
    async findEvent(key) { return events.find((item) => item.dedupeKey === key) ?? null },
  }
}

// ── Fixture ─────────────────────────────────────────────────────────────

const ALLOW = (id: string) => ({ decision: 'allow' as const, canonicalContactId: id })

function harness(options: { permissions?: Record<string, ReturnType<ContactsPermissionPortV1['check']> extends Promise<infer R> ? R : never>; voiceDenied?: Set<string> } = {}) {
  let now = new Date('2026-11-08T10:00:00.000Z')
  let seq = 0
  const store = memoryStore()
  const permissionCalls: string[] = []
  const contacts: ContactsPermissionPortV1 = {
    async check(contactId, communicationClass) {
      permissionCalls.push(`${communicationClass}:${contactId}`)
      if (communicationClass === 'voice' && options.voiceDenied?.has(contactId)) return { decision: 'deny', reason: 'restricted_voice', retryable: false, canonicalContactId: contactId }
      return options.permissions?.[contactId] ?? ALLOW(contactId)
    },
  }
  const clock = () => now
  const effects = createSimulatedCommunicationEffectsV1(store, clock)
  const build = (overrideEffects?: CommunicationEffectsV1) => createCommunicationServiceV1({ store, contacts, effects: overrideEffects ?? effects, clock, newId: () => `id${(seq += 1).toString().padStart(4, '0')}` })
  return {
    store,
    contacts,
    permissionCalls,
    service: build(),
    rebuild: build,
    tick(seconds: number) { now = new Date(now.getTime() + seconds * 1000) },
    effectsFor(kind: 'message' | 'call') { return store.events.filter((item) => item.kind === 'simulated_provider_effect' && item.detail.effect === kind) },
  }
}

function command(contactIds: string[], options: { snapshotRef?: string; projectKey?: string; sandbox?: Partial<CommunicationSandboxConfigV1> } = {}) {
  return {
    contract: START_COMMUNICATION_RUN_COMMAND_V1,
    projectKey: options.projectKey ?? 'churn-return-v1',
    mode: 'sandbox',
    audience: {
      contract: HOST_AUDIENCE_SUBMISSION_V1,
      hostModule: 'churn',
      triggerKey: 'fleet.churn.no_orders_days',
      triggerVersion: 1,
      snapshotRef: options.snapshotRef ?? 'snap-1',
      evaluatedAt: '2026-11-08T09:59:00.000Z',
      criteria: { minInactiveDays: 5 },
      members: contactIds.map((contactId) => ({ contactId, reason: 'Нет заказов 7 дн.', sourceRef: `driver:${contactId}`, businessContext: { displayName: `Водитель ${contactId}`, inactiveDays: 7 } })),
    },
    sandbox: { allowlistContactIds: contactIds, waitSecondsOverride: 10, cooldownSecondsOverride: 60, simulatedOutcomes: {}, ...options.sandbox },
    requestedBy: 'identity-access:integration-admin-session',
  }
}

async function runToEnd(h: ReturnType<typeof harness>, runId: string, rounds = 6) {
  for (let index = 0; index < rounds; index += 1) {
    await h.service.detectReplies({ runId, owner: 'w' })
    await h.service.advance({ runId, owner: 'w' })
    h.tick(11)
  }
}

describe('Communication Workspace execution core', () => {
  it('runs the happy path: admitted → message → wait → no reply → call → outcome, with a full audit trail', async () => {
    const h = harness()
    const started = await h.service.startRun(command(['c1']))
    expect(started).toMatchObject({ outcome: 'started', matched: 1, admitted: 1, excluded: 0 })
    if (started.outcome === 'refused') throw new Error('refused')
    await runToEnd(h, started.runId)
    const report = await h.service.report(started.runId)
    expect(report?.metrics).toMatchObject({ matched: 1, admitted: 1, messagesRequested: 1, messagesAccepted: 1, callsRequested: 1, completed: 1, waiting: 0, messagesDelivered: null })
    expect(report?.metrics.outcomes).toEqual({ call_answered: 1 })
    const [member] = await h.store.listMembers(started.runId)
    const timeline = await h.service.timeline(started.runId, member.id)
    expect(timeline?.events.map((item) => item.kind)).toEqual([
      'contact_admitted', 'permission_rechecked_skipped_marker',
    ].filter((kind) => kind !== 'permission_rechecked_skipped_marker').concat([
      'message_requested', 'simulated_provider_effect', 'message_accepted', 'wait_started', 'wait_elapsed', 'call_requested', 'simulated_provider_effect', 'call_answered',
    ]))
    expect(h.effectsFor('message')).toHaveLength(1)
    expect(h.effectsFor('call')).toHaveLength(1)
  })

  it('a reply stops the flow: no call after the Contact answered, even when the wait already elapsed', async () => {
    const h = harness()
    const started = await h.service.startRun(command(['c1']))
    if (started.outcome === 'refused') throw new Error('refused')
    await h.service.advance({ runId: started.runId, owner: 'w' })
    const [execution] = await h.store.listExecutions(started.runId)
    expect(execution.state).toBe('waiting_reply')
    expect((await h.service.simulateSandboxReply(execution.id, 'да')).ok).toBe(true)
    h.tick(30)
    await h.service.advance({ runId: started.runId, owner: 'w' })
    const [after] = await h.store.listExecutions(started.runId)
    expect(after).toMatchObject({ state: 'completed', outcome: 'replied' })
    expect(h.effectsFor('call')).toHaveLength(0)
    expect(h.store.events.some((item) => item.kind === 'call_requested')).toBe(false)
  })

  it('a reply that arrives between "wait elapsed" and the call request still prevents the call', async () => {
    const h = harness()
    const started = await h.service.startRun(command(['c1'], { sandbox: { waitSecondsOverride: 0 } }))
    if (started.outcome === 'refused') throw new Error('refused')
    // Move to calling without performing the call: reply is recorded right after the wait transition.
    const effects = createSimulatedCommunicationEffectsV1(h.store, () => new Date())
    let replyNow = false
    const interposed = h.rebuild({ ...effects, reply: { async hasReplySince(input) { const value = replyNow; replyNow = true; return value || effects.reply.hasReplySince(input) } } })
    await interposed.advance({ runId: started.runId, owner: 'w' })
    const [after] = await h.store.listExecutions(started.runId)
    expect(after).toMatchObject({ state: 'completed', outcome: 'replied' })
    expect(h.effectsFor('call')).toHaveLength(0)
  })

  it('the same host snapshot submitted twice is one Run, and one Contact twice in a snapshot is admitted once', async () => {
    const h = harness()
    const first = await h.service.startRun(command(['c1', 'c1', 'c2']))
    const second = await h.service.startRun(command(['c1', 'c1', 'c2']))
    expect(first).toMatchObject({ outcome: 'started', matched: 3, admitted: 2, excluded: 1 })
    if (first.outcome === 'refused' || second.outcome === 'refused') throw new Error('refused')
    expect(second).toMatchObject({ outcome: 'replayed', runId: first.runId, admitted: 2 })
    const members = await h.store.listMembers(first.runId)
    expect(members.filter((member) => member.exclusionReason === 'duplicate_in_snapshot')).toHaveLength(1)
    await runToEnd(h, first.runId)
    expect(h.effectsFor('message')).toHaveLength(2)
  })

  it('two ids of one merged person are one participant (duplicate_canonical_contact)', async () => {
    const h = harness({ permissions: { 'old-id': ALLOW('canon'), canon: ALLOW('canon') } })
    const started = await h.service.startRun(command(['canon', 'old-id']))
    expect(started).toMatchObject({ admitted: 1, excluded: 1 })
  })

  it('a repeated effect request never produces a second effect (restart after the effect, before the commit)', async () => {
    const h = harness()
    const started = await h.service.startRun(command(['c1']))
    if (started.outcome === 'refused') throw new Error('refused')
    // A worker that "crashes" after the provider call: its transition never commits.
    const crashing = { ...h.store, transition: async () => false }
    const crashed = createCommunicationServiceV1({ store: crashing, contacts: h.contacts, effects: createSimulatedCommunicationEffectsV1(h.store, () => new Date()), clock: () => new Date('2026-11-08T10:00:00.000Z'), newId: () => 'x' })
    await crashed.advance({ runId: started.runId, owner: 'crashed-worker' })
    expect(h.effectsFor('message')).toHaveLength(1)
    // A new process takes over after the lease expires and repeats the same step.
    h.tick(31)
    const restarted = h.rebuild()
    await restarted.advance({ runId: started.runId, owner: 'restarted-worker' })
    expect(h.effectsFor('message')).toHaveLength(1)
    const [after] = await h.store.listExecutions(started.runId)
    expect(after.state).toBe('waiting_reply')
  })

  it('global "do not disturb" excludes at admission and blocks at the physical action', async () => {
    const restricted = { decision: 'deny' as const, reason: 'restricted_all', retryable: false, canonicalContactId: 'dnd' }
    const h = harness({ permissions: { dnd: restricted } })
    const started = await h.service.startRun(command(['dnd', 'ok']))
    expect(started).toMatchObject({ admitted: 1, excluded: 1 })
    if (started.outcome === 'refused') throw new Error('refused')
    const members = await h.store.listMembers(started.runId)
    expect(members.find((member) => member.requestedContactId === 'dnd')?.exclusionReason).toBe('contact_restricted')

    // DND set after admission: the recheck right before the message blocks it.
    const late = harness()
    const run = await late.service.startRun(command(['c1']))
    if (run.outcome === 'refused') throw new Error('refused')
    late.contacts.check = async () => restricted
    await late.service.advance({ runId: run.runId, owner: 'w' })
    const [execution] = await late.store.listExecutions(run.runId)
    expect(execution).toMatchObject({ state: 'blocked', outcome: 'permission_denied' })
    expect(late.effectsFor('message')).toHaveLength(0)
  })

  it('permission is re-read before the call, and a voice restriction stops the call', async () => {
    const h = harness({ voiceDenied: new Set(['c1']) })
    const started = await h.service.startRun(command(['c1']))
    if (started.outcome === 'refused') throw new Error('refused')
    await runToEnd(h, started.runId)
    expect(h.permissionCalls.filter((call) => call === 'voice:c1')).toHaveLength(1)
    const [execution] = await h.store.listExecutions(started.runId)
    expect(execution).toMatchObject({ state: 'blocked', outcome: 'permission_denied' })
    expect(h.effectsFor('call')).toHaveLength(0)
  })

  it('project policy can only narrow: a message-only project never calls even when Contacts allows voice', async () => {
    const h = harness()
    const started = await h.service.startRun(command(['c1'], { projectKey: 'documents-reminder-v1' }))
    if (started.outcome === 'refused') throw new Error('refused')
    await runToEnd(h, started.runId)
    const [execution] = await h.store.listExecutions(started.runId)
    expect(execution).toMatchObject({ state: 'completed', outcome: 'no_reply' })
    expect(h.effectsFor('call')).toHaveLength(0)
    expect(h.permissionCalls.some((call) => call.startsWith('voice:'))).toBe(false)
  })

  it('cross-project suppression: a Contact active in one project is not admitted by another; after it ends, the cooldown applies', async () => {
    const h = harness()
    const churn = await h.service.startRun(command(['c1']))
    const documents = await h.service.startRun(command(['c1'], { projectKey: 'documents-reminder-v1', snapshotRef: 'docs-1' }))
    expect(documents).toMatchObject({ admitted: 0, excluded: 1 })
    if (documents.outcome === 'refused' || churn.outcome === 'refused') throw new Error('refused')
    expect((await h.store.listMembers(documents.runId))[0].exclusionReason).toBe('suppressed_active_elsewhere')
    await runToEnd(h, churn.runId)
    const cooling = await h.service.startRun(command(['c1'], { projectKey: 'documents-reminder-v1', snapshotRef: 'docs-2' }))
    if (cooling.outcome === 'refused') throw new Error('refused')
    expect((await h.store.listMembers(cooling.runId))[0].exclusionReason).toBe('cooldown')
    h.tick(61)
    const later = await h.service.startRun(command(['c1'], { projectKey: 'documents-reminder-v1', snapshotRef: 'docs-3' }))
    expect(later).toMatchObject({ admitted: 1 })
  })

  it('the sandbox allowlist is a hard boundary: others are excluded at admission and refused at the effect', async () => {
    const h = harness()
    const started = await h.service.startRun(command(['test-contact', 'stranger'], { sandbox: { allowlistContactIds: ['test-contact'] } }))
    expect(started).toMatchObject({ matched: 2, admitted: 1, excluded: 1 })
    if (started.outcome === 'refused') throw new Error('refused')
    expect((await h.store.listMembers(started.runId)).find((member) => member.requestedContactId === 'stranger')?.exclusionReason).toBe('sandbox_not_allowlisted')
    // Even a corrupted Run row naming a stranger is refused at the effects boundary.
    const effects = createSimulatedCommunicationEffectsV1(h.store, () => new Date())
    const result = await effects.message.send({ requestId: 'r', contactId: 'stranger', text: 't', run: { runId: started.runId, participantId: 'p', mode: 'sandbox', sandboxAllowlist: ['test-contact'], requestedContactId: 'stranger', simulated: null } })
    expect(result).toEqual({ kind: 'sandbox_blocked' })
    expect(h.effectsFor('message')).toHaveLength(0)
  })

  it('an unknown provider outcome is never treated as permission to repeat the effect', async () => {
    const h = harness()
    const started = await h.service.startRun(command(['c1'], { sandbox: { simulatedOutcomes: { c1: { message: 'indeterminate' } } } }))
    if (started.outcome === 'refused') throw new Error('refused')
    await runToEnd(h, started.runId)
    const [execution] = await h.store.listExecutions(started.runId)
    expect(execution).toMatchObject({ state: 'needs_review', outcome: 'outcome_unknown' })
    expect(h.effectsFor('message')).toHaveLength(1)
    expect((await h.service.report(started.runId))?.metrics.needsReview).toBe(1)

    const call = harness()
    const run = await call.service.startRun(command(['c1'], { sandbox: { simulatedOutcomes: { c1: { call: 'indeterminate' } } } }))
    if (run.outcome === 'refused') throw new Error('refused')
    await runToEnd(call, run.runId)
    expect((await call.store.listExecutions(run.runId))[0]).toMatchObject({ state: 'needs_review', outcome: 'outcome_unknown' })
    expect(call.effectsFor('call')).toHaveLength(1)
  })

  it('a temporary permission failure retries the same request later, a provider refusal ends the participant, history is kept', async () => {
    const h = harness()
    const started = await h.service.startRun(command(['c1']))
    if (started.outcome === 'refused') throw new Error('refused')
    const original = h.contacts.check
    let failures = 1
    h.contacts.check = async (id, cls) => (failures-- > 0 ? { decision: 'deny', reason: 'policy_unavailable', retryable: true, canonicalContactId: null } : original(id, cls))
    await h.service.advance({ runId: started.runId, owner: 'w' })
    expect((await h.store.listExecutions(started.runId))[0]).toMatchObject({ state: 'admitted', attempts: 1 })
    h.tick(61)
    await h.service.advance({ runId: started.runId, owner: 'w' })
    expect((await h.store.listExecutions(started.runId))[0].state).toBe('waiting_reply')
    expect(h.store.events.filter((item) => item.kind === 'permission_rechecked')).toHaveLength(1)

    const refused = harness()
    const run = await refused.service.startRun(command(['c1'], { sandbox: { simulatedOutcomes: { c1: { message: 'refused' } } } }))
    if (run.outcome === 'refused') throw new Error('refused')
    await runToEnd(refused, run.runId)
    expect((await refused.store.listExecutions(run.runId))[0]).toMatchObject({ state: 'completed', outcome: 'message_refused' })
  })

  it('two concurrent workers never perform the same step twice', async () => {
    const h = harness()
    const started = await h.service.startRun(command(['c1', 'c2', 'c3']))
    if (started.outcome === 'refused') throw new Error('refused')
    const a = h.rebuild()
    const b = h.rebuild()
    await Promise.all([a.advance({ runId: started.runId, owner: 'A' }), b.advance({ runId: started.runId, owner: 'B' })])
    h.tick(11)
    await Promise.all([a.advance({ runId: started.runId, owner: 'A' }), b.advance({ runId: started.runId, owner: 'B' })])
    expect(h.effectsFor('message')).toHaveLength(3)
    expect(h.effectsFor('call')).toHaveLength(3)
    expect(new Set(h.effectsFor('call').map((item) => item.detail.requestId)).size).toBe(3)
  })

  it('reporting and drill-down come from the same execution evidence', async () => {
    const restricted = { decision: 'deny' as const, reason: 'restricted_all', retryable: false, canonicalContactId: 'dnd' }
    const h = harness({ permissions: { dnd: restricted } })
    const started = await h.service.startRun(command(['dnd', 'reply', 'silent'], { sandbox: { allowlistContactIds: ['dnd', 'reply', 'silent'], simulatedOutcomes: { silent: { call: 'no_answer' } } } }))
    if (started.outcome === 'refused') throw new Error('refused')
    await h.service.advance({ runId: started.runId, owner: 'w' })
    const replying = (await h.store.listExecutions(started.runId)).find((execution) => execution.canonicalContactId === 'reply')!
    await h.service.simulateSandboxReply(replying.id, 'ok')
    await runToEnd(h, started.runId)
    const report = await h.service.report(started.runId)
    expect(report?.metrics).toMatchObject({ matched: 3, excluded: 1, admitted: 2, messagesRequested: 2, messagesAccepted: 2, replied: 1, callsRequested: 1, waiting: 0 })
    expect(report?.metrics.excludedReasons).toEqual({ contact_restricted: 1 })
    expect(report?.metrics.callOutcomes).toEqual({ no_answer: 1 })
    expect((await h.service.participants(started.runId, 'replied')).map((p) => p.requestedContactId)).toEqual(['reply'])
    expect((await h.service.participants(started.runId, 'call_requested')).map((p) => p.requestedContactId)).toEqual(['silent'])
    expect((await h.service.participants(started.runId, 'exclusion:contact_restricted')).map((p) => p.requestedContactId)).toEqual(['dnd'])
    expect((await h.service.participants(started.runId, 'outcome:call_no_answer')).map((p) => p.requestedContactId)).toEqual(['silent'])
  })

  it('a live Run is refused while effects are simulated, and a malformed command admits nobody', async () => {
    const h = harness()
    const live = { ...command(['c1']), mode: 'live', sandbox: null }
    expect(await h.service.startRun(live)).toMatchObject({ outcome: 'refused', reason: 'live_effects_disabled' })
    await expect(h.service.startRun({ ...command(['c1']), extra: true })).rejects.toThrow('COMMUNICATION_RUN_COMMAND_INVALID')
    expect(await h.store.findRunByIdempotencyKey('x')).toBeNull()
  })
})
