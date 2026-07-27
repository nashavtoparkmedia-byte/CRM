import { createHash } from 'node:crypto'
import { canonicalJson } from '../inbound/parserRegistry.ts'
import type { NormalizationOutcome, NormalizedEventDraft } from '../inbound/types.ts'
import type {
  CanonicalAttachment,
  CanonicalRouteEvidence,
  CanonicalSemanticEvent,
  CanonicalSemanticOutcome,
} from './types.ts'

type UnknownRecord = Record<string, unknown>

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
}

export function sha256String(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function boundedValueHash(value: unknown): string | null {
  if (value === undefined) return null
  return sha256String(canonicalJson(value))
}

export function semanticValueType(value: unknown): string {
  if (value === undefined) return 'missing'
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'object') return 'object'
  return typeof value
}

export function finalizeCanonicalOutcome(
  status: CanonicalSemanticOutcome['status'],
  events: readonly CanonicalSemanticEvent[],
  issueClassification: string | null,
): CanonicalSemanticOutcome {
  const stable = { status, events, issueClassification }
  return { ...stable, semanticSha256: sha256String(canonicalJson(stable)) }
}

function canonicalAttachment(value: unknown, fallbackOrdinal: number): CanonicalAttachment {
  const item = record(value)
  const fetch = item.fetchReferenceStatus
  return {
    attachmentOrdinal: Number.isSafeInteger(item.attachmentOrdinal) ? item.attachmentOrdinal as number : fallbackOrdinal,
    providerAttachmentId: typeof item.providerAttachmentId === 'string' ? item.providerAttachmentId : null,
    mediaKind: typeof item.mediaKind === 'string' ? item.mediaKind : 'unknown',
    mimeHint: typeof item.mimeHint === 'string' ? item.mimeHint : null,
    fetchReferenceStatus: fetch === 'metadata_only' || fetch === 'redacted' ? fetch : 'absent',
  }
}

function emptyEvent(event: NormalizedEventDraft): CanonicalSemanticEvent {
  return {
    eventOrdinal: event.eventOrdinal,
    eventKind: event.eventKind,
    direction: event.direction,
    origin: event.origin,
    providerMessageId: event.providerMessageId,
    providerUserId: event.providerUserId,
    protocolChatId: event.protocolChatId,
    webRouteId: event.webRouteId,
    providerOccurredAtPresent: event.providerOccurredAt !== null,
    providerOccurredAt: event.providerOccurredAt?.toISOString() ?? null,
    textPresent: false,
    textSha256: null,
    captionPresent: false,
    captionSha256: null,
    attachmentCount: 0,
    attachments: [],
    replyPresent: false,
    replyResolution: 'none',
    replyTargetPresent: false,
    replyTargetProviderMessageId: null,
    reactionOperation: null,
    reactionTargetProviderMessageId: null,
    receiptSemantic: null,
    receiptTargetProviderMessageId: null,
    routeEvidence: [],
    issueClassification: null,
  }
}

function canonicalizeEvent(event: NormalizedEventDraft): CanonicalSemanticEvent {
  const payload = record(event.normalizedPayload)
  const base = emptyEvent(event)
  if (event.eventKind === 'message') {
    const text = typeof payload.text === 'string' ? payload.text : null
    const caption = typeof payload.caption === 'string' ? payload.caption : null
    const attachments = Array.isArray(payload.attachments)
      ? payload.attachments.map(canonicalAttachment)
      : []
    const reply = record(payload.reply)
    const replyStatus = reply.status === 'exact' || reply.status === 'unresolved' || reply.status === 'none'
      ? reply.status
      : 'none'
    const target = typeof reply.targetProviderMessageId === 'string'
      ? reply.targetProviderMessageId
      : event.targetProviderMessageId
    return {
      ...base,
      textPresent: text !== null,
      textSha256: text === null ? null : sha256String(text),
      captionPresent: caption !== null,
      captionSha256: caption === null ? null : sha256String(caption),
      attachmentCount: attachments.length,
      attachments,
      replyPresent: replyStatus !== 'none',
      replyResolution: replyStatus,
      replyTargetPresent: target !== null,
      replyTargetProviderMessageId: target,
      issueClassification: typeof reply.issueCode === 'string'
        ? reply.issueCode
        : attachments.some(item => item.mediaKind === 'unknown') ? 'ATTACHMENT_PARTIAL' : null,
    }
  }
  if (event.eventKind === 'reaction') {
    return {
      ...base,
      reactionOperation: typeof payload.operation === 'string' ? payload.operation : null,
      reactionTargetProviderMessageId: event.targetProviderMessageId,
      issueClassification: payload.resolutionStatus === 'unresolved' ? 'REACTION_TARGET_MISSING' : null,
    }
  }
  if (event.eventKind === 'receipt') {
    return {
      ...base,
      receiptSemantic: typeof payload.receiptType === 'string' ? payload.receiptType : 'unknown_receipt',
      receiptTargetProviderMessageId: event.targetProviderMessageId,
      issueClassification: payload.receiptType === 'unknown_receipt' ? 'RECEIPT_SEMANTICS_UNKNOWN' : null,
    }
  }
  if (event.eventKind === 'route_evidence') {
    const route: CanonicalRouteEvidence[] = typeof payload.identityKind === 'string'
      && typeof payload.identityValue === 'string'
      ? [{
          identityKind: payload.identityKind,
          identityValue: payload.identityValue,
          authority: typeof payload.authority === 'string' ? payload.authority : 'unknown',
          classification: typeof payload.classification === 'string' ? payload.classification : 'weak',
        }]
      : []
    return { ...base, routeEvidence: route }
  }
  return {
    ...base,
    issueClassification: typeof payload.issueCode === 'string' ? payload.issueCode : 'UNKNOWN_EVENT_SHAPE',
  }
}

export function canonicalizeNewOutcome(outcome: NormalizationOutcome): CanonicalSemanticOutcome {
  return finalizeCanonicalOutcome(
    outcome.status,
    outcome.events.map(canonicalizeEvent),
    outcome.issueCode,
  )
}
