/**
 * Manually started AI conversation (C4): one Contact, one durable Calling Call.
 *
 * Safety ordering, each step durable before the next:
 *   A  the runtime mode is read; anything but `simulated` refuses (no live provider exists here);
 *   B  the verified server-side principal is read (the browser's identity is never trusted);
 *   C  Contacts answers who this person is (ContactPersonCardQuery.v1): only a confirmed,
 *      non-archived person without a blocking conflict, through a current, undisputed phone;
 *   D  Contacts answers voice permission (ContactCommunicationPermissionQuery.v1, `voice`);
 *   E  the Call is created under a deterministic identity (contact + requestId) while a
 *      per-person durable lock refuses a second occupying conversation;
 *   F  immediately before the provider effect, voice permission is read AGAIN, fresh: an early
 *      allow never licenses a later originate;
 *   G  `dispatch_started` is committed BEFORE the provider is asked to originate, so a crash in
 *      between is read back as `outcome_unknown` and never re-originated;
 *   H  after the provider accepted, every lifecycle, transcript and outcome fact goes through
 *      Calling's existing Core (lifecycle journal, transcript journal, finalization), exactly as
 *      the Audio Bridge reports a real call, so duplicates, late and out-of-order events are
 *      handled once, by the Core.
 * Transcript and outcome are Calling's own records; nothing here writes Contacts or Fleet.
 */
import { createHash } from 'node:crypto'
import {
  AI_CONVERSATIONS_FOR_CONTACT_RESULT_V1,
  AI_CONVERSATION_LIST_LIMIT_V1,
  START_AI_CONVERSATION_RESULT_V1,
  isTerminalAiConversationStateV1,
  parseAiConversationsForContactQueryV1,
  parseStartAiConversationCommandV1,
  type AiConversationFailureCodeV1,
  type AiConversationOutcomeV1,
  type AiConversationRuntimeModeV1,
  type AiConversationSimulationVariantV1,
  type AiConversationStateV1,
  type AiConversationTranscriptLineV1,
  type AiConversationViewV1,
  type AiConversationsForContactResultV1,
  type StartAiConversationRefusalV1,
  type StartAiConversationResultV1,
} from '@/contracts/calling/v1/ai-conversation'
import type { ContactPersonCardResultV1, ContactPersonCardV1 } from '@/contracts/contacts/v1'
import type { ContactCommunicationPermissionResultV1 } from '@/contracts/contacts/v1'
import { assertProviderEffectTransition, type ProviderEffectPhase } from './ai-call-provider-effect-journal'

export const AI_CONVERSATION_METADATA_KEY = 'aiConversationV1' as const
/** A queued conversation that has not reached its provider effect by then is abandoned, never dialled late. */
export const AI_CONVERSATION_QUEUE_HORIZON_MS = 5 * 60_000
/** The pre-answer ceiling of one originate (the same 60 s as C3a's originate_timeout). */
export const AI_CONVERSATION_ORIGINATE_TIMEOUT_MS = 60_000
/** The answered cap of C1b. With the originate ceiling it bounds how long an unknown effect may still be live. */
export const AI_CONVERSATION_ANSWERED_CAP_MS = 600_000
export const AI_CONVERSATION_UNKNOWN_OCCUPANCY_MS = AI_CONVERSATION_ORIGINATE_TIMEOUT_MS + AI_CONVERSATION_ANSWERED_CAP_MS

const CALLABLE_E164 = /^\+[1-9][0-9]{7,14}$/u

export type AiConversationStep = 'queued' | 'dispatching' | 'connected' | 'terminal'

export interface AiConversationPermissionCheckV1 {
  phase: 'admission' | 'pre_originate'
  at: string
  decision: 'allow' | 'deny' | 'unavailable'
  reason: string
  policyVersion: number | null
}

