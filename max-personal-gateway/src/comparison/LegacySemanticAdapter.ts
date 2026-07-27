import { MAX_LEGACY_SEMANTIC_ADAPTER_VERSION } from './constants.ts'
import { finalizeCanonicalOutcome, sha256String } from './canonical.ts'
import type { NormalizeRawObservationInput } from '../inbound/types.ts'
import type {
  CanonicalAttachment,
  CanonicalRouteEvidence,
  CanonicalSemanticEvent,
  CanonicalSemanticOutcome,
  LegacySemanticAdapter,
} from './types.ts'

// Comparison-only, side-effect-free representation of the established legacy
// fixture behavior. It intentionally does not import or rewrite the new parser.

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function legacyOrigin(input: NormalizeRawObservationInput): string {
  if (input.sourceOrigin === 'replay') return 'replay'
  return input.historyLive
}

function legacyDirection(value: unknown): string {
  return value === 'inbound' || value === 'outbound_echo' || value === 'system' || value === 'unknown'
    ? value
    : 'unknown'
}

function occurredAt(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const parsed = new Date(value)
  return Number.isFinite(parsed.valueOf()) ? parsed.toISOString() : null
}

function mediaKind(value: UnknownRecord): string {
  if (typeof value.mediaKind === 'string') return value.mediaKind
  const mime = typeof value.mimeHint === 'string' ? value.mimeHint.toLowerCase() : ''
  if (mime === 'image/jpeg') return 'image'
  if (mime === 'application/pdf') return 'document'
  if (mime === 'video/mp4') return 'video'
  if (mime === 'audio/ogg') return value.voice === true ? 'voice' : 'audio'
  return 'unknown'
}

function legacyAttachment(value: unknown, ordinal: number): CanonicalAttachment {
  if (!isRecord(value)) {
    return {
      attachmentOrdinal: ordinal,
      providerAttachmentId: null,
      mediaKind: 'unknown',
      mimeHint: null,
      fetchReferenceStatus: 'absent',
    }
  }
  const sensitive = typeof value.signedUrl === 'string'
    || typeof value.fetchUrl === 'string'
    || typeof value.url === 'string'
  return {
    attachmentOrdinal: ordinal,
    providerAttachmentId: stringOrNull(value.providerAttachmentId),
    mediaKind: mediaKind(value),
    mimeHint: stringOrNull(value.mimeHint),
    fetchReferenceStatus: sensitive
      ? 'sensitive_present'
      : value.fetchReferenceAvailable === true ? 'download_required' : 'absent',
  }
}

function baseEvent(
  ordinal: number,
  kind: string,
  direction: string,
  origin: string,
  values: Partial<CanonicalSemanticEvent> = {},
): CanonicalSemanticEvent {
  return {
    eventOrdinal: ordinal,
    eventKind: kind,
    direction,
    origin,
    providerMessageId: null,
    providerUserId: null,
    protocolChatId: null,
    webRouteId: null,
    providerOccurredAtPresent: false,
    providerOccurredAt: null,
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
    ...values,
  }
}

function routeEvidence(value: unknown): CanonicalRouteEvidence | null {
  if (!isRecord(value) || typeof value.identityValue !== 'string' || typeof value.identityKind !== 'string') return null
  if (!['provider_user_id', 'protocol_chat_id', 'web_route_id'].includes(value.identityKind)) return null
  return {
    identityKind: value.identityKind,
    identityValue: value.identityValue,
    authority: value.identityKind === 'provider_user_id'
      ? 'provider_exact'
      : value.identityKind === 'protocol_chat_id' ? 'protocol_exact' : 'web_route_observed',
    classification: value.classification === 'weak' ? 'weak' : 'exact',
  }
}

function routeEvent(route: CanonicalRouteEvidence, ordinal: number, origin: string): CanonicalSemanticEvent {
  return baseEvent(ordinal, 'route_evidence', 'system', origin, {
    providerUserId: route.identityKind === 'provider_user_id' ? route.identityValue : null,
    protocolChatId: route.identityKind === 'protocol_chat_id' ? route.identityValue : null,
    webRouteId: route.identityKind === 'web_route_id' ? route.identityValue : null,
    routeEvidence: [route],
  })
}

