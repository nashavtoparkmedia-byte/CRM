type MessageLike = { metadata?: unknown }

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export function shouldProjectPersonalMaxMessage(message: MessageLike): boolean {
  const metadata = record(message.metadata)
  const disposition = record(metadata.personalMaxIngressDisposition)
  const projection = record(metadata.personalMaxProjection)
  return !(
    (disposition.kind === 'history_replay'
      && disposition.visibility === 'quarantined'
      && disposition.evidencePreserved === true)
    || (projection.visibility === 'suppressed_duplicate'
      && projection.evidencePreserved === true
      && typeof projection.canonicalProviderMessageId === 'string')
    || (projection.visibility === 'suppressed_provider_absent'
      && projection.evidencePreserved === true
      && projection.availableHistoryExhausted === true
      && typeof projection.providerMessageId === 'string'
      && typeof projection.snapshotSha256 === 'string')
  )
}

export function isSupersededPersonalMaxChat(metadataValue: unknown): boolean {
  const metadata = record(metadataValue)
  const projection = record(metadata.personalMaxProjection)
  return projection.state === 'superseded'
    && projection.evidencePreserved === true
    && typeof projection.canonicalChatId === 'string'
}
