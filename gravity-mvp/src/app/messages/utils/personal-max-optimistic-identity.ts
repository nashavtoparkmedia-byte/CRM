type OptimisticMessage = {
  id: string
  clientMessageId?: string
}

type DurableMessage = {
  clientMessageId?: string | null
}

export function pendingOptimisticMessages<T extends OptimisticMessage>(
  cachedMessages: readonly T[],
  durableMessages: readonly DurableMessage[],
): T[] {
  const durableClientIds = new Set(
    durableMessages
      .map(message => message.clientMessageId)
      .filter((value): value is string => typeof value === 'string' && value.length > 0),
  )

  return cachedMessages
    .filter(message => message.id.startsWith('cmid-'))
    .filter(message => {
      const identity = message.clientMessageId || message.id
      return !durableClientIds.has(identity)
    })
}