/** Calling's durable record of one conversation, in Call.metadata[AI_CONVERSATION_METADATA_KEY]. */
export interface AiConversationRecordV1 {
  version: 1
  conversationId: string
  requestId: string
  requestFingerprint: string
  requestedContactId: string
  contactId: string
  initiation: 'manual'
  mode: 'simulated'
  variant: AiConversationSimulationVariantV1
  principalKind: string
  destination: string
  step: AiConversationStep
  effect: {
    phase: ProviderEffectPhase
    dispatchStartedAt: string | null
    observedAt: string | null
    providerReference: string | null
    providerReplyExcerpt: string | null
  }
  terminal: { state: AiConversationStateV1; failure: AiConversationFailureCodeV1 | null; at: string } | null
  permissionChecks: AiConversationPermissionCheckV1[]
  createdAt: string
  nextStepAt: string
  revision: number
}

/** What the Core and the Call row say about the conversation, read with the record. */
export interface AiConversationCallFactsV1 {
  callStatus: string
  aiSessionStatus: string | null
  lifecycleState: string | null
  startedAt: string
  answeredAt: string | null
  endedAt: string | null
  updatedAt: string
  aiOutcome: string | null
  aiSummary: string | null
  qualificationScore: number | null
  qualification: 'qualified' | 'not_qualified' | 'unclear' | null
  transcript: AiConversationTranscriptLineV1[]
}

export interface AiConversationSnapshotV1 {
  record: AiConversationRecordV1
  facts: AiConversationCallFactsV1
}

export type AiConversationClaimResult =
  | { kind: 'created'; snapshot: AiConversationSnapshotV1 }
  | { kind: 'existing'; snapshot: AiConversationSnapshotV1 }
  | { kind: 'busy'; activeConversationId: string }

export interface AiConversationStorePort {
  find(conversationId: string): Promise<AiConversationSnapshotV1 | null>
  /**
   * Atomically: under a per-Contact durable lock, refuse when `occupies` holds for any
   * conversation of this Contact; otherwise create the Call. The same conversationId twice
   * returns `existing` and creates nothing.
   */
  claim(record: AiConversationRecordV1, occupies: (snapshot: AiConversationSnapshotV1, now: Date) => boolean): Promise<AiConversationClaimResult>
  /** Compare-and-set on the record revision; null when another writer advanced it first. */
  transition(conversationId: string, expectedRevision: number, next: AiConversationRecordV1): Promise<AiConversationSnapshotV1 | null>
  listForContact(contactId: string, limit: number): Promise<AiConversationSnapshotV1[]>
}

export type AiConversationOriginateResult =
  | { kind: 'accepted'; providerReference: string }
  | { kind: 'rejected'; providerReplyExcerpt: string }

/**
 * The provider behind Calling's port. `originate` is the only physical effect. `progress`
 * lets a provider that has no callbacks of its own (the simulator) play its next event into
 * the Core; a real provider reports through the Audio Bridge callbacks instead and returns null.
 */
export interface AiConversationProviderPort {
  originate(input: { conversationId: string; destination: string; variant: AiConversationSimulationVariantV1 }): Promise<AiConversationOriginateResult>
  progress(snapshot: AiConversationSnapshotV1): Promise<{ nextInMs: number } | null>
}

export interface AiConversationDependencies {
  mode(): Promise<AiConversationRuntimeModeV1>
  principal(): Promise<{ kind: string } | null>
  readPerson(contactId: string): Promise<ContactPersonCardResultV1>
  voicePermission(contactId: string): Promise<ContactCommunicationPermissionResultV1>
  store: AiConversationStorePort
  provider: AiConversationProviderPort
  now(): Date
  /** Ask to be advanced again after `delayMs`. Best effort: reads also advance due conversations. */
  wake(conversationId: string, delayMs: number): void
}

export class AiConversationConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AiConversationConflictError'
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function aiConversationId(contactId: string, requestId: string): string {
  return `aiconv_${sha256(`calling.ai-conversation.v1\0${contactId}\0${requestId}`).slice(0, 32)}`
}

export function aiConversationRequestFingerprint(contactId: string, requestId: string, variant: AiConversationSimulationVariantV1): string {
  return sha256(`calling.ai-conversation.request.v1\0${contactId}\0${requestId}\0${variant}`)
}

