/**
 * Communication Workspace decisions, as pure functions: projects, admission,
 * suppression and the Flow V1 step machine. No store, clock, provider or
 * foreign module is touched here; the service feeds facts in and persists what
 * comes out, so every invariant is testable on its own.
 */
import type {
  CommunicationExclusionReasonV1,
  CommunicationExecutionStateV1,
  CommunicationFlowV1,
  CommunicationOutcomeV1,
  CommunicationRunModeV1,
} from '../../../contracts/communication-workspace/v1'

export interface CommunicationProjectPolicyV1 {
  /** Project policy may only narrow Contacts permission, never widen it. */
  allowMessage: boolean
  allowCall: boolean
  /** After a participation ends, the Contact rests this long in this scope. */
  cooldownSeconds: number
}

export interface CommunicationProjectDefinitionV1 {
  key: string
  title: string
  hostModule: string
  flow: CommunicationFlowV1
  policy: CommunicationProjectPolicyV1
}

/** The Отток reference project: write, wait for a reply, then call if none came. */
export const CHURN_RETURN_PROJECT_V1: CommunicationProjectDefinitionV1 = {
  key: 'churn-return-v1',
  title: 'Отток: вернуть водителя на линию',
  hostModule: 'churn',
  flow: {
    version: 1,
    message: { text: 'Здравствуйте! Давно не видели вас на линии. Подскажите, что мешает выйти на заказы? Мы поможем.' },
    waitReplySeconds: 6 * 3600,
    callIfNoReply: { purpose: 'churn_return' },
  },
  policy: { allowMessage: true, allowCall: true, cooldownSeconds: 7 * 86400 },
}

/** A second, message-only project, so cross-project suppression has a neighbour. */
export const DOCUMENTS_REMINDER_PROJECT_V1: CommunicationProjectDefinitionV1 = {
  key: 'documents-reminder-v1',
  title: 'Документы: напомнить о документах',
  hostModule: 'documents',
  flow: {
    version: 1,
    message: { text: 'Здравствуйте! Напоминаем: нужно обновить документы в парке.' },
    waitReplySeconds: 24 * 3600,
    callIfNoReply: null,
  },
  policy: { allowMessage: true, allowCall: false, cooldownSeconds: 3 * 86400 },
}

export const COMMUNICATION_PROJECTS_V1: readonly CommunicationProjectDefinitionV1[] = [CHURN_RETURN_PROJECT_V1, DOCUMENTS_REMINDER_PROJECT_V1]

export function communicationProjectDefinitionV1(key: string): CommunicationProjectDefinitionV1 | null {
  return COMMUNICATION_PROJECTS_V1.find((project) => project.key === key) ?? null
}

// ── Admission ───────────────────────────────────────────────────────────────

/** Contacts' answer for one requested Contact, as the permission port reports it. */
export type ContactPermissionFactV1 =
  | { decision: 'allow'; canonicalContactId: string }
  | { decision: 'deny'; reason: string; retryable: boolean; canonicalContactId: string | null }

export type AdmissionDecisionV1 =
  | { admission: 'admitted'; canonicalContactId: string }
  | { admission: 'excluded'; reason: CommunicationExclusionReasonV1; canonicalContactId: string | null }

/** Contacts' own reason, mapped onto the closed exclusion vocabulary (never re-derived). */
export function exclusionForPermissionDenialV1(reason: string, retryable: boolean): CommunicationExclusionReasonV1 {
  if (retryable) return 'permission_unavailable'
  if (reason === 'contact_unknown') return 'contact_unknown'
  if (reason === 'contact_archived') return 'contact_archived'
  return 'contact_restricted'
}

/**
 * One member's admission before the cross-project guard. Order matters and is
 * fixed: duplicates, the sandbox allowlist (a sandbox Run never reads anyone
 * else), Contacts permission (deny wins), the same person twice under two ids,
 * then project policy, which can only narrow.
 */
export function decideMemberAdmissionV1(input: {
  requestedContactId: string
  seenRequested: ReadonlySet<string>
  seenCanonical: ReadonlySet<string>
  mode: CommunicationRunModeV1
  sandboxAllowlist: readonly string[]
  permission: ContactPermissionFactV1 | null
  policy: CommunicationProjectPolicyV1
}): AdmissionDecisionV1 | { admission: 'needs_permission' } {
  if (input.seenRequested.has(input.requestedContactId)) {
    return { admission: 'excluded', reason: 'duplicate_in_snapshot', canonicalContactId: null }
  }
  if (input.mode === 'sandbox' && !input.sandboxAllowlist.includes(input.requestedContactId)) {
    return { admission: 'excluded', reason: 'sandbox_not_allowlisted', canonicalContactId: null }
  }
  if (!input.permission) return { admission: 'needs_permission' }
  if (input.permission.decision === 'deny') {
    return {
      admission: 'excluded',
      reason: exclusionForPermissionDenialV1(input.permission.reason, input.permission.retryable),
      canonicalContactId: input.permission.canonicalContactId,
    }
  }
  const canonicalContactId = input.permission.canonicalContactId
  if (input.seenCanonical.has(canonicalContactId)) {
    return { admission: 'excluded', reason: 'duplicate_canonical_contact', canonicalContactId }
  }
  if (!input.policy.allowMessage) return { admission: 'excluded', reason: 'project_policy', canonicalContactId }
  return { admission: 'admitted', canonicalContactId }
}

export interface ContactGuardFactV1 {
  activeParticipantId: string | null
  cooldownUntil: Date | null
}

