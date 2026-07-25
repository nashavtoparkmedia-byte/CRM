export type MaxReplyTarget = {
  id: string
  externalId: string | null
}

type BuildMaxReplyStorageInput = {
  rawContent: string
  replyBodyText?: string | null
  replyQuoteText?: string | null
  replyToExternalId?: string | null
  targets?: MaxReplyTarget[]
}

export type MaxReplyStorageDecision = {
  content: string
  metadata: Record<string, string>
  isReply: boolean
  target: MaxReplyTarget | null
}

function clean(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function buildMaxReplyStorage({
  rawContent,
  replyBodyText,
  replyQuoteText,
  replyToExternalId,
  targets = [],
}: BuildMaxReplyStorageInput): MaxReplyStorageDecision {
  const body = clean(replyBodyText)
  const quote = clean(replyQuoteText)
  const providerTarget = clean(replyToExternalId)
  const uniqueTarget = targets.length === 1 ? targets[0] : null
  const hasAuthoritativeRelation = Boolean(providerTarget || uniqueTarget)
  const isReplyCandidate = Boolean(providerTarget || (body && quote))

  if (!isReplyCandidate) {
    return { content: rawContent, metadata: {}, isReply: false, target: null }
  }

  const metadata: Record<string, string> = {}
  if (providerTarget) metadata.replyToExternalId = providerTarget
  if (uniqueTarget) {
    metadata.quotedMsgId = uniqueTarget.id
    if (!metadata.replyToExternalId && uniqueTarget.externalId) {
      metadata.replyToExternalId = uniqueTarget.externalId
    }
    metadata.replyResolutionStatus = 'resolved'
  } else if (providerTarget) {
    if (quote) metadata.unresolvedReplyQuoteText = quote
    metadata.replyResolutionStatus = 'pending_original'
  } else {
    metadata.unresolvedReplyQuoteText = quote
    metadata.replyResolutionStatus = 'ambiguous_or_missing'
  }

  return {
    content: body && hasAuthoritativeRelation ? body : rawContent,
    metadata,
    isReply: true,
    target: uniqueTarget,
  }
}

export function reconcileMaxReplyMetadata(
  metadata: unknown,
  target: MaxReplyTarget,
): Record<string, unknown> {
  const current = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {}
  const { unresolvedReplyQuoteText: _discardedQuote, ...rest } = current
  return {
    ...rest,
    quotedMsgId: target.id,
    replyToExternalId: target.externalId || String(current.replyToExternalId || ''),
    replyResolutionStatus: 'resolved',
  }
}