export function maskAiConversationDestination(e164: string): string {
  const digits = e164.replace(/\D/gu, '')
  if (digits.length < 4) return '••••'
  return `+${'•'.repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`
}

/** Contacts' answer turned into Calling's admission decision. Exported for the tests. */
export function aiConversationPersonEligibility(card: ContactPersonCardV1):
  | { ok: true; destination: string }
  | { ok: false; reason: Extract<StartAiConversationRefusalV1, 'contact_not_found' | 'identity_unconfirmed' | 'identity_conflict' | 'no_callable_phone'> } {
  if (card.isArchived) return { ok: false, reason: 'contact_not_found' }
  const confirmation = card.personConfirmation.state
  if (card.hasPersonBlockingConflict || confirmation === 'contradiction' || confirmation === 'needs_reconciliation') {
    return { ok: false, reason: 'identity_conflict' }
  }
  if (confirmation !== 'confirmed') return { ok: false, reason: 'identity_unconfirmed' }
  const callable = card.phones
    .filter(phone => phone.isActive && phone.lifecycle === 'current'
      && (phone.resolutionState === 'unique' || phone.resolutionState === 'unknown')
      && CALLABLE_E164.test(phone.phone))
    .sort((left, right) => Number(right.isPrimary) - Number(left.isPrimary))
  if (callable.length === 0) return { ok: false, reason: 'no_callable_phone' }
  return { ok: true, destination: callable[0].phone }
}

type PermissionVerdict = { decision: 'allow' | 'deny' | 'unavailable'; reason: string; policyVersion: number | null; canonicalContactId: string | null }

async function readVoicePermission(deps: AiConversationDependencies, contactId: string): Promise<PermissionVerdict> {
  let answer: ContactCommunicationPermissionResultV1
  try {
    answer = await deps.voicePermission(contactId)
  } catch {
    return { decision: 'unavailable', reason: 'permission_query_failed', policyVersion: null, canonicalContactId: null }
  }
  if (answer?.decision === 'allow') {
    return { decision: 'allow', reason: answer.reason, policyVersion: answer.policyVersion, canonicalContactId: answer.canonicalContactId }
  }
  // Anything but an explicit allow is a deny: an unknown decision value never permits a call.
  return {
    decision: answer?.retryable === true ? 'unavailable' : 'deny',
    reason: typeof answer?.reason === 'string' ? answer.reason : 'unknown_decision',
    policyVersion: answer?.policyVersion ?? null,
    canonicalContactId: answer?.canonicalContactId ?? null,
  }
}

/** The provider-neutral state of one conversation, from Calling's record and the Core's facts. */
export function deriveAiConversationState(snapshot: AiConversationSnapshotV1): { state: AiConversationStateV1; failure: AiConversationFailureCodeV1 | null } {
  const { record, facts } = snapshot
  if (record.terminal) return { state: record.terminal.state, failure: record.terminal.failure }
  if (facts.endedAt !== null || facts.aiSessionStatus === 'ended' || facts.aiSessionStatus === 'failed' || facts.lifecycleState === 'ended' || facts.lifecycleState === 'failed') {
    if (facts.aiOutcome === 'dropped_mid_call' || facts.aiOutcome === 'dropped_no_input') return { state: 'interrupted', failure: 'interrupted' }
    if (facts.aiSessionStatus === 'failed' || facts.lifecycleState === 'failed') return { state: 'failed', failure: 'provider_failed' }
    return { state: 'completed', failure: null }
  }
  if (record.step === 'queued') return { state: 'queued', failure: null }
  if (record.step === 'dispatching') return { state: 'dialing', failure: null }
  if (facts.lifecycleState === 'greeting' || facts.lifecycleState === 'active' || facts.lifecycleState === 'transferring' || facts.answeredAt !== null) {
    return { state: 'in_conversation', failure: null }
  }
  return { state: 'ringing', failure: null }
}