function legacyMessage(input: NormalizeRawObservationInput, payload: UnknownRecord): CanonicalSemanticOutcome {
  if (payload.attachments !== undefined && !Array.isArray(payload.attachments)) {
    return finalizeCanonicalOutcome('unsupported', [], 'LEGACY_MALFORMED_UNCLASSIFIED')
  }
  const origin = legacyOrigin(input)
  const text = stringOrNull(payload.text)
  const caption = stringOrNull(payload.caption)
  const attachments = (payload.attachments ?? [] as unknown[]).map(legacyAttachment)
  const replyDeclared = payload.reply !== undefined && payload.reply !== null
  const reply = isRecord(payload.reply) ? payload.reply : {}
  const target = stringOrNull(reply.targetProviderMessageId)
  const approximate = target === null && typeof reply.targetText === 'string'
  const providerTimestamp = occurredAt(payload.providerOccurredAt)
  const exactProviderId = stringOrNull(payload.providerMessageId)
  const fallbackProviderId = exactProviderId === null ? stringOrNull(payload.legacyProviderMessageId) : null
  const providerMessageId = exactProviderId ?? fallbackProviderId
  const eventIssue = fallbackProviderId !== null
    ? 'LEGACY_PROVIDER_ID_FALLBACK'
    : approximate ? 'LEGACY_REPLY_APPROXIMATION'
      : attachments.some(item => item.fetchReferenceStatus === 'sensitive_present')
        ? 'LEGACY_SIGNED_URL_RETAINED'
        : attachments.some(item => item.fetchReferenceStatus === 'download_required')
          ? 'LEGACY_SYNCHRONOUS_MEDIA'
          : null
  const message = baseEvent(0, 'message', legacyDirection(payload.direction), origin, {
    providerMessageId,
    providerUserId: stringOrNull(payload.senderProviderUserId),
    protocolChatId: stringOrNull(payload.protocolChatId),
    webRouteId: stringOrNull(payload.webRouteId),
    providerOccurredAtPresent: providerTimestamp !== null,
    providerOccurredAt: providerTimestamp,
    textPresent: text !== null,
    textSha256: text === null ? null : sha256String(text),
    captionPresent: caption !== null,
    captionSha256: caption === null ? null : sha256String(caption),
    attachmentCount: attachments.length,
    attachments,
    replyPresent: replyDeclared,
    replyResolution: target !== null ? 'exact' : approximate ? 'approximated' : replyDeclared ? 'unresolved' : 'none',
    replyTargetPresent: target !== null,
    replyTargetProviderMessageId: target,
    issueClassification: eventIssue,
  })
  const events: CanonicalSemanticEvent[] = [message]
  if (payload.legacyAmbiguousAlignment === true) {
    events.push({ ...message, eventOrdinal: 0, providerMessageId: 'legacy-ambiguous-candidate' })
  }
  if (Array.isArray(payload.routeEvidence)) {
    for (const candidate of payload.routeEvidence) {
      const route = routeEvidence(candidate)
      if (route !== null) events.push(routeEvent(route, events.length, origin))
    }
  }
  for (const [field, kind] of [['senderName', 'legacy_name'], ['senderPhone', 'legacy_phone']] as const) {
    if (typeof payload[field] === 'string') {
      events.push(routeEvent({
        identityKind: kind,
        identityValue: `${kind}:${sha256String(payload[field])}`,
        authority: 'legacy_route_authority',
        classification: 'weak',
      }, events.length, origin))
    }
  }
  return finalizeCanonicalOutcome('normalized', events, eventIssue)
}

