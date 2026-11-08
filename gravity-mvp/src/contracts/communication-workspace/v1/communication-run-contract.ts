/**
 * communication-workspace.StartCommunicationRunCommand.v1 and the Run read
 * models (report, participants, timeline).
 *
 * Sandbox is an execution MODE of the same core, not a separate product: the
 * same admission, Flow, policy, effects boundary, audit trail and reporting.
 * Its test configuration may only narrow and accelerate: an allowlist of test
 * Contacts (the effects boundary refuses everyone else), shorter waits and
 * cooldowns, and deterministic simulated provider outcomes.
 */
import { parseHostAudienceSubmissionV1, type HostAudienceSubmissionV1, type HostBusinessValueV1 } from './host-audience-contract'

export const START_COMMUNICATION_RUN_COMMAND_V1 = 'communication-workspace.StartCommunicationRunCommand.v1' as const
export const START_COMMUNICATION_RUN_RESULT_V1 = 'communication-workspace.StartCommunicationRunResult.v1' as const
export const COMMUNICATION_SANDBOX_ALLOWLIST_MAX_V1 = 20

export const COMMUNICATION_RUN_MODES_V1 = ['sandbox', 'live'] as const
export type CommunicationRunModeV1 = typeof COMMUNICATION_RUN_MODES_V1[number]

export const SIMULATED_MESSAGE_OUTCOMES_V1 = ['accepted', 'refused', 'indeterminate'] as const
export type SimulatedMessageOutcomeV1 = typeof SIMULATED_MESSAGE_OUTCOMES_V1[number]
export const SIMULATED_CALL_OUTCOMES_V1 = ['answered', 'no_answer', 'failed', 'indeterminate'] as const
export type SimulatedCallOutcomeV1 = typeof SIMULATED_CALL_OUTCOMES_V1[number]

export interface CommunicationSandboxConfigV1 {
  /** Test Contacts. The effects boundary refuses every other Contact. */
  allowlistContactIds: string[]
  /** Replaces every Flow wait (seconds); null keeps the Flow's waits. */
  waitSecondsOverride: number | null
  /** Replaces the project cooldown (seconds); null keeps the project's. */
  cooldownSecondsOverride: number | null
  /** Deterministic simulated provider outcomes per requested Contact id. */
  simulatedOutcomes: Record<string, { message?: SimulatedMessageOutcomeV1; call?: SimulatedCallOutcomeV1 }>
}

export interface StartCommunicationRunCommandV1 {
  contract: typeof START_COMMUNICATION_RUN_COMMAND_V1
  projectKey: string
  mode: CommunicationRunModeV1
  audience: HostAudienceSubmissionV1
  /** Required for sandbox, forbidden for live. */
  sandbox: CommunicationSandboxConfigV1 | null
  requestedBy: string
}

export type StartCommunicationRunResultV1 =
  | {
    contract: typeof START_COMMUNICATION_RUN_RESULT_V1
    outcome: 'started' | 'replayed'
    runId: string
    matched: number
    admitted: number
    excluded: number
  }
  | {
    contract: typeof START_COMMUNICATION_RUN_RESULT_V1
    outcome: 'refused'
    reason: 'project_unknown' | 'live_effects_disabled' | 'audience_empty'
  }

/** Why admission left a Contact out. Closed vocabulary. */
export const COMMUNICATION_EXCLUSION_REASONS_V1 = [
  'duplicate_in_snapshot',
  'duplicate_canonical_contact',
  'contact_unknown',
  'contact_archived',
  'contact_restricted',
  'permission_unavailable',
  'project_policy',
  'sandbox_not_allowlisted',
  'suppressed_active_elsewhere',
  'cooldown',
] as const
export type CommunicationExclusionReasonV1 = typeof COMMUNICATION_EXCLUSION_REASONS_V1[number]

export const COMMUNICATION_EXECUTION_STATES_V1 = ['admitted', 'waiting_reply', 'calling', 'completed', 'blocked', 'needs_review', 'failed'] as const
export type CommunicationExecutionStateV1 = typeof COMMUNICATION_EXECUTION_STATES_V1[number]