function occupiedUntil(record: AiConversationRecordV1): string | null {
  if (record.terminal?.state !== 'outcome_unknown') return null
  const from = Date.parse(record.effect.dispatchStartedAt ?? record.createdAt)
  return new Date(from + AI_CONVERSATION_UNKNOWN_OCCUPANCY_MS).toISOString()
}

/**
 * Does this conversation still hold the person? Every non-terminal conversation does; an
 * `outcome_unknown` one does until a call it may have placed can no longer be live.
 */
export function aiConversationOccupies(snapshot: AiConversationSnapshotV1, now: Date): boolean {
  const { state } = deriveAiConversationState(snapshot)
  if (!isTerminalAiConversationStateV1(state)) return true
  const until = occupiedUntil(snapshot.record)
  return until !== null && Date.parse(until) > now.getTime()
}

export function aiConversationView(snapshot: AiConversationSnapshotV1): AiConversationViewV1 {
  const { record, facts } = snapshot
  const { state, failure } = deriveAiConversationState(snapshot)
  const outcome: AiConversationOutcomeV1 | null = facts.qualification === null && facts.aiOutcome === null
    ? null
    : {
      qualification: facts.qualification ?? 'unclear',
      summary: facts.aiSummary,
      score: facts.qualificationScore,
      classification: facts.aiOutcome,
    }
  return {
    conversationId: record.conversationId,
    contactId: record.contactId,
    initiation: 'manual',
    mode: record.mode,
    state,
    failure,
    destinationMasked: maskAiConversationDestination(record.destination),
    startedAt: facts.startedAt,
    answeredAt: facts.answeredAt,
    endedAt: facts.endedAt ?? record.terminal?.at ?? null,
    updatedAt: facts.updatedAt,
    occupiedUntil: occupiedUntil(record),
    transcript: facts.transcript,
    outcome,
  }
}

function refused(reason: StartAiConversationRefusalV1, retryable = false, activeConversationId: string | null = null): StartAiConversationResultV1 {
  return { contract: START_AI_CONVERSATION_RESULT_V1, status: 'refused', reason, retryable, activeConversationId }
}

function accepted(snapshot: AiConversationSnapshotV1, duplicate: boolean): StartAiConversationResultV1 {
  return { contract: START_AI_CONVERSATION_RESULT_V1, status: 'accepted', duplicate, conversation: aiConversationView(snapshot) }
}

function withRevision(record: AiConversationRecordV1, changes: Partial<AiConversationRecordV1>): AiConversationRecordV1 {
  return { ...record, ...changes, revision: record.revision + 1 }
}

function effectTo(record: AiConversationRecordV1, phase: ProviderEffectPhase, at: Date, observation: Partial<AiConversationRecordV1['effect']> = {}): AiConversationRecordV1['effect'] {
  assertProviderEffectTransition(record.effect.phase, phase)
  return {
    ...record.effect,
    ...observation,
    phase,
    dispatchStartedAt: phase === 'dispatch_started' ? at.toISOString() : record.effect.dispatchStartedAt,
    observedAt: ['accepted', 'rejected', 'outcome_unknown'].includes(phase) ? at.toISOString() : record.effect.observedAt,
  }
}

function permissionCheck(phase: AiConversationPermissionCheckV1['phase'], at: Date, verdict: PermissionVerdict): AiConversationPermissionCheckV1 {
  return { phase, at: at.toISOString(), decision: verdict.decision, reason: verdict.reason, policyVersion: verdict.policyVersion }
}

