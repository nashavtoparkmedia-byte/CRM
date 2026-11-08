/**
 * The Communication Workspace execution core. One service for every mode:
 * a sandbox Run and a live Run use the same admission, Flow step machine,
 * effects boundary, audit trail and reporting; only the effect ports bound
 * into the service and the Run's own test configuration differ.
 */
import { createHash } from 'node:crypto'
import {
  START_COMMUNICATION_RUN_RESULT_V1,
  parseStartCommunicationRunCommandV1,
  type CommunicationExclusionReasonV1,
  type CommunicationExecutionStateV1,
  type CommunicationFlowV1,
  type CommunicationMetricKeyV1,
  type CommunicationOutcomeV1,
  type CommunicationParticipantTimelineV1,
  type CommunicationRunModeV1,
  type CommunicationRunParticipantV1,
  type CommunicationRunReportV1,
  type CommunicationSandboxConfigV1,
  type HostBusinessValueV1,
  type StartCommunicationRunResultV1,
} from '../../../contracts/communication-workspace/v1'
import {
  COMMUNICATION_RETRY_SECONDS_V1,
  TERMINAL_STATES_V1,
  afterCallEffectV1,
  afterMessageEffectV1,
  afterWaitV1,
  callRequestIdV1,
  communicationProjectDefinitionV1,
  decideMemberAdmissionV1,
  effectiveCooldownSecondsV1,
  effectiveWaitSecondsV1,
  messageRequestIdV1,
  type CallEffectResultV1,
  type CommunicationProjectDefinitionV1,
  type CommunicationProjectPolicyV1,
  type ContactPermissionFactV1,
  type MessageEffectResultV1,
} from './communication-policy'
import { buildRunMetricsV1, memberMatchesMetricV1 } from './communication-report'

// ── Persistence rows (owner-local shapes) ──────────────────────────────────

export interface CommunicationRunRowV1 {
  id: string
  projectId: string
  projectKey: string
  projectTitle: string
  idempotencyKey: string
  mode: CommunicationRunModeV1
  hostModule: string
  triggerKey: string
  triggerVersion: number
  snapshotRef: string
  snapshotSha256: string
  criteria: Record<string, HostBusinessValueV1>
  flowVersion: number
  flow: CommunicationFlowV1
  policy: CommunicationProjectPolicyV1
  sandbox: CommunicationSandboxConfigV1 | null
  requestedBy: string
  evaluatedAt: Date
  createdAt: Date
}

export interface CommunicationMemberRowV1 {
  id: string
  runId: string
  requestedContactId: string
  canonicalContactId: string | null
  reason: string
  sourceRef: string
  businessContext: Record<string, HostBusinessValueV1>
  admission: 'admitted' | 'excluded'
  exclusionReason: CommunicationExclusionReasonV1 | null
}

export interface CommunicationExecutionRowV1 {
  id: string
  runId: string
  audienceMemberId: string
  canonicalContactId: string
  state: CommunicationExecutionStateV1
  nextActionAt: Date | null
  version: number
  attempts: number
  messageRequestId: string | null
  messageOutcome: string | null
  messageAcceptedAt: Date | null
  callRequestId: string | null
  callOutcome: string | null
  outcome: CommunicationOutcomeV1 | null
}

export interface CommunicationEventRowV1 {
  id: string
  runId: string
  participantId: string | null
  dedupeKey: string
  kind: string
  detail: Record<string, HostBusinessValueV1 | string[]>
  occurredAt: Date
}

export type CommunicationExecutionPatchV1 = Partial<Pick<CommunicationExecutionRowV1,
  'state' | 'nextActionAt' | 'attempts' | 'messageRequestId' | 'messageOutcome' | 'messageAcceptedAt' | 'callRequestId' | 'callOutcome' | 'outcome'>>

