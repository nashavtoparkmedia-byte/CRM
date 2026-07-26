import type { DispatchState, HonestOutboundStatus } from './types.ts'

const STATUS_BY_STATE: Readonly<Record<DispatchState, HonestOutboundStatus>> = Object.freeze({
  queued: 'queued',
  dispatching: 'sending',
  sent_to_provider_client: 'sent_to_client',
  awaiting_confirmation: 'awaiting_provider_confirmation',
  reconciliation_required: 'checking',
  provider_confirmed: 'accepted_by_max',
  retryable_failed: 'retrying',
  hard_failed: 'failed',
  dead_letter: 'needs_review',
})

export function honestOutboundStatus(state: DispatchState): HonestOutboundStatus {
  return STATUS_BY_STATE[state]
}