export function createAiConversationOperations(deps: AiConversationDependencies) {
  async function start(input: unknown): Promise<StartAiConversationResultV1> {
    if (await deps.mode() !== 'simulated') return refused('disabled')
    const principal = await deps.principal()
    if (principal === null) return refused('unauthenticated')
    const command = parseStartAiConversationCommandV1(input)
    const variant = command.simulationVariant ?? 'success'

    const conversationId = aiConversationId(command.contactId, command.requestId)
    const fingerprint = aiConversationRequestFingerprint(command.contactId, command.requestId, variant)
    const replay = await deps.store.find(conversationId)
    if (replay) {
      if (replay.record.requestFingerprint !== fingerprint) throw new AiConversationConflictError('requestId was reused for a different request')
      return accepted(replay, true)
    }

    let person = await deps.readPerson(command.contactId)
    if (person.status === 'redirected') person = await deps.readPerson(person.canonicalContactId)
    if (person.status === 'forbidden') return refused('unauthenticated')
    if (person.status === 'refused') return refused('identity_unconfirmed', true)
    if (person.status !== 'confirmed') return refused('contact_not_found')
    const card = person.card
    const eligibility = aiConversationPersonEligibility(card)
    if (!eligibility.ok) return refused(eligibility.reason)

    const now = deps.now()
    const admission = await readVoicePermission(deps, card.contactId)
    if (admission.decision === 'unavailable') return refused('voice_permission_unavailable', true)
    if (admission.decision === 'deny') return refused('voice_restricted')
    if (admission.canonicalContactId !== null && admission.canonicalContactId !== card.contactId) return refused('identity_conflict')

    const record: AiConversationRecordV1 = {
      version: 1,
      conversationId,
      requestId: command.requestId,
      requestFingerprint: fingerprint,
      requestedContactId: command.contactId,
      contactId: card.contactId,
      initiation: 'manual',
      mode: 'simulated',
      variant,
      principalKind: principal.kind,
      destination: eligibility.destination,
      step: 'queued',
      effect: { phase: 'prepared', dispatchStartedAt: null, observedAt: null, providerReference: null, providerReplyExcerpt: null },
      terminal: null,
      permissionChecks: [permissionCheck('admission', now, admission)],
      createdAt: now.toISOString(),
      nextStepAt: now.toISOString(),
      revision: 1,
    }
    const claim = await deps.store.claim(record, aiConversationOccupies)
    if (claim.kind === 'busy') return refused('busy', false, claim.activeConversationId)
    if (claim.kind === 'existing') {
      if (claim.snapshot.record.requestFingerprint !== fingerprint) throw new AiConversationConflictError('requestId was reused for a different request')
      return accepted(claim.snapshot, true)
    }
    deps.wake(conversationId, 0)
    return accepted(claim.snapshot, false)
  }

  /** One due step of one conversation. Safe to call from any number of drivers at once. */
  async function advance(conversationId: string): Promise<AiConversationSnapshotV1 | null> {
    const snapshot = await deps.store.find(conversationId)
    if (!snapshot) return null
    const { record } = snapshot
    const now = deps.now()
    if (isTerminalAiConversationStateV1(deriveAiConversationState(snapshot).state)) return snapshot
    if (Date.parse(record.nextStepAt) > now.getTime()) {
      deps.wake(conversationId, Date.parse(record.nextStepAt) - now.getTime())
      return snapshot
    }

    if (record.step === 'queued') {
      if (now.getTime() - Date.parse(record.createdAt) > AI_CONVERSATION_QUEUE_HORIZON_MS) {
        return deps.store.transition(conversationId, record.revision, withRevision(record, {
          step: 'terminal', terminal: { state: 'failed', failure: 'expired', at: now.toISOString() },
        }))
      }
      // F: fresh permission immediately before the only physical effect.
      const verdict = await readVoicePermission(deps, record.contactId)
      const checks = [...record.permissionChecks, permissionCheck('pre_originate', now, verdict)]
      if (verdict.decision !== 'allow' || (verdict.canonicalContactId !== null && verdict.canonicalContactId !== record.contactId)) {
        return deps.store.transition(conversationId, record.revision, withRevision(record, {
          step: 'terminal',
          permissionChecks: checks,
          terminal: {
            state: 'refused',
            failure: verdict.decision === 'unavailable' ? 'voice_permission_unavailable' : 'voice_restricted',
            at: now.toISOString(),
          },
        }))
      }
      // G: the point of no return is durable before the provider hears anything.
      const dispatching = withRevision(record, {
        step: 'dispatching', permissionChecks: checks, effect: effectTo(record, 'dispatch_started', now),
      })
      const claimed = await deps.store.transition(conversationId, record.revision, dispatching)
      if (claimed === null) return deps.store.find(conversationId)
      let outcome: AiConversationOriginateResult | 'unknown'
      try {
        outcome = await deps.provider.originate({ conversationId, destination: record.destination, variant: record.variant })
      } catch {
        outcome = 'unknown'
      }
      const observedAt = deps.now()
      if (outcome === 'unknown') {
        return deps.store.transition(conversationId, dispatching.revision, withRevision(dispatching, {
          step: 'terminal',
          effect: effectTo(dispatching, 'outcome_unknown', observedAt),
          terminal: { state: 'outcome_unknown', failure: 'outcome_unknown', at: observedAt.toISOString() },
        }))
      }
      if (outcome.kind === 'rejected') {
        return deps.store.transition(conversationId, dispatching.revision, withRevision(dispatching, {
          step: 'terminal',
          effect: effectTo(dispatching, 'rejected', observedAt, { providerReplyExcerpt: outcome.providerReplyExcerpt.slice(0, 120) }),
          terminal: { state: 'failed', failure: 'provider_rejected', at: observedAt.toISOString() },
        }))
      }
      const connected = await deps.store.transition(conversationId, dispatching.revision, withRevision(dispatching, {
        step: 'connected',
        effect: effectTo(dispatching, 'accepted', observedAt, { providerReference: outcome.providerReference }),
        nextStepAt: observedAt.toISOString(),
      }))
      if (connected) deps.wake(conversationId, 0)
      return connected
    }

    if (record.step === 'dispatching') {
      // Found mid-originate: either another driver is in it right now, or the process died
      // between G and the observation. Past the originate ceiling it is unknown, never retried.
      const since = Date.parse(record.effect.dispatchStartedAt ?? record.createdAt)
      if (now.getTime() - since <= AI_CONVERSATION_ORIGINATE_TIMEOUT_MS) {
        deps.wake(conversationId, AI_CONVERSATION_ORIGINATE_TIMEOUT_MS - (now.getTime() - since) + 1)
        return snapshot
      }
      return deps.store.transition(conversationId, record.revision, withRevision(record, {
        step: 'terminal',
        effect: effectTo(record, 'outcome_unknown', now),
        terminal: { state: 'outcome_unknown', failure: 'outcome_unknown', at: now.toISOString() },
      }))
    }

    // connected: the provider plays its next event into the Core.
    const next = await deps.provider.progress(snapshot)
    if (next === null) return deps.store.find(conversationId)
    const due = new Date(deps.now().getTime() + next.nextInMs)
    const scheduled = await deps.store.transition(conversationId, record.revision, withRevision(record, { nextStepAt: due.toISOString() }))
    if (scheduled) deps.wake(conversationId, next.nextInMs)
    return scheduled ?? deps.store.find(conversationId)
  }

  async function listForContact(input: unknown): Promise<AiConversationsForContactResultV1> {
    const query = parseAiConversationsForContactQueryV1(input)
    if (await deps.principal() === null) return { contract: AI_CONVERSATIONS_FOR_CONTACT_RESULT_V1, status: 'unauthenticated' }
    const mode = await deps.mode()
    let snapshots = await deps.store.listForContact(query.contactId, AI_CONVERSATION_LIST_LIMIT_V1)
    // Reads drive due work, so a restarted process resumes every conversation from its durable state.
    const now = deps.now()
    const due = snapshots.filter(snapshot => !isTerminalAiConversationStateV1(deriveAiConversationState(snapshot).state)
      && Date.parse(snapshot.record.nextStepAt) <= now.getTime())
    if (due.length > 0) {
      await Promise.all(due.map(snapshot => advance(snapshot.record.conversationId).catch(() => null)))
      snapshots = await deps.store.listForContact(query.contactId, AI_CONVERSATION_LIST_LIMIT_V1)
    }
    return {
      contract: AI_CONVERSATIONS_FOR_CONTACT_RESULT_V1,
      status: 'ok',
      mode,
      conversations: snapshots.map(aiConversationView),
    }
  }

  return { start, advance, listForContact }
}
