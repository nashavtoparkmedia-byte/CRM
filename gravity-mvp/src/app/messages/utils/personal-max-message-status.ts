export type PersonalMaxPresentationKind = 'queued' | 'sending' | 'confirmed' | 'checking' | 'failed'

type MessageLike = {
  channel?: unknown
  direction?: unknown
  status?: unknown
  metadata?: unknown
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export function personalMaxMessagePresentation(message: MessageLike): {
  kind: PersonalMaxPresentationKind
  label: string
  retryAllowed: boolean
} {
  const metadata = record(message.metadata)
  const maxDelivery = record(metadata.maxDelivery)
  const durableStatus = typeof maxDelivery.status === 'string' ? maxDelivery.status : null

  if (message.channel === 'max' && message.direction === 'outbound') {
    if (durableStatus === 'provider_present' && metadata.origin === 'max_native') {
      return { kind: 'confirmed', label: 'Отправлено через MAX', retryAllowed: false }
    }
    if (['delivered', 'provider_confirmed', 'accepted_by_max'].includes(String(durableStatus))
      && maxDelivery.deliveryConfirmed === true) {
      return { kind: 'confirmed', label: 'Подтверждено MAX', retryAllowed: false }
    }
    if (['provider_confirmed', 'accepted_by_max'].includes(String(durableStatus))) {
      return { kind: 'checking', label: 'Проверяем отправку', retryAllowed: false }
    }
    if (['needs_review', 'reconciliation_required'].includes(String(durableStatus))) {
      return { kind: 'checking', label: 'Проверяем отправку', retryAllowed: false }
    }
    if (durableStatus === 'queued' || message.status === 'queued') {
      return { kind: 'queued', label: 'В очереди', retryAllowed: false }
    }
    if (['sending', 'send_requested'].includes(String(durableStatus))) {
      return { kind: 'sending', label: 'Отправляется', retryAllowed: false }
    }
    if (['retryable_failed', 'hard_failed', 'failed', 'dead_letter'].includes(String(durableStatus))) {
      return {
        kind: 'failed',
        label: 'Не отправлено',
        retryAllowed: durableStatus === 'retryable_failed' && metadata.retryable === true,
      }
    }
  }

  if (message.status === 'failed') {
    return { kind: 'failed', label: 'Не отправлено', retryAllowed: metadata.retryable === true }
  }
  if (message.status === 'queued') return { kind: 'queued', label: 'В очереди', retryAllowed: false }
  if (message.status === 'delivered' || message.status === 'read') {
    return { kind: 'confirmed', label: 'Доставлено', retryAllowed: false }
  }
  return { kind: 'sending', label: 'Отправляется', retryAllowed: false }
}
