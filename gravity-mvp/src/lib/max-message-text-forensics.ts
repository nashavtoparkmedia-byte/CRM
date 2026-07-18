export type MaxTextDamageKind =
  | 'clean'
  | 'empty'
  | 'legacy_forward_prefix'
  | 'replacement_character'
  | 'raw_attachment_fragment'
  | 'raw_metadata_fragment'
  | 'combined'

export type MaxTextRepairConfidence = 'none' | 'low' | 'medium' | 'high'

export interface MaxMessageTextForensicContext {
  metadata?: unknown
  attachmentCount?: number
}

export interface MaxMessageTextForensicResult {
  kind: MaxTextDamageKind
  recoverable: boolean
  requiresManualReview: boolean
  reasons: string[]
  textLength: number
  proposedReplacement: string | null
  confidence: MaxTextRepairConfidence
}

export interface MaxTextRepairCandidate {
  messageId: string
  result: MaxMessageTextForensicResult
}

export interface MaxTextRepairDryRun {
  total: number
  clean: number
  reviewRequired: number
  recoverableCandidates: number
  byKind: Record<MaxTextDamageKind, number>
  candidates: MaxTextRepairCandidate[]
}

const RAW_ATTACHMENT_MARKERS = [
  'attachments:',
  'attachments=',
  'attachment:',
]

const RAW_METADATA_MARKERS = [
  'prevm',
  'replytoexternalid',
  'forwardedfrom',
  'raw metadata',
  '"metadata":',
  '"senderid":',
]

function containsAny(value: string, markers: string[]): boolean {
  return markers.some(marker => value.includes(marker))
}

function metadataRecord(metadata: unknown): Record<string, unknown> {
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {}
}

function inspectLegacyForwardPrefix(
  text: string,
  context: MaxMessageTextForensicContext,
): MaxMessageTextForensicResult | null {
  const match = text.match(/^\[↩ ([^\]]+)\]\r?\n?([\s\S]*)$/)
  if (!match) return null

  const forwardedFrom = metadataRecord(metadataRecord(context.metadata).forwardedFrom)
  const metadataId = forwardedFrom.id == null ? null : String(forwardedFrom.id)
  const metadataName = forwardedFrom.name == null ? null : String(forwardedFrom.name)
  const prefix = match[1]
  const separator = prefix.indexOf(':')
  const prefixId = separator > 0 ? prefix.slice(0, separator) : null
  const prefixName = separator > 0 ? prefix.slice(separator + 1) : prefix
  const metadataMatches = Boolean(
    Object.keys(forwardedFrom).length > 0
    && (!metadataId || !prefixId || metadataId === prefixId)
    && (!metadataName || metadataName === prefixName),
  )
  const replacement = match[2]

  return {
    kind: 'legacy_forward_prefix',
    recoverable: metadataMatches,
    requiresManualReview: !metadataMatches,
    reasons: metadataMatches
      ? ['legacy_forward_prefix_matches_structured_metadata']
      : ['legacy_forward_prefix_without_matching_metadata'],
    textLength: text.length,
    proposedReplacement: metadataMatches ? replacement : null,
    confidence: metadataMatches ? 'high' : 'none',
  }
}

/**
 * Classifies a stored MAX text without changing it. Repair stays deliberately
 * manual: provider payload fragments can resemble legitimate operator text.
 */
export function inspectMaxMessageText(
  value: string | null | undefined,
  context: MaxMessageTextForensicContext = {},
): MaxMessageTextForensicResult {
  const text = value || ''
  const normalized = text.toLocaleLowerCase('ru-RU')
  const hasReplacementCharacter = text.includes('\uFFFD')
  const hasAttachmentFragment = containsAny(normalized, RAW_ATTACHMENT_MARKERS)
  const hasMetadataFragment = containsAny(normalized, RAW_METADATA_MARKERS)
  const reasons = [
    ...(hasReplacementCharacter ? ['replacement_character'] : []),
    ...(hasAttachmentFragment ? ['raw_attachment_fragment'] : []),
    ...(hasMetadataFragment ? ['raw_metadata_fragment'] : []),
  ]

  if (!text.trim()) {
    return {
      kind: 'empty',
      recoverable: false,
      requiresManualReview: false,
      reasons: [],
      textLength: text.length,
      proposedReplacement: null,
      confidence: 'none',
    }
  }
  const legacyForward = inspectLegacyForwardPrefix(text, context)
  if (legacyForward) return legacyForward
  if (reasons.length > 1) {
    return {
      kind: 'combined',
      recoverable: false,
      requiresManualReview: true,
      reasons,
      textLength: text.length,
      proposedReplacement: null,
      confidence: 'none',
    }
  }
  if (hasReplacementCharacter) {
    return {
      kind: 'replacement_character',
      recoverable: false,
      requiresManualReview: true,
      reasons,
      textLength: text.length,
      proposedReplacement: null,
      confidence: 'none',
    }
  }
  if (hasAttachmentFragment) {
    return {
      kind: 'raw_attachment_fragment',
      recoverable: false,
      requiresManualReview: true,
      reasons: [
        ...reasons,
        ...(context.attachmentCount ? ['structured_attachments_also_exist'] : []),
      ],
      textLength: text.length,
      proposedReplacement: null,
      confidence: 'none',
    }
  }
  if (hasMetadataFragment) {
    return {
      kind: 'raw_metadata_fragment',
      recoverable: false,
      requiresManualReview: true,
      reasons,
      textLength: text.length,
      proposedReplacement: null,
      confidence: 'none',
    }
  }
  return {
    kind: 'clean',
    recoverable: true,
    requiresManualReview: false,
    reasons: [],
    textLength: text.length,
    proposedReplacement: null,
    confidence: 'none',
  }
}

/**
 * A pure report builder for an isolated DB-copy export. It intentionally has
 * no Prisma dependency and never returns a write instruction.
 */
export function buildMaxTextRepairDryRun(messages: Array<{
  id: string
  content: string | null | undefined
  metadata?: unknown
  attachmentCount?: number
}>): MaxTextRepairDryRun {
  const byKind: Record<MaxTextDamageKind, number> = {
    clean: 0,
    empty: 0,
    legacy_forward_prefix: 0,
    replacement_character: 0,
    raw_attachment_fragment: 0,
    raw_metadata_fragment: 0,
    combined: 0,
  }
  const candidates: MaxTextRepairCandidate[] = []

  for (const message of messages) {
    const result = inspectMaxMessageText(message.content, {
      metadata: message.metadata,
      attachmentCount: message.attachmentCount,
    })
    byKind[result.kind] += 1
    if (result.kind !== 'clean' && result.kind !== 'empty') {
      candidates.push({ messageId: message.id, result })
    }
  }

  return {
    total: messages.length,
    clean: byKind.clean,
    reviewRequired: candidates.filter(candidate => candidate.result.requiresManualReview).length,
    recoverableCandidates: candidates.filter(candidate => candidate.result.recoverable).length,
    byKind,
    candidates,
  }
}
