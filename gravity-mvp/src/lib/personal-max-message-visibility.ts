type MessageLike = { metadata?: unknown }

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export function shouldProjectPersonalMaxMessage(message: MessageLike): boolean {
  const metadata = record(message.metadata)
  const disposition = record(metadata.personalMaxIngressDisposition)
  return !(
    disposition.kind === 'history_replay'
    && disposition.visibility === 'quarantined'
    && disposition.evidencePreserved === true
  )
}
