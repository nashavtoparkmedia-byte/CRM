type DeliveryRecoveryCandidate = {
  channel?: unknown
  metadata?: unknown
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export function shouldMarkStuckOutboundFailed(candidate: DeliveryRecoveryCandidate): boolean {
  if (candidate.channel !== 'max') return true
  const metadata = record(candidate.metadata)
  const maxDelivery = record(metadata.maxDelivery)
  return !['send_requested', 'sending', 'queued', 'needs_review', 'reconciliation_required']
    .includes(String(maxDelivery.status || ''))
}