/** Cross-project suppression: one active participation per Contact and scope, then its cooldown. */
export function decideGuardV1(guard: ContactGuardFactV1 | null, now: Date): 'free' | 'suppressed_active_elsewhere' | 'cooldown' {
  if (!guard) return 'free'
  if (guard.activeParticipantId) return 'suppressed_active_elsewhere'
  if (guard.cooldownUntil && guard.cooldownUntil.getTime() > now.getTime()) return 'cooldown'
  return 'free'
}

// ── Execution (Flow V1) ─────────────────────────────────────────────────────

export const TERMINAL_STATES_V1: ReadonlySet<CommunicationExecutionStateV1> = new Set(['completed', 'blocked', 'needs_review', 'failed'])
export const COMMUNICATION_MAX_ATTEMPTS_V1 = 3
export const COMMUNICATION_RETRY_SECONDS_V1 = 60

/** The deterministic, permanent effect request ids of one participant. */
export function messageRequestIdV1(participantId: string): string {
  return `cw-${participantId}-message-1`
}
export function callRequestIdV1(participantId: string): string {
  return `cw-${participantId}-call-1`
}

/** Waits come from the frozen Flow; a sandbox may only replace them by its own override. */
export function effectiveWaitSecondsV1(flow: CommunicationFlowV1, waitSecondsOverride: number | null): number {
  return waitSecondsOverride ?? flow.waitReplySeconds
}
export function effectiveCooldownSecondsV1(policy: CommunicationProjectPolicyV1, cooldownSecondsOverride: number | null): number {
  return cooldownSecondsOverride ?? policy.cooldownSeconds
}

export type MessageEffectResultV1 =
  | { kind: 'accepted'; deliveryState: string | null }
  | { kind: 'refused'; reason: string; retryable: boolean }
  | { kind: 'indeterminate' }
  | { kind: 'sandbox_blocked' }

export type CallEffectResultV1 =
  | { kind: 'answered' | 'no_answer' | 'failed' | 'unavailable' | 'indeterminate' }
  | { kind: 'sandbox_blocked' }

/** What a message attempt leaves behind. An unknown provider outcome is never resent. */
export function afterMessageEffectV1(result: MessageEffectResultV1, attempts: number): {
  state: CommunicationExecutionStateV1
  outcome: CommunicationOutcomeV1 | null
  messageOutcome: string
  retry: boolean
} {
  switch (result.kind) {
    case 'accepted':
      return { state: 'waiting_reply', outcome: null, messageOutcome: 'accepted', retry: false }
    case 'sandbox_blocked':
      return { state: 'blocked', outcome: 'sandbox_blocked', messageOutcome: 'sandbox_blocked', retry: false }
    case 'indeterminate':
      return { state: 'needs_review', outcome: 'outcome_unknown', messageOutcome: 'indeterminate', retry: false }
    case 'refused': {
      if (result.retryable && attempts + 1 < COMMUNICATION_MAX_ATTEMPTS_V1) {
        return { state: 'admitted', outcome: null, messageOutcome: `refused_retryable:${result.reason}`, retry: true }
      }
      if (result.retryable) return { state: 'failed', outcome: 'message_unavailable', messageOutcome: `refused:${result.reason}`, retry: false }
      const permission = result.reason.startsWith('restricted') || result.reason === 'contact_restricted' || result.reason === 'contact_archived' || result.reason === 'contact_unknown'
      return { state: permission ? 'blocked' : 'completed', outcome: permission ? 'permission_denied' : 'message_refused', messageOutcome: `refused:${result.reason}`, retry: false }
    }
  }
}

export function afterCallEffectV1(result: CallEffectResultV1): {
  state: CommunicationExecutionStateV1
  outcome: CommunicationOutcomeV1
  callOutcome: string
} {
  switch (result.kind) {
    case 'answered': return { state: 'completed', outcome: 'call_answered', callOutcome: 'answered' }
    case 'no_answer': return { state: 'completed', outcome: 'call_no_answer', callOutcome: 'no_answer' }
    case 'failed': return { state: 'completed', outcome: 'call_failed', callOutcome: 'failed' }
    case 'unavailable': return { state: 'completed', outcome: 'call_unavailable', callOutcome: 'unavailable' }
    case 'indeterminate': return { state: 'needs_review', outcome: 'outcome_unknown', callOutcome: 'indeterminate' }
    case 'sandbox_blocked': return { state: 'blocked', outcome: 'sandbox_blocked', callOutcome: 'sandbox_blocked' }
  }
}

/**
 * After the wait: a reply stops all further automatic contact; no reply moves
 * on to the call only when the Flow has one AND project policy allows it; an
 * unknown reply state never leads to a call.
 */
export function afterWaitV1(input: {
  replied: boolean | null
  due: boolean
  flow: CommunicationFlowV1
  policy: CommunicationProjectPolicyV1
}): { next: 'stay' } | { next: 'complete'; outcome: CommunicationOutcomeV1 } | { next: 'review'; outcome: CommunicationOutcomeV1 } | { next: 'call' } {
  if (input.replied === true) return { next: 'complete', outcome: 'replied' }
  if (!input.due) return { next: 'stay' }
  if (input.replied === null) return { next: 'review', outcome: 'outcome_unknown' }
  if (!input.flow.callIfNoReply) return { next: 'complete', outcome: 'no_reply' }
  if (!input.policy.allowCall) return { next: 'complete', outcome: 'call_not_allowed' }
  return { next: 'call' }
}