export interface CommunicationStorePortV1 {
  ensureProject(definition: CommunicationProjectDefinitionV1): Promise<{ id: string }>
  findRunByIdempotencyKey(idempotencyKey: string): Promise<CommunicationRunRowV1 | null>
  listRuns(limit: number): Promise<Array<Pick<CommunicationRunRowV1, 'id' | 'projectKey' | 'projectTitle' | 'mode' | 'triggerKey' | 'snapshotRef' | 'createdAt'>>>
  /**
   * One transaction: the Run, every audience member, and for each candidate in
   * order the cross-project guard (locked), then its execution or its
   * exclusion. A concurrent Run with the same idempotency key wins: created=false.
   */
  createRun(input: {
    run: Omit<CommunicationRunRowV1, 'projectKey' | 'projectTitle' | 'createdAt'>
    members: CommunicationMemberRowV1[]
    candidates: Array<{ memberId: string; participantId: string; canonicalContactId: string }>
    scope: CommunicationRunModeV1
    now: Date
  }): Promise<{ created: true; admitted: number; guardExcluded: number } | { created: false; existingRunId: string }>
  readRun(runId: string): Promise<CommunicationRunRowV1 | null>
  listMembers(runId: string): Promise<CommunicationMemberRowV1[]>
  listExecutions(runId: string): Promise<CommunicationExecutionRowV1[]>
  readExecution(participantId: string): Promise<CommunicationExecutionRowV1 | null>
  listEvents(runId: string, participantId?: string): Promise<CommunicationEventRowV1[]>
  /** Leases due, non-terminal executions (SKIP LOCKED); a lease that expired is taken over. */
  claimDue(input: { runId: string | null; now: Date; owner: string; leaseUntil: Date; limit: number }): Promise<CommunicationExecutionRowV1[]>
  /** Moves an execution only from the version it was read at, with its events, atomically. */
  transition(input: {
    id: string
    owner: string
    fromVersion: number
    patch: CommunicationExecutionPatchV1
    events: CommunicationEventRowV1[]
    releaseGuard: { scope: CommunicationRunModeV1; canonicalContactId: string; projectId: string; cooldownUntil: Date } | null
    /** The service clock: a lease is judged and released by the same time the step used. */
    now: Date
  }): Promise<boolean>
  /** Insert if the dedupe key is new; false when it already exists. */
  appendEvent(event: CommunicationEventRowV1): Promise<boolean>
  findEvent(dedupeKey: string): Promise<CommunicationEventRowV1 | null>
}

export interface ContactsPermissionPortV1 {
  check(contactId: string, communicationClass: 'message' | 'voice'): Promise<ContactPermissionFactV1>
}

export interface EffectRunContextV1 {
  runId: string
  participantId: string
  mode: CommunicationRunModeV1
  sandboxAllowlist: readonly string[]
  requestedContactId: string
  simulated: { message?: string; call?: string } | null
}

export interface MessageEffectPortV1 {
  send(input: { requestId: string; contactId: string; text: string; run: EffectRunContextV1 }): Promise<MessageEffectResultV1>
}
export interface CallEffectPortV1 {
  call(input: { requestId: string; contactId: string; purpose: string; run: EffectRunContextV1 }): Promise<CallEffectResultV1>
}
export interface ReplyEvidencePortV1 {
  /** true / false, or null when reply evidence cannot be established. */
  hasReplySince(input: { participantId: string; contactId: string; since: Date; run: EffectRunContextV1 }): Promise<boolean | null>
}

export interface CommunicationEffectsV1 {
  mode: 'simulated' | 'live'
  message: MessageEffectPortV1
  call: CallEffectPortV1
  reply: ReplyEvidencePortV1
}

export interface CommunicationServiceDependenciesV1 {
  store: CommunicationStorePortV1
  contacts: ContactsPermissionPortV1
  effects: CommunicationEffectsV1
  clock: () => Date
  newId: () => string
}

const LEASE_SECONDS = 30
const MAX_STEPS_PER_CLAIM = 4

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function snapshotSha256V1(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000)
}

/** Ids allowed through the sandbox effects boundary: the requested and the canonical Contact. */
export function sandboxPermitsV1(run: Pick<CommunicationRunRowV1, 'mode' | 'sandbox'>, requestedContactId: string, canonicalContactId: string): boolean {
  if (run.mode !== 'sandbox') return true
  const allowlist = run.sandbox?.allowlistContactIds ?? []
  return allowlist.includes(requestedContactId) || allowlist.includes(canonicalContactId)
}

