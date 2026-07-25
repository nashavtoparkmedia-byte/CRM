import type { MessageStatus } from '@prisma/client'

export type MaxDeliveryStatus = 'queued' | 'sending' | 'delivered' | 'failed'

export type MaxDeliveryUpdate = {
  queueId?: string | null
  status: MaxDeliveryStatus
  attempt?: number | null
  retryable?: boolean | null
  error?: string | null
  errorCode?: string | null
  externalId?: string | null
  chatId?: string | null
  uiChatId?: string | null
  quotedMsgId?: string | null
  source?: string | null
  updatedAt?: string | null
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export function isRealMaxMessageId(value: unknown): value is string {
  return typeof value === 'string' && /^d301[0-9a-f]+$/i.test(value)
}

export function maxDeliveryTargetStatus(status: MaxDeliveryStatus): MessageStatus {
  if (status === 'sending') return 'sent'
  return status
}

export function canApplyMaxDeliveryTransition(current: MessageStatus, next: MessageStatus): boolean {
  if (current === next) return true
  if (current === 'read' || current === 'delivered') return false
  if (current === 'failed') return next === 'delivered'
  if (current === 'sent' && next === 'queued') return false
  return true
}

export function maxOperatorDeliveryError(update: MaxDeliveryUpdate): string {
  if (update.errorCode === 'MAX_REPLY_TARGET_UNRESOLVED') {
    return 'Не удалось найти исходное сообщение в MAX.'
  }
  if (update.errorCode === 'MAX_TRANSPORT_NOT_READY' || update.errorCode === 'MAX_WS_DISCONNECTED') {
    return 'Нет связи с MAX. Можно повторить отправку.'
  }
  if (update.errorCode === 'MAX_PROVIDER_REJECTED') {
    return 'MAX отклонил отправку сообщения.'
  }
  return 'MAX не подтвердил доставку. Можно повторить отправку.'
}

export function buildMaxDeliveryMetadata(
  previousMetadata: unknown,
  update: MaxDeliveryUpdate,
): Record<string, unknown> {
  const previous = record(previousMetadata)
  const previousMax = record(previous.maxDelivery)
  const next: Record<string, unknown> = {
    ...previous,
    maxDelivery: {
      ...previousMax,
      queueId: update.queueId || previousMax.queueId || null,
      status: update.status,
      attempt: Number(update.attempt || 0),
      retryable: update.retryable !== false,
      error: update.error || null,
      errorCode: update.errorCode || null,
      maxMessageId: isRealMaxMessageId(update.externalId) ? update.externalId : null,
      externalId: update.externalId || null,
      protocolChatId: update.chatId || previousMax.protocolChatId || null,
      webRouteId: update.uiChatId || previousMax.webRouteId || null,
      quotedMsgId: update.quotedMsgId || previousMax.quotedMsgId || null,
      deliveryConfirmed: update.status === 'delivered',
      source: update.source || 'max_delivery_callback',
      providerUpdatedAt: update.updatedAt || new Date().toISOString(),
    },
  }

  if (update.status === 'failed') {
    next.error = maxOperatorDeliveryError(update)
    next.errorCode = update.errorCode || 'MAX_SEND_FAILED'
    next.retryable = update.retryable !== false
    next.lastFailedAt = new Date().toISOString()
  } else if (update.status === 'delivered') {
    delete next.error
    delete next.errorCode
    delete next.retryable
    delete next.lastFailedAt
  }
  return next
}
