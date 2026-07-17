export type MaxTextDamageKind =
  | 'clean'
  | 'empty'
  | 'replacement_character'
  | 'raw_attachment_fragment'
  | 'raw_metadata_fragment'
  | 'combined'

export interface MaxMessageTextForensicResult {
  kind: MaxTextDamageKind
  recoverable: boolean
  requiresManualReview: boolean
  reasons: string[]
  textLength: number
}

export interface MaxTextRepairCandidate {
  messageId: string
  result: MaxMessageTextForensicResult
}

export interface MaxTextRepairDryRun {
  total: number
  clean: number
  reviewRequired: number
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

/**
 * Classifies a stored MAX text without changing it. Repair stays deliberately
 * manual: provider payload fragments can resemble legitimate operator text.
 */
export function inspectMaxMessageText(value: string | null | undefined): MaxMessageTextForensicResult {
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
    return { kind: 'empty', recoverable: false, requiresManualReview: false, reasons: [], textLength: text.length }
  }
  if (reasons.length > 1) {
    return { kind: 'combined', recoverable: false, requiresManualReview: true, reasons, textLength: text.length }
  }
  if (hasReplacementCharacter) {
    return { kind: 'replacement_character', recoverable: false, requiresManualReview: true, reasons, textLength: text.length }
  }
  if (hasAttachmentFragment) {
    return { kind: 'raw_attachment_fragment', recoverable: false, requiresManualReview: true, reasons, textLength: text.length }
  }
  if (hasMetadataFragment) {
    return { kind: 'raw_metadata_fragment', recoverable: false, requiresManualReview: true, reasons, textLength: text.length }
  }
  return { kind: 'clean', recoverable: true, requiresManualReview: false, reasons: [], textLength: text.length }
}

/**
 * A pure report builder for an isolated DB-copy export. It intentionally has
 * no Prisma dependency and returns no replacement text or write instruction.
 */
export function buildMaxTextRepairDryRun(messages: Array<{ id: string; content: string | null | undefined }>): MaxTextRepairDryRun {
  const byKind: Record<MaxTextDamageKind, number> = {
    clean: 0,
    empty: 0,
    replacement_character: 0,
    raw_attachment_fragment: 0,
    raw_metadata_fragment: 0,
    combined: 0,
  }
  const candidates: MaxTextRepairCandidate[] = []

  for (const message of messages) {
    const result = inspectMaxMessageText(message.content)
    byKind[result.kind] += 1
    if (result.requiresManualReview) candidates.push({ messageId: message.id, result })
  }

  return {
    total: messages.length,
    clean: byKind.clean,
    reviewRequired: candidates.length,
    byKind,
    candidates,
  }
}