export function createCommunicationServiceV1(deps: CommunicationServiceDependenciesV1) {
  const { store, contacts, effects, clock, newId } = deps

  function event(runId: string, participantId: string | null, dedupeKey: string, kind: string, detail: CommunicationEventRowV1['detail'], at: Date): CommunicationEventRowV1 {
    return { id: newId(), runId, participantId, dedupeKey, kind, detail, occurredAt: at }
  }

  function effectContext(run: CommunicationRunRowV1, member: CommunicationMemberRowV1, participantId: string): EffectRunContextV1 {
    return {
      runId: run.id,
      participantId,
      mode: run.mode,
      sandboxAllowlist: run.sandbox?.allowlistContactIds ?? [],
      requestedContactId: member.requestedContactId,
      simulated: run.sandbox?.simulatedOutcomes[member.requestedContactId] ?? null,
    }
  }

  async function startRun(input: unknown): Promise<StartCommunicationRunResultV1> {
    const command = parseStartCommunicationRunCommandV1(input)
    const project = communicationProjectDefinitionV1(command.projectKey)
    if (!project) return { contract: START_COMMUNICATION_RUN_RESULT_V1, outcome: 'refused', reason: 'project_unknown' }
    if (command.mode === 'live' && effects.mode !== 'live') {
      return { contract: START_COMMUNICATION_RUN_RESULT_V1, outcome: 'refused', reason: 'live_effects_disabled' }
    }
    if (command.audience.members.length === 0) return { contract: START_COMMUNICATION_RUN_RESULT_V1, outcome: 'refused', reason: 'audience_empty' }

    const audience = command.audience
    const idempotencyKey = [project.key, command.mode, audience.hostModule, audience.triggerKey, `v${audience.triggerVersion}`, audience.snapshotRef].join('|')
    const replay = async (runId: string): Promise<StartCommunicationRunResultV1> => {
      const members = await store.listMembers(runId)
      const admitted = members.filter((member) => member.admission === 'admitted').length
      return { contract: START_COMMUNICATION_RUN_RESULT_V1, outcome: 'replayed', runId, matched: members.length, admitted, excluded: members.length - admitted }
    }
    const existing = await store.findRunByIdempotencyKey(idempotencyKey)
    if (existing) return replay(existing.id)

    const { id: projectId } = await store.ensureProject(project)
    const now = clock()
    const runId = newId()
    const allowlist = command.sandbox?.allowlistContactIds ?? []
    const seenRequested = new Set<string>()
    const seenCanonical = new Set<string>()
    const members: CommunicationMemberRowV1[] = []
    const candidates: Array<{ memberId: string; participantId: string; canonicalContactId: string }> = []
    for (const member of audience.members) {
      const base = { seenRequested, seenCanonical, mode: command.mode, sandboxAllowlist: allowlist, policy: project.policy, requestedContactId: member.contactId }
      let decision = decideMemberAdmissionV1({ ...base, permission: null })
      if (decision.admission === 'needs_permission') {
        let permission: ContactPermissionFactV1
        try {
          permission = await contacts.check(member.contactId, 'message')
        } catch {
          permission = { decision: 'deny', reason: 'policy_unavailable', retryable: true, canonicalContactId: null }
        }
        decision = decideMemberAdmissionV1({ ...base, permission })
      }
      if (decision.admission === 'needs_permission') throw new Error('COMMUNICATION_ADMISSION_UNDECIDED')
      seenRequested.add(member.contactId)
      const memberId = newId()
      if (decision.admission === 'admitted') {
        seenCanonical.add(decision.canonicalContactId)
        candidates.push({ memberId, participantId: newId(), canonicalContactId: decision.canonicalContactId })
      }
      members.push({
        id: memberId,
        runId,
        requestedContactId: member.contactId,
        canonicalContactId: decision.canonicalContactId,
        reason: member.reason,
        sourceRef: member.sourceRef,
        businessContext: member.businessContext,
        admission: decision.admission,
        exclusionReason: decision.admission === 'excluded' ? decision.reason : null,
      })
    }
    const created = await store.createRun({
      run: {
        id: runId,
        projectId,
        idempotencyKey,
        mode: command.mode,
        hostModule: audience.hostModule,
        triggerKey: audience.triggerKey,
        triggerVersion: audience.triggerVersion,
        snapshotRef: audience.snapshotRef,
        snapshotSha256: snapshotSha256V1(audience),
        criteria: audience.criteria,
        flowVersion: project.flow.version,
        flow: project.flow,
        policy: project.policy,
        sandbox: command.sandbox,
        requestedBy: command.requestedBy,
        evaluatedAt: new Date(audience.evaluatedAt),
      },
      members,
      candidates,
      scope: command.mode,
      now,
    })
    if (!created.created) return replay(created.existingRunId)
    return {
      contract: START_COMMUNICATION_RUN_RESULT_V1,
      outcome: 'started',
      runId,
      matched: members.length,
      admitted: created.admitted,
      excluded: members.length - created.admitted,
    }
  }

  async function transition(
    run: CommunicationRunRowV1,
    execution: CommunicationExecutionRowV1,
    owner: string,
    patch: CommunicationExecutionPatchV1,
    events: CommunicationEventRowV1[],
    now: Date,
  ): Promise<CommunicationExecutionRowV1 | null> {
    const terminal = patch.state !== undefined && TERMINAL_STATES_V1.has(patch.state)
    const cooldownSeconds = effectiveCooldownSecondsV1(run.policy, run.sandbox?.cooldownSecondsOverride ?? null)
    const moved = await store.transition({
      id: execution.id,
      owner,
      fromVersion: execution.version,
      patch: terminal ? { ...patch, nextActionAt: null } : patch,
      events,
      releaseGuard: terminal
        ? { scope: run.mode, canonicalContactId: execution.canonicalContactId, projectId: run.projectId, cooldownUntil: addSeconds(now, cooldownSeconds) }
        : null,
      now,
    })
    if (!moved) return null
    return { ...execution, ...(terminal ? { ...patch, nextActionAt: null } : patch), version: execution.version + 1 }
  }

  /** One step of one leased execution. Returns the moved execution, or null when nothing moved. */
  async function step(run: CommunicationRunRowV1, member: CommunicationMemberRowV1, execution: CommunicationExecutionRowV1, owner: string): Promise<CommunicationExecutionRowV1 | null> {
    const now = clock()
    const context = effectContext(run, member, execution.id)
    const pid = execution.id
    const at = (kind: string, detail: CommunicationEventRowV1['detail'] = {}, key = `${pid}:${execution.version}:${kind}`) => event(run.id, pid, key, kind, detail, now)

    if (execution.state === 'admitted') {
      // Permission is read again right before the physical action.
      let permission: ContactPermissionFactV1
      try {
        permission = await contacts.check(execution.canonicalContactId, 'message')
      } catch {
        permission = { decision: 'deny', reason: 'policy_unavailable', retryable: true, canonicalContactId: null }
      }
      if (permission.decision === 'deny') {
        const result = afterMessageEffectV1({ kind: 'refused', reason: permission.reason, retryable: permission.retryable }, execution.attempts)
        return transition(run, execution, owner, {
          state: result.state,
          outcome: result.outcome,
          attempts: execution.attempts + 1,
          ...(result.retry ? { nextActionAt: addSeconds(now, COMMUNICATION_RETRY_SECONDS_V1) } : {}),
        }, [at('permission_rechecked', { decision: 'deny', reason: permission.reason, retryable: permission.retryable, communicationClass: 'message' })], now)
      }
      const requestId = messageRequestIdV1(pid)
      if (!sandboxPermitsV1(run, member.requestedContactId, execution.canonicalContactId)) {
        return transition(run, execution, owner, { state: 'blocked', outcome: 'sandbox_blocked', messageOutcome: 'sandbox_blocked' },
          [at('sandbox_blocked', { step: 'message', note: 'Contact is not in the sandbox allowlist; no effect was requested' })], now)
      }
      await store.appendEvent(event(run.id, pid, `${pid}:message_requested`, 'message_requested', { requestId, channelPolicy: 'existing conversation via SendToContact' }, now))
      let result: MessageEffectResultV1
      try {
        result = await effects.message.send({ requestId, contactId: execution.canonicalContactId, text: run.flow.message.text, run: context })
      } catch {
        result = { kind: 'indeterminate' }
      }
      const after = afterMessageEffectV1(result, execution.attempts)
      const waitSeconds = effectiveWaitSecondsV1(run.flow, run.sandbox?.waitSecondsOverride ?? null)
      const events = [at(`message_${result.kind}`, {
        requestId,
        ...(result.kind === 'accepted' ? { deliveryState: result.deliveryState } : {}),
        ...(result.kind === 'refused' ? { reason: result.reason, retryable: result.retryable } : {}),
        ...(result.kind === 'indeterminate' ? { note: 'Provider outcome unknown; it is never resent automatically' } : {}),
      })]
      if (after.state === 'waiting_reply') events.push(at('wait_started', { waitSeconds, until: addSeconds(now, waitSeconds).toISOString() }))
      return transition(run, execution, owner, {
        state: after.state,
        outcome: after.outcome,
        messageRequestId: requestId,
        messageOutcome: after.messageOutcome,
        attempts: execution.attempts + 1,
        ...(after.state === 'waiting_reply' ? { messageAcceptedAt: now, nextActionAt: addSeconds(now, waitSeconds) } : {}),
        ...(after.retry ? { nextActionAt: addSeconds(now, COMMUNICATION_RETRY_SECONDS_V1) } : {}),
      }, events, now)
    }

    if (execution.state === 'waiting_reply' || execution.state === 'calling') {
      const since = execution.messageAcceptedAt ?? now
      let replied: boolean | null
      try {
        replied = await effects.reply.hasReplySince({ participantId: pid, contactId: execution.canonicalContactId, since, run: context })
      } catch {
        replied = null
      }
      if (execution.state === 'waiting_reply') {
        const due = !execution.nextActionAt || execution.nextActionAt.getTime() <= now.getTime()
        const decision = afterWaitV1({ replied, due, flow: run.flow, policy: run.policy })
        if (decision.next === 'stay') return null
        if (decision.next === 'complete' || decision.next === 'review') {
          const kind = decision.outcome === 'replied' ? 'reply_detected' : decision.outcome === 'outcome_unknown' ? 'reply_evidence_unavailable' : 'wait_elapsed'
          return transition(run, execution, owner, { state: decision.next === 'complete' ? 'completed' : 'needs_review', outcome: decision.outcome },
            [at(kind, { replied: replied === null ? 'unknown' : replied, outcome: decision.outcome })], now)
        }
        return transition(run, execution, owner, { state: 'calling', nextActionAt: now }, [at('wait_elapsed', { replied: false, next: 'call' })], now)
      }
      // calling: a reply that arrived meanwhile stops the call before it is requested.
      if (replied === true) {
        return transition(run, execution, owner, { state: 'completed', outcome: 'replied' }, [at('reply_detected', { replied: true, note: 'The call was not requested' })], now)
      }
      if (replied === null) {
        return transition(run, execution, owner, { state: 'needs_review', outcome: 'outcome_unknown' }, [at('reply_evidence_unavailable', { note: 'No call without reply evidence' })], now)
      }
      let permission: ContactPermissionFactV1
      try {
        permission = await contacts.check(execution.canonicalContactId, 'voice')
      } catch {
        permission = { decision: 'deny', reason: 'policy_unavailable', retryable: true, canonicalContactId: null }
      }
      if (permission.decision === 'deny') {
        return transition(run, execution, owner, { state: permission.retryable ? 'failed' : 'blocked', outcome: 'permission_denied' },
          [at('permission_rechecked', { decision: 'deny', reason: permission.reason, retryable: permission.retryable, communicationClass: 'voice' })], now)
      }
      if (!sandboxPermitsV1(run, member.requestedContactId, execution.canonicalContactId)) {
        return transition(run, execution, owner, { state: 'blocked', outcome: 'sandbox_blocked', callOutcome: 'sandbox_blocked' },
          [at('sandbox_blocked', { step: 'call', note: 'Contact is not in the sandbox allowlist; no effect was requested' })], now)
      }
      const requestId = callRequestIdV1(pid)
      const purpose = run.flow.callIfNoReply?.purpose ?? 'none'
      await store.appendEvent(event(run.id, pid, `${pid}:call_requested`, 'call_requested', { requestId, purpose }, now))
      let result: CallEffectResultV1
      try {
        result = await effects.call.call({ requestId, contactId: execution.canonicalContactId, purpose, run: context })
      } catch {
        result = { kind: 'indeterminate' }
      }
      const after = afterCallEffectV1(result)
      return transition(run, execution, owner, { state: after.state, outcome: after.outcome, callRequestId: requestId, callOutcome: after.callOutcome },
        [at(`call_${result.kind}`, { requestId, ...(result.kind === 'indeterminate' ? { note: 'Call outcome unknown; it is never redialled automatically' } : {}) })], now)
    }
    return null
  }

  async function advance(input: { runId?: string | null; owner: string; limit?: number }): Promise<{ claimed: number; moved: number }> {
    const now = clock()
    const claimed = await store.claimDue({ runId: input.runId ?? null, now, owner: input.owner, leaseUntil: addSeconds(now, LEASE_SECONDS), limit: input.limit ?? 50 })
    let moved = 0
    const runs = new Map<string, CommunicationRunRowV1>()
    const membersByRun = new Map<string, Map<string, CommunicationMemberRowV1>>()
    for (const claim of claimed) {
      let run = runs.get(claim.runId)
      if (!run) {
        const loaded = await store.readRun(claim.runId)
        if (!loaded) continue
        run = loaded
        runs.set(run.id, run)
        membersByRun.set(run.id, new Map((await store.listMembers(run.id)).map((member) => [member.id, member])))
      }
      const member = membersByRun.get(run.id)?.get(claim.audienceMemberId)
      if (!member) continue
      let current: CommunicationExecutionRowV1 | null = claim
      for (let index = 0; current && index < MAX_STEPS_PER_CLAIM && !TERMINAL_STATES_V1.has(current.state); index += 1) {
        const next = await step(run, member, current, input.owner)
        if (!next) break
        moved += 1
        const stillDue = !next.nextActionAt || next.nextActionAt.getTime() <= clock().getTime()
        current = stillDue ? next : null
      }
    }
    return { claimed: claimed.length, moved }
  }

  /** Waiting executions whose reply already arrived are stopped without waiting for their due time. */
  async function detectReplies(input: { runId: string; owner: string }): Promise<number> {
    const run = await store.readRun(input.runId)
    if (!run) return 0
    const members = new Map((await store.listMembers(run.id)).map((member) => [member.id, member]))
    let stopped = 0
    for (const execution of await store.listExecutions(run.id)) {
      if (execution.state !== 'waiting_reply') continue
      const member = members.get(execution.audienceMemberId)
      if (!member) continue
      const replied = await effects.reply.hasReplySince({
        participantId: execution.id,
        contactId: execution.canonicalContactId,
        since: execution.messageAcceptedAt ?? run.createdAt,
        run: effectContext(run, member, execution.id),
      }).catch(() => null)
      if (replied !== true) continue
      const moved = await transition(run, execution, input.owner, { state: 'completed', outcome: 'replied' },
        [event(run.id, execution.id, `${execution.id}:${execution.version}:reply_detected`, 'reply_detected', { replied: true, note: 'Stopped before the wait elapsed' }, clock())], clock())
      if (moved) stopped += 1
    }
    return stopped
  }

  async function simulateSandboxReply(participantId: string, text: string): Promise<{ ok: boolean; reason?: string }> {
    if (effects.mode !== 'simulated') return { ok: false, reason: 'live_effects_reply_is_real' }
    const execution = await store.readExecution(participantId)
    if (!execution) return { ok: false, reason: 'participant_unknown' }
    const run = await store.readRun(execution.runId)
    if (!run || run.mode !== 'sandbox') return { ok: false, reason: 'not_a_sandbox_run' }
    await store.appendEvent(event(run.id, participantId, `sim-reply:${participantId}`, 'sandbox_reply_simulated', { text: text.slice(0, 200) }, clock()))
    return { ok: true }
  }

  async function report(runId: string): Promise<CommunicationRunReportV1 | null> {
    const run = await store.readRun(runId)
    if (!run) return null
    const [members, executions, events] = await Promise.all([store.listMembers(runId), store.listExecutions(runId), store.listEvents(runId)])
    return {
      runId: run.id,
      projectKey: run.projectKey,
      projectTitle: run.projectTitle,
      mode: run.mode,
      hostModule: run.hostModule,
      triggerKey: run.triggerKey,
      triggerVersion: run.triggerVersion,
      criteria: run.criteria,
      evaluatedAt: run.evaluatedAt.toISOString(),
      createdAt: run.createdAt.toISOString(),
      effectsMode: effects.mode,
      sandboxAllowlist: run.sandbox?.allowlistContactIds ?? [],
      flow: run.flow,
      metrics: buildRunMetricsV1(members, executions, events),
    }
  }

  function participantView(member: CommunicationMemberRowV1, execution: CommunicationExecutionRowV1 | undefined): CommunicationRunParticipantV1 {
    const name = member.businessContext.displayName
    return {
      audienceMemberId: member.id,
      participantId: execution?.id ?? null,
      requestedContactId: member.requestedContactId,
      canonicalContactId: member.canonicalContactId,
      displayName: typeof name === 'string' ? name : null,
      reason: member.reason,
      sourceRef: member.sourceRef,
      admission: member.admission,
      exclusionReason: member.exclusionReason,
      state: execution?.state ?? null,
      outcome: execution?.outcome ?? null,
      messageOutcome: execution?.messageOutcome ?? null,
      callOutcome: execution?.callOutcome ?? null,
      nextActionAt: execution?.nextActionAt?.toISOString() ?? null,
    }
  }

  async function participants(runId: string, metric: CommunicationMetricKeyV1): Promise<CommunicationRunParticipantV1[]> {
    const [members, executions, events] = await Promise.all([store.listMembers(runId), store.listExecutions(runId), store.listEvents(runId)])
    const byMember = new Map(executions.map((execution) => [execution.audienceMemberId, execution]))
    return members
      .filter((member) => memberMatchesMetricV1(metric, member, byMember.get(member.id), events))
      .map((member) => participantView(member, byMember.get(member.id)))
  }

  async function timeline(runId: string, audienceMemberId: string): Promise<CommunicationParticipantTimelineV1 | null> {
    const members = await store.listMembers(runId)
    const member = members.find((candidate) => candidate.id === audienceMemberId)
    if (!member) return null
    const execution = (await store.listExecutions(runId)).find((candidate) => candidate.audienceMemberId === member.id)
    const runEvents = await store.listEvents(runId)
    const own = runEvents.filter((item) => item.detail.audienceMemberId === member.id || (execution !== undefined && item.participantId === execution.id))
    return {
      runId,
      participant: participantView(member, execution),
      businessContext: member.businessContext,
      // The store returns the audit trail in insertion order (seq); it is shown exactly so.
      events: own.map((item) => ({ kind: item.kind, occurredAt: item.occurredAt.toISOString(), detail: item.detail })),
    }
  }

  async function runs(limit = 20) {
    return (await store.listRuns(limit)).map((run) => ({ ...run, createdAt: run.createdAt.toISOString() }))
  }

  return { startRun, advance, detectReplies, simulateSandboxReply, report, participants, timeline, runs, effectsMode: effects.mode }
}

export type CommunicationServiceV1 = ReturnType<typeof createCommunicationServiceV1>
