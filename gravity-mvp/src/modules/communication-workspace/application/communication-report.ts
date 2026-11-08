/**
 * Run reporting, derived ONLY from the Run's own authoritative execution
 * evidence (audience snapshot, executions, audit events). There is no second
 * analytics store; every number drills down to the same rows.
 */
import type {
  CommunicationMetricKeyV1,
  CommunicationRunMetricsV1,
} from '../../../contracts/communication-workspace/v1'

interface MemberFacts {
  id: string
  admission: 'admitted' | 'excluded'
  exclusionReason: string | null
}
interface ExecutionFacts {
  id: string
  audienceMemberId: string
  state: string
  outcome: string | null
  messageOutcome: string | null
  callOutcome: string | null
}
interface EventFacts {
  participantId: string | null
  kind: string
  detail: Record<string, unknown>
}

const IN_PROGRESS = new Set(['admitted', 'waiting_reply', 'calling'])
const CALL_OUTCOMES = ['answered', 'no_answer', 'failed', 'indeterminate', 'unavailable'] as const

function participantsWith(events: readonly EventFacts[], kind: string): Set<string> {
  return new Set(events.filter((item) => item.kind === kind && item.participantId).map((item) => item.participantId as string))
}

function tally<T extends string>(values: Array<T | null | undefined>): Partial<Record<T, number>> {
  const out: Partial<Record<T, number>> = {}
  for (const value of values) if (value) out[value] = (out[value] ?? 0) + 1
  return out
}

export function buildRunMetricsV1(
  members: readonly MemberFacts[],
  executions: readonly ExecutionFacts[],
  events: readonly EventFacts[],
): CommunicationRunMetricsV1 {
  const excluded = members.filter((member) => member.admission === 'excluded')
  const requested = participantsWith(events, 'message_requested')
  const callsRequested = participantsWith(events, 'call_requested')
  // Delivered / read exist only where a provider proved them; otherwise null, never 0.
  const deliveryStates = events.filter((item) => item.kind === 'message_accepted').map((item) => item.detail.deliveryState)
  const proven = deliveryStates.filter((state) => state === 'delivered' || state === 'read')
  return {
    matched: members.length,
    excluded: excluded.length,
    excludedReasons: tally(excluded.map((member) => member.exclusionReason as never)),
    admitted: executions.length,
    messagesRequested: requested.size,
    messagesAccepted: executions.filter((execution) => execution.messageOutcome === 'accepted').length,
    messagesDelivered: proven.length > 0 ? proven.length : null,
    messagesRead: deliveryStates.includes('read') ? deliveryStates.filter((state) => state === 'read').length : null,
    replied: executions.filter((execution) => execution.outcome === 'replied').length,
    waiting: executions.filter((execution) => execution.state === 'waiting_reply').length,
    callsRequested: callsRequested.size,
    callOutcomes: tally(executions.map((execution) => (CALL_OUTCOMES as readonly string[]).includes(execution.callOutcome ?? '') ? execution.callOutcome as typeof CALL_OUTCOMES[number] : null)),
    failed: executions.filter((execution) => execution.state === 'failed').length,
    needsReview: executions.filter((execution) => execution.state === 'needs_review').length,
    completed: executions.filter((execution) => execution.state === 'completed' || execution.state === 'blocked').length,
    inProgress: executions.filter((execution) => IN_PROGRESS.has(execution.state)).length,
    outcomes: tally(executions.map((execution) => execution.outcome as never)),
  }
}

/** The drill-down predicate behind every metric: Metric → Contacts. */
export function memberMatchesMetricV1(
  metric: CommunicationMetricKeyV1,
  member: MemberFacts,
  execution: ExecutionFacts | undefined,
  events: readonly EventFacts[],
): boolean {
  if (metric.startsWith('exclusion:')) return member.exclusionReason === metric.slice('exclusion:'.length)
  if (metric.startsWith('outcome:')) return execution?.outcome === metric.slice('outcome:'.length)
  switch (metric) {
    case 'matched': return true
    case 'excluded': return member.admission === 'excluded'
    case 'admitted': return execution !== undefined
    case 'message_requested': return execution !== undefined && events.some((item) => item.participantId === execution.id && item.kind === 'message_requested')
    case 'message_accepted': return execution?.messageOutcome === 'accepted'
    case 'replied': return execution?.outcome === 'replied'
    case 'waiting': return execution?.state === 'waiting_reply'
    case 'call_requested': return execution !== undefined && events.some((item) => item.participantId === execution.id && item.kind === 'call_requested')
    case 'failed': return execution?.state === 'failed'
    case 'needs_review': return execution?.state === 'needs_review'
    case 'completed': return execution?.state === 'completed' || execution?.state === 'blocked'
    case 'in_progress': return execution !== undefined && IN_PROGRESS.has(execution.state)
    default: return false
  }
}