function legacyReaction(input: NormalizeRawObservationInput, payload: UnknownRecord): CanonicalSemanticOutcome {
  if (payload.operation !== 'add' && payload.operation !== 'remove') {
    return finalizeCanonicalOutcome('unsupported', [], 'LEGACY_REACTION_UNSUPPORTED')
  }
  const target = stringOrNull(payload.targetProviderMessageId)
  const providerTimestamp = occurredAt(payload.providerOccurredAt)
  const event = baseEvent(0, 'reaction', 'inbound', legacyOrigin(input), {
    providerMessageId: stringOrNull(payload.providerEventId),
    providerUserId: stringOrNull(payload.actorProviderUserId),
    protocolChatId: stringOrNull(payload.protocolChatId),
    providerOccurredAtPresent: providerTimestamp !== null,
    providerOccurredAt: providerTimestamp,
    reactionOperation: payload.operation,
    reactionTargetProviderMessageId: target,
    issueClassification: target === null ? 'REACTION_TARGET_MISSING' : null,
  })
  return finalizeCanonicalOutcome('normalized', [event], event.issueClassification)
}

function legacyReceipt(input: NormalizeRawObservationInput, payload: UnknownRecord): CanonicalSemanticOutcome {
  const target = stringOrNull(payload.targetProviderMessageId)
  const providerTimestamp = occurredAt(payload.providerOccurredAt)
  const semantic = payload.receiptType === 'provider_acceptance'
    || (payload.receiptType === 'ack' && payload.proof === 'provider_acceptance')
    ? 'provider_acceptance'
    : payload.receiptType === 'recipient_read' && payload.proof === 'recipient_read'
      ? 'recipient_read'
      : payload.receiptType === 'recipient_delivery' && payload.proof === 'recipient_delivery'
        ? 'recipient_delivery'
        : payload.receiptType === 'ack' ? 'recipient_delivery' : 'unknown_receipt'
  const issue = payload.receiptType === 'ack' && payload.proof !== 'provider_acceptance'
    ? 'LEGACY_ARBITRARY_ACK_DELIVERY'
    : semantic === 'unknown_receipt' ? 'RECEIPT_SEMANTICS_UNKNOWN' : null
  const event = baseEvent(0, 'receipt', 'system', legacyOrigin(input), {
    protocolChatId: stringOrNull(payload.protocolChatId),
    providerOccurredAtPresent: providerTimestamp !== null,
    providerOccurredAt: providerTimestamp,
    receiptSemantic: semantic,
    receiptTargetProviderMessageId: target,
    issueClassification: issue,
  })
  return finalizeCanonicalOutcome('normalized', [event], issue)
}

function legacyRoutes(input: NormalizeRawObservationInput, payload: UnknownRecord): CanonicalSemanticOutcome {
  const routes = Array.isArray(payload.evidence)
    ? payload.evidence.map(routeEvidence).filter((value): value is CanonicalRouteEvidence => value !== null)
    : []
  if (routes.length === 0) return finalizeCanonicalOutcome('unsupported', [], 'LEGACY_ROUTE_UNSUPPORTED')
  return finalizeCanonicalOutcome('normalized', routes.map((route, index) => routeEvent(route, index, legacyOrigin(input))), null)
}

export class PureLegacySemanticAdapter implements LegacySemanticAdapter {
  readonly adapterVersion = MAX_LEGACY_SEMANTIC_ADAPTER_VERSION

  adapt(input: NormalizeRawObservationInput): CanonicalSemanticOutcome {
    if (input.replayAvailability === 'quarantined') {
      return finalizeCanonicalOutcome('unsupported', [], 'LEGACY_RAW_UNAVAILABLE')
    }
    if (!isRecord(input.sanitizedPayload)) {
      return finalizeCanonicalOutcome('unsupported', [], 'LEGACY_SHAPE_UNSUPPORTED')
    }
    const payload = input.sanitizedPayload
    if (payload.kind === 'message') return legacyMessage(input, payload)
    if (payload.kind === 'reaction') return legacyReaction(input, payload)
    if (payload.kind === 'receipt') return legacyReceipt(input, payload)
    if (payload.kind === 'route_evidence') return legacyRoutes(input, payload)
    return finalizeCanonicalOutcome('unsupported', [], 'LEGACY_SHAPE_UNSUPPORTED')
  }
}