export const COMMUNICATION_OUTCOMES_V1 = [
  'replied',
  'no_reply',
  'call_answered',
  'call_no_answer',
  'call_failed',
  'call_unavailable',
  'call_not_allowed',
  'message_refused',
  'message_unavailable',
  'permission_denied',
  'sandbox_blocked',
  'outcome_unknown',
] as const
export type CommunicationOutcomeV1 = typeof COMMUNICATION_OUTCOMES_V1[number]

export interface CommunicationRunMetricsV1 {
  matched: number
  excluded: number
  excludedReasons: Partial<Record<CommunicationExclusionReasonV1, number>>
  admitted: number
  messagesRequested: number
  messagesAccepted: number
  /** Provider evidence only. null = no provider evidence exists for this Run. */
  messagesDelivered: number | null
  messagesRead: number | null
  replied: number
  waiting: number
  callsRequested: number
  callOutcomes: Partial<Record<'answered' | 'no_answer' | 'failed' | 'indeterminate' | 'unavailable', number>>
  failed: number
  needsReview: number
  completed: number
  inProgress: number
  outcomes: Partial<Record<CommunicationOutcomeV1, number>>
}

export interface CommunicationRunReportV1 {
  runId: string
  projectKey: string
  projectTitle: string
  mode: CommunicationRunModeV1
  hostModule: string
  triggerKey: string
  triggerVersion: number
  criteria: Record<string, HostBusinessValueV1>
  evaluatedAt: string
  createdAt: string
  effectsMode: 'simulated' | 'live'
  sandboxAllowlist: string[]
  flow: CommunicationFlowV1
  metrics: CommunicationRunMetricsV1
}

/** A drill-down key: a metric, or one exclusion reason / outcome. */
export type CommunicationMetricKeyV1 =
  | 'matched' | 'excluded' | 'admitted' | 'message_requested' | 'message_accepted' | 'replied'
  | 'waiting' | 'call_requested' | 'failed' | 'needs_review' | 'completed' | 'in_progress'
  | `exclusion:${CommunicationExclusionReasonV1}` | `outcome:${CommunicationOutcomeV1}`

export interface CommunicationRunParticipantV1 {
  audienceMemberId: string
  participantId: string | null
  requestedContactId: string
  canonicalContactId: string | null
  displayName: string | null
  reason: string
  sourceRef: string
  admission: 'admitted' | 'excluded'
  exclusionReason: CommunicationExclusionReasonV1 | null
  state: CommunicationExecutionStateV1 | null
  outcome: CommunicationOutcomeV1 | null
  messageOutcome: string | null
  callOutcome: string | null
  nextActionAt: string | null
}

export interface CommunicationTimelineEventV1 {
  kind: string
  occurredAt: string
  detail: Record<string, HostBusinessValueV1 | string[]>
}

export interface CommunicationParticipantTimelineV1 {
  runId: string
  participant: CommunicationRunParticipantV1
  businessContext: Record<string, HostBusinessValueV1>
  events: CommunicationTimelineEventV1[]
}

/** The Flow V1 shape: send, wait for a reply, then (optionally) call. */
export interface CommunicationFlowV1 {
  version: number
  message: { text: string }
  waitReplySeconds: number
  callIfNoReply: { purpose: string } | null
}

export class CommunicationRunContractErrorV1 extends Error {
  constructor(message: string) {
    super(`COMMUNICATION_RUN_COMMAND_INVALID: ${message}`)
    this.name = 'CommunicationRunContractErrorV1'
  }
}

