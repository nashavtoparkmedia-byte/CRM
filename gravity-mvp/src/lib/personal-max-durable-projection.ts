type MessageProjection = {
  clientMessageId?: string | null
  channel?: unknown
  direction?: unknown
  status?: unknown
  externalId?: string | null
  metadata?: unknown
}

type DurableCommandProjection = {
  clientMessageId?: string | null
  dispatch?: {
    state?: string | null
    providerMessageId?: string | null
  } | null
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function presentation(state: string): { messageStatus: string; durableStatus: string; retryable: boolean } {
  if (state === 'provider_confirmed') {
    return { messageStatus: 'delivered', durableStatus: 'provider_confirmed', retryable: false }
  }
  if (state === 'reconciliation_required') {
    return { messageStatus: 'sent', durableStatus: 'needs_review', retryable: false }
  }
  if (state === 'queued') {
    return { messageStatus: 'queued', durableStatus: 'queued', retryable: false }
  }
  if (['dispatching', 'sent_to_provider_client', 'awaiting_confirmation'].includes(state)) {
    return { messageStatus: 'sent', durableStatus: 'sending', retryable: false }
  }
  if (state === 'retryable_failed') {
    return { messageStatus: 'failed', durableStatus: 'retryable_failed', retryable: true }
  }
  return { messageStatus: 'failed', durableStatus: state, retryable: false }
}

export function projectPersonalMaxDurableState<T extends MessageProjection>(
  messages: readonly T[],
  commands: readonly DurableCommandProjection[],
): T[] {
  const dispatchByClientId = new Map(
    commands
      .filter(command => typeof command.clientMessageId === 'string' && command.dispatch?.state)
      .map(command => [command.clientMessageId as string, command.dispatch!]),
  )

  return messages.map(message => {
    if (message.channel !== 'max' || message.direction !== 'outbound'
      || typeof message.clientMessageId !== 'string') return message
    const dispatch = dispatchByClientId.get(message.clientMessageId)
    if (!dispatch?.state) return message

    const state = presentation(dispatch.state)
    const metadata = record(message.metadata)
    const previousDelivery = record(metadata.maxDelivery)
    const providerMessageId = dispatch.providerMessageId || null
    return {
      ...message,
      status: state.messageStatus,
      externalId: providerMessageId || message.externalId || null,
      metadata: {
        ...metadata,
        retryable: state.retryable,
        maxDelivery: {
          ...previousDelivery,
          status: state.durableStatus,
          deliveryConfirmed: dispatch.state === 'provider_confirmed',
          maxMessageId: providerMessageId,
          externalId: providerMessageId,
        },
      },
    }
  })
}