function invalid(message: string): never {
  throw new CommunicationRunContractErrorV1(message)
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${field} must be an object`)
  return value as Record<string, unknown>
}

function text(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || value.length > maxLength || /[\u0000-\u001F\u007F]/u.test(value)) {
    invalid(`${field} must be a non-empty bounded string`)
  }
  return value
}

function seconds(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 30 * 86400) invalid(`${field} must be whole seconds between 0 and 30 days`)
  return value
}

function exact(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid(`${field}.${key} is not part of the contract`)
}

function parseSandbox(input: unknown): CommunicationSandboxConfigV1 {
  const value = record(input, 'sandbox')
  exact(value, ['allowlistContactIds', 'waitSecondsOverride', 'cooldownSecondsOverride', 'simulatedOutcomes'], 'sandbox')
  if (!Array.isArray(value.allowlistContactIds) || value.allowlistContactIds.length === 0 || value.allowlistContactIds.length > COMMUNICATION_SANDBOX_ALLOWLIST_MAX_V1) {
    invalid(`sandbox.allowlistContactIds must name 1 to ${COMMUNICATION_SANDBOX_ALLOWLIST_MAX_V1} test Contacts`)
  }
  const allowlist = [...new Set(value.allowlistContactIds.map((id, index) => text(id, `sandbox.allowlistContactIds[${index}]`, 255)))]
  const outcomes: CommunicationSandboxConfigV1['simulatedOutcomes'] = {}
  if (value.simulatedOutcomes !== undefined && value.simulatedOutcomes !== null) {
    for (const [contactId, raw] of Object.entries(record(value.simulatedOutcomes, 'sandbox.simulatedOutcomes'))) {
      const entry = record(raw, `sandbox.simulatedOutcomes.${contactId}`)
      exact(entry, ['message', 'call'], `sandbox.simulatedOutcomes.${contactId}`)
      const out: { message?: SimulatedMessageOutcomeV1; call?: SimulatedCallOutcomeV1 } = {}
      if (entry.message !== undefined) {
        if (!(SIMULATED_MESSAGE_OUTCOMES_V1 as readonly unknown[]).includes(entry.message)) invalid('unknown simulated message outcome')
        out.message = entry.message as SimulatedMessageOutcomeV1
      }
      if (entry.call !== undefined) {
        if (!(SIMULATED_CALL_OUTCOMES_V1 as readonly unknown[]).includes(entry.call)) invalid('unknown simulated call outcome')
        out.call = entry.call as SimulatedCallOutcomeV1
      }
      outcomes[text(contactId, 'sandbox.simulatedOutcomes key', 255)] = out
    }
  }
  return {
    allowlistContactIds: allowlist,
    waitSecondsOverride: seconds(value.waitSecondsOverride, 'sandbox.waitSecondsOverride'),
    cooldownSecondsOverride: seconds(value.cooldownSecondsOverride, 'sandbox.cooldownSecondsOverride'),
    simulatedOutcomes: outcomes,
  }
}

export function parseStartCommunicationRunCommandV1(input: unknown): StartCommunicationRunCommandV1 {
  const value = record(input, 'command')
  if (value.contract !== START_COMMUNICATION_RUN_COMMAND_V1) invalid(`contract must be ${START_COMMUNICATION_RUN_COMMAND_V1}`)
  exact(value, ['contract', 'projectKey', 'mode', 'audience', 'sandbox', 'requestedBy'], 'command')
  if (!(COMMUNICATION_RUN_MODES_V1 as readonly unknown[]).includes(value.mode)) invalid('mode must be sandbox or live')
  const mode = value.mode as CommunicationRunModeV1
  if (mode === 'sandbox' && (value.sandbox === null || value.sandbox === undefined)) invalid('a sandbox Run needs its test configuration')
  if (mode === 'live' && value.sandbox !== null && value.sandbox !== undefined) invalid('a live Run takes no sandbox configuration')
  return {
    contract: START_COMMUNICATION_RUN_COMMAND_V1,
    projectKey: text(value.projectKey, 'projectKey', 64),
    mode,
    audience: parseHostAudienceSubmissionV1(value.audience),
    sandbox: mode === 'sandbox' ? parseSandbox(value.sandbox) : null,
    requestedBy: text(value.requestedBy, 'requestedBy', 128),
  }
}
