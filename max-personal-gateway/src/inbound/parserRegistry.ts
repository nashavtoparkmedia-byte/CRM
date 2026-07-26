import { createHash } from 'node:crypto'
import {
  MAX_PROVIDER_IDENTIFIER_BYTES,
  NORMALIZED_ENVELOPE_VERSION,
} from './constants.ts'
import { InboundNormalizationError } from './errors.ts'
import type {
  AttachmentDescriptor,
  NormalizationOutcome,
  NormalizeRawObservationInput,
  NormalizedDirection,
  NormalizedEventDraft,
  NormalizedOrigin,
  NormalizedPayload,
  ProviderReceiptType,
  RouteEvidenceEnvelope,
} from './types.ts'

type UnknownRecord = Record<string, unknown>

export interface VersionedInboundParserAdapter {
  readonly adapterId: string
  supports(input: NormalizeRawObservationInput): boolean
  normalize(input: NormalizeRawObservationInput): NormalizationOutcome
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stableValue(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new InboundNormalizationError('NORMALIZER_MALFORMED', 'Non-finite number is not supported')
    return value
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new InboundNormalizationError('NORMALIZER_MALFORMED', 'Circular normalized structure is not supported')
    seen.add(value)
    const mapped = value.map(item => stableValue(item, seen))
    seen.delete(value)
    return mapped
  }
  if (isRecord(value)) {
    if (seen.has(value)) throw new InboundNormalizationError('NORMALIZER_MALFORMED', 'Circular normalized structure is not supported')
    seen.add(value)
    const mapped: UnknownRecord = {}
    for (const key of Object.keys(value).sort()) mapped[key] = stableValue(value[key], seen)
    seen.delete(value)
    return mapped
  }
  throw new InboundNormalizationError('NORMALIZER_MALFORMED', 'Unsupported normalized value')
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(stableValue(value))
}

function semanticSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function exactIdentifier(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new InboundNormalizationError('NORMALIZER_MALFORMED', `${field} must be an exact string identifier`)
  if (value.length === 0 || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.byteLength(value, 'utf8') > MAX_PROVIDER_IDENTIFIER_BYTES) {
    throw new InboundNormalizationError('NORMALIZER_MALFORMED', `${field} is not a safe exact identifier`)
  }
  return value
}

function optionalString(value: unknown, field: string, maxBytes = 256 * 1024): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new InboundNormalizationError('NORMALIZER_MALFORMED', `${field} is not a supported string`)
  }
  return value
}

function optionalNonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null
}

function providerDate(value: unknown): Date | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new InboundNormalizationError('NORMALIZER_MALFORMED', 'Provider timestamp must be an ISO string')
  const date = new Date(value)
  if (!Number.isFinite(date.valueOf())) throw new InboundNormalizationError('NORMALIZER_MALFORMED', 'Provider timestamp is invalid')
  return date
}

function origin(input: NormalizeRawObservationInput): NormalizedOrigin {
  if (input.sourceOrigin === 'replay') return 'replay'
  if (input.historyLive === 'history') return 'history'
  if (input.historyLive === 'live') return 'live'
  return 'unknown'
}

function direction(value: unknown): NormalizedDirection {
  if (value === 'inbound' || value === 'outbound_echo' || value === 'system' || value === 'unknown') return value
  return 'unknown'
}

function makeEvent(
  eventOrdinal: number,
  eventKind: NormalizedEventDraft['eventKind'],
  eventDirection: NormalizedDirection,
  eventOrigin: NormalizedOrigin,
  payload: NormalizedPayload,
  identifiers: Omit<NormalizedEventDraft, 'eventOrdinal' | 'eventKind' | 'direction' | 'origin' | 'normalizedPayload' | 'semanticSha256'>,
): NormalizedEventDraft {
  const semantic = {
    envelopeVersion: NORMALIZED_ENVELOPE_VERSION,
    eventKind,
    direction: eventDirection,
    origin: eventOrigin,
    ...identifiers,
    providerOccurredAt: identifiers.providerOccurredAt?.toISOString() ?? null,
    payload,
  }
  return {
    eventOrdinal,
    eventKind,
    direction: eventDirection,
    origin: eventOrigin,
    ...identifiers,
    normalizedPayload: payload,
    semanticSha256: semanticSha256(semantic),
  }
}

function mediaKind(record: UnknownRecord): AttachmentDescriptor['mediaKind'] {
  const explicit = record.mediaKind
  if (explicit === 'image' || explicit === 'document' || explicit === 'video'
    || explicit === 'audio' || explicit === 'voice' || explicit === 'unknown') return explicit
  const mime = typeof record.mimeHint === 'string' ? record.mimeHint.toLowerCase() : ''
  if (mime === 'image/jpeg') return 'image'
  if (mime === 'application/pdf') return 'document'
  if (mime === 'video/mp4') return 'video'
  if (mime === 'audio/ogg') return record.voice === true ? 'voice' : 'audio'
  return 'unknown'
}

function attachmentDescriptor(value: unknown, ordinal: number, messageHasCaption: boolean): AttachmentDescriptor {
  if (!isRecord(value)) {
    return {
      attachmentOrdinal: ordinal,
      providerAttachmentId: null,
      mediaKind: 'unknown',
      mimeHint: null,
      fileName: null,
      sizeBytes: null,
      durationMs: null,
      width: null,
      height: null,
      captionRelation: messageHasCaption ? 'message_caption' : 'none',
      fetchReferenceStatus: 'absent',
      metadataCompleteness: 'unsupported',
      issueCode: 'ATTACHMENT_SHAPE_UNSUPPORTED',
    }
  }

  let providerAttachmentId: string | null = null
  let issueCode: string | null = null
  try {
    providerAttachmentId = exactIdentifier(value.providerAttachmentId, 'providerAttachmentId')
  } catch {
    issueCode = 'ATTACHMENT_ID_INVALID'
  }
  const mimeHint = typeof value.mimeHint === 'string' && value.mimeHint.length <= 255 ? value.mimeHint : null
  const fileName = typeof value.fileName === 'string' && Buffer.byteLength(value.fileName, 'utf8') <= 512
    ? value.fileName
    : null
  const kind = mediaKind(value)
  if (kind === 'unknown' && issueCode === null) issueCode = 'ATTACHMENT_MEDIA_UNKNOWN'
  const hasSensitiveReference = typeof value.fetchUrl === 'string'
    || typeof value.signedUrl === 'string'
    || typeof value.url === 'string'
  const hasSafeReference = value.fetchReferenceAvailable === true

  return {
    attachmentOrdinal: ordinal,
    providerAttachmentId,
    mediaKind: kind,
    mimeHint,
    fileName,
    sizeBytes: optionalNonNegativeInteger(value.sizeBytes),
    durationMs: optionalNonNegativeInteger(value.durationMs),
    width: optionalNonNegativeInteger(value.width),
    height: optionalNonNegativeInteger(value.height),
    captionRelation: value.caption === true ? 'attachment_caption' : messageHasCaption ? 'message_caption' : 'none',
    fetchReferenceStatus: hasSensitiveReference ? 'redacted' : hasSafeReference ? 'metadata_only' : 'absent',
    metadataCompleteness: issueCode === null ? 'complete' : kind === 'unknown' ? 'unsupported' : 'partial',
    issueCode,
  }
}

function routeEnvelope(value: unknown): RouteEvidenceEnvelope | null {
  if (!isRecord(value)) return null
  const identityKind = value.identityKind
  if (identityKind !== 'provider_user_id' && identityKind !== 'protocol_chat_id' && identityKind !== 'web_route_id') return null
  let identityValue: string | null
  try {
    identityValue = exactIdentifier(value.identityValue, 'route identity')
  } catch {
    return null
  }
  if (identityValue === null) return null
  const defaultAuthority = identityKind === 'provider_user_id'
    ? 'provider_exact'
    : identityKind === 'protocol_chat_id' ? 'protocol_exact' : 'web_route_observed'
  const classification = value.classification === 'weak' ? 'weak' : 'exact'
  return {
    envelopeVersion: NORMALIZED_ENVELOPE_VERSION,
    identityKind,
    identityValue,
    authority: defaultAuthority,
    classification,
    mutationPerformed: false,
  }
}

function messageEvents(input: NormalizeRawObservationInput, payload: UnknownRecord): NormalizationOutcome {
  const eventOrigin = origin(input)
  const eventDirection = direction(payload.direction)
  const providerMessageId = exactIdentifier(payload.providerMessageId, 'providerMessageId')
  const providerUserId = exactIdentifier(payload.senderProviderUserId, 'senderProviderUserId')
  const protocolChatId = exactIdentifier(payload.protocolChatId, 'protocolChatId')
  const webRouteId = exactIdentifier(payload.webRouteId, 'webRouteId')
  const clientMessageId = exactIdentifier(payload.clientMessageId, 'clientMessageId')
  const providerOccurredAt = providerDate(payload.providerOccurredAt)
  const text = optionalString(payload.text, 'text')
  const caption = optionalString(payload.caption, 'caption')
  if (payload.attachments !== undefined && !Array.isArray(payload.attachments)) {
    throw new InboundNormalizationError('NORMALIZER_MALFORMED', 'attachments must be an array')
  }
  const attachments = (payload.attachments ?? []).map((item, index) => attachmentDescriptor(item, index, caption !== null))
  const replyDeclared = payload.reply !== undefined && payload.reply !== null
  const replyRecord = isRecord(payload.reply) ? payload.reply : {}
  const targetProviderMessageId = exactIdentifier(replyRecord.targetProviderMessageId, 'targetProviderMessageId')
  const reply = targetProviderMessageId !== null
    ? { status: 'exact' as const, targetProviderMessageId, issueCode: null }
    : replyDeclared
      ? { status: 'unresolved' as const, targetProviderMessageId: null, issueCode: 'REPLY_TARGET_MISSING' }
      : { status: 'none' as const, targetProviderMessageId: null, issueCode: null }
  const messageType = attachments.length > 0 && (text !== null || caption !== null)
    ? 'mixed'
    : attachments.length > 0 ? 'media' : text !== null ? 'text' : 'unknown'
  const envelope = {
    envelopeVersion: NORMALIZED_ENVELOPE_VERSION,
    messageType,
    providerMessageId,
    senderProviderUserId: providerUserId,
    protocolChatId,
    webRouteId,
    clientMessageId,
    providerOccurredAt: providerOccurredAt?.toISOString() ?? null,
    observedAt: input.observedAt.toISOString(),
    text,
    caption,
    attachments,
    reply,
    direction: eventDirection,
    origin: eventOrigin,
  } as const
  const events: NormalizedEventDraft[] = [makeEvent(0, 'message', eventDirection, eventOrigin, envelope, {
    providerMessageId,
    providerUserId,
    protocolChatId,
    webRouteId,
    clientMessageId,
    targetProviderMessageId,
    providerOccurredAt,
  })]
  const routeEvidence = Array.isArray(payload.routeEvidence) ? payload.routeEvidence : []
  for (const candidate of routeEvidence) {
    const route = routeEnvelope(candidate)
    if (route === null) continue
    const providerRouteUser = route.identityKind === 'provider_user_id' ? route.identityValue : null
    const protocolRouteChat = route.identityKind === 'protocol_chat_id' ? route.identityValue : null
    const webRoute = route.identityKind === 'web_route_id' ? route.identityValue : null
    events.push(makeEvent(events.length, 'route_evidence', 'system', eventOrigin, route, {
      providerMessageId: null,
      providerUserId: providerRouteUser,
      protocolChatId: protocolRouteChat,
      webRouteId: webRoute,
      clientMessageId: null,
      targetProviderMessageId: null,
      providerOccurredAt,
    }))
  }
  const attachmentIssues = attachments.some(item => item.issueCode !== null)
  const issueCode = reply.status === 'unresolved'
    ? 'REPLY_TARGET_MISSING'
    : attachmentIssues ? 'ATTACHMENT_PARTIAL' : null
  return {
    status: 'normalized',
    parserVersion: input.parserVersion,
    envelopeVersion: NORMALIZED_ENVELOPE_VERSION,
    events,
    issueCode,
    safeIssueSummary: issueCode === null ? null : 'Semantic event retained with unresolved or partial metadata',
  }
}

function reactionEvent(input: NormalizeRawObservationInput, payload: UnknownRecord): NormalizationOutcome {
  if (payload.operation !== 'add' && payload.operation !== 'remove') {
    throw new InboundNormalizationError('NORMALIZER_MALFORMED', 'Reaction operation is not supported')
  }
  const targetProviderMessageId = exactIdentifier(payload.targetProviderMessageId, 'targetProviderMessageId')
  const providerUserId = exactIdentifier(payload.actorProviderUserId, 'actorProviderUserId')
  const providerMessageId = exactIdentifier(payload.providerEventId, 'providerEventId')
  const reactionValue = optionalString(payload.reactionValue, 'reactionValue', 128)
  if (reactionValue === null || reactionValue.length === 0) {
    throw new InboundNormalizationError('NORMALIZER_MALFORMED', 'Reaction value is required')
  }
  const providerOccurredAt = providerDate(payload.providerOccurredAt)
  const eventOrigin = origin(input)
  const envelope = {
    envelopeVersion: NORMALIZED_ENVELOPE_VERSION,
    operation: payload.operation,
    targetProviderMessageId,
    actorProviderUserId: providerUserId,
    reactionValue,
    providerEventId: providerMessageId,
    providerOccurredAt: providerOccurredAt?.toISOString() ?? null,
    resolutionStatus: targetProviderMessageId === null ? 'unresolved' : 'exact',
    direction: 'inbound',
    origin: eventOrigin,
  } as const
  const issueCode = targetProviderMessageId === null ? 'REACTION_TARGET_MISSING' : null
  return {
    status: 'normalized',
    parserVersion: input.parserVersion,
    envelopeVersion: NORMALIZED_ENVELOPE_VERSION,
    events: [makeEvent(0, 'reaction', 'inbound', eventOrigin, envelope, {
      providerMessageId,
      providerUserId,
      protocolChatId: exactIdentifier(payload.protocolChatId, 'protocolChatId'),
      webRouteId: null,
      clientMessageId: null,
      targetProviderMessageId,
      providerOccurredAt,
    })],
    issueCode,
    safeIssueSummary: issueCode === null ? null : 'Reaction retained without an exact target',
  }
}

function provenReceipt(payload: UnknownRecord): { receiptType: ProviderReceiptType; evidence: 'exact' | 'acceptance_only' | 'unknown' } {
  if (payload.receiptType === 'provider_acceptance' || (payload.receiptType === 'ack' && payload.proof === 'provider_acceptance')) {
    return { receiptType: 'provider_acceptance', evidence: 'acceptance_only' }
  }
  if (payload.receiptType === 'recipient_delivery' && payload.proof === 'recipient_delivery') {
    return { receiptType: 'recipient_delivery', evidence: 'exact' }
  }
  if (payload.receiptType === 'recipient_read' && payload.proof === 'recipient_read') {
    return { receiptType: 'recipient_read', evidence: 'exact' }
  }
  return { receiptType: 'unknown_receipt', evidence: 'unknown' }
}

function receiptEvent(input: NormalizeRawObservationInput, payload: UnknownRecord): NormalizationOutcome {
  const targetProviderMessageId = exactIdentifier(payload.targetProviderMessageId, 'targetProviderMessageId')
  const providerOccurredAt = providerDate(payload.providerOccurredAt)
  const proven = provenReceipt(payload)
  const eventOrigin = origin(input)
  const envelope = {
    envelopeVersion: NORMALIZED_ENVELOPE_VERSION,
    receiptType: proven.receiptType,
    targetProviderMessageId,
    providerOccurredAt: providerOccurredAt?.toISOString() ?? null,
    evidenceClassification: proven.evidence,
    origin: eventOrigin,
  } as const
  const issueCode = proven.receiptType === 'unknown_receipt' ? 'RECEIPT_SEMANTICS_UNKNOWN' : null
  return {
    status: 'normalized',
    parserVersion: input.parserVersion,
    envelopeVersion: NORMALIZED_ENVELOPE_VERSION,
    events: [makeEvent(0, 'receipt', 'system', eventOrigin, envelope, {
      providerMessageId: null,
      providerUserId: null,
      protocolChatId: exactIdentifier(payload.protocolChatId, 'protocolChatId'),
      webRouteId: null,
      clientMessageId: null,
      targetProviderMessageId,
      providerOccurredAt,
    })],
    issueCode,
    safeIssueSummary: issueCode === null ? null : 'Receipt retained without claiming recipient delivery',
  }
}

function routeEvents(input: NormalizeRawObservationInput, payload: UnknownRecord): NormalizationOutcome {
  const candidates = Array.isArray(payload.evidence) ? payload.evidence : []
  const eventOrigin = origin(input)
  const events: NormalizedEventDraft[] = []
  for (const candidate of candidates) {
    const route = routeEnvelope(candidate)
    if (route === null) continue
    events.push(makeEvent(events.length, 'route_evidence', 'system', eventOrigin, route, {
      providerMessageId: null,
      providerUserId: route.identityKind === 'provider_user_id' ? route.identityValue : null,
      protocolChatId: route.identityKind === 'protocol_chat_id' ? route.identityValue : null,
      webRouteId: route.identityKind === 'web_route_id' ? route.identityValue : null,
      clientMessageId: null,
      targetProviderMessageId: null,
      providerOccurredAt: null,
    }))
  }
  if (events.length === 0) return unsupportedOutcome(input, 'ROUTE_EVIDENCE_UNSUPPORTED')
  return {
    status: 'normalized',
    parserVersion: input.parserVersion,
    envelopeVersion: NORMALIZED_ENVELOPE_VERSION,
    events,
    issueCode: null,
    safeIssueSummary: null,
  }
}

export function unsupportedOutcome(input: NormalizeRawObservationInput, issueCode = 'UNKNOWN_EVENT_SHAPE'): NormalizationOutcome {
  const eventOrigin = origin(input)
  const payload = {
    envelopeVersion: NORMALIZED_ENVELOPE_VERSION,
    issueCode,
    sourceTransport: input.sourceTransport,
    eventType: input.eventType ?? null,
    opcode: input.opcode ?? null,
    payloadPersisted: false,
  } as const
  return {
    status: 'unsupported',
    parserVersion: input.parserVersion,
    envelopeVersion: NORMALIZED_ENVELOPE_VERSION,
    events: [makeEvent(0, 'unsupported', 'unknown', eventOrigin, payload, {
      providerMessageId: null,
      providerUserId: null,
      protocolChatId: null,
      webRouteId: null,
      clientMessageId: null,
      targetProviderMessageId: null,
      providerOccurredAt: null,
    })],
    issueCode,
    safeIssueSummary: 'Provider event shape is not supported by this parser version',
  }
}

export class MaxSanitizedProtocolAdapter implements VersionedInboundParserAdapter {
  readonly adapterId = 'max-sanitized-protocol-adapter-v1'

  supports(input: NormalizeRawObservationInput): boolean {
    if (!['max_protocol', 'max_websocket', 'max_history', 'max_synthetic_fixture', 'websocket_frame'].includes(input.sourceTransport)) return false
    if (!isRecord(input.sanitizedPayload)) return false
    return input.sanitizedPayload.kind === 'message'
      || input.sanitizedPayload.kind === 'reaction'
      || input.sanitizedPayload.kind === 'receipt'
      || input.sanitizedPayload.kind === 'route_evidence'
  }

  normalize(input: NormalizeRawObservationInput): NormalizationOutcome {
    if (!isRecord(input.sanitizedPayload)) throw new InboundNormalizationError('NORMALIZER_MALFORMED', 'Payload is not an object')
    if (input.sanitizedPayload.kind === 'message') return messageEvents(input, input.sanitizedPayload)
    if (input.sanitizedPayload.kind === 'reaction') return reactionEvent(input, input.sanitizedPayload)
    if (input.sanitizedPayload.kind === 'receipt') return receiptEvent(input, input.sanitizedPayload)
    if (input.sanitizedPayload.kind === 'route_evidence') return routeEvents(input, input.sanitizedPayload)
    return unsupportedOutcome(input)
  }
}

function fixtureExactIdentifier(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (isRecord(value) && value.__maxId === true && typeof value.hex === 'string') return value.hex
  return undefined
}

function fixtureOccurredAt(value: unknown): string | undefined {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return undefined
  const date = new Date(value as number)
  return Number.isFinite(date.valueOf()) ? date.toISOString() : undefined
}

function fixtureAttachment(value: unknown): UnknownRecord {
  if (!isRecord(value)) return { mediaKind: 'unknown' }
  const preview = isRecord(value.preview) ? value.preview : {}
  const explicitType = typeof value._type === 'string' ? value._type : typeof preview._type === 'string' ? preview._type : ''
  const name = typeof value.name === 'string' ? value.name : null
  const extension = name?.toLowerCase().split('.').at(-1)
  const mediaKind = explicitType === 'PHOTO' || extension === 'jpg' || extension === 'jpeg'
    ? 'image'
    : explicitType === 'VIDEO' || extension === 'mp4' || value.VIDEO !== undefined
      ? 'video'
      : explicitType === 'MUSIC' || extension === 'ogg'
        ? 'voice'
        : explicitType === 'FILE' || extension === 'pdf' ? 'document' : 'unknown'
  const mimeHint = mediaKind === 'image' ? 'image/jpeg'
    : mediaKind === 'video' ? 'video/mp4'
      : mediaKind === 'voice' ? 'audio/ogg'
        : mediaKind === 'document' && extension === 'pdf' ? 'application/pdf' : null
  const fetchReference = typeof value.baseUrl === 'string'
    ? value.baseUrl
    : typeof value.thumbnail === 'string' ? value.thumbnail : undefined
  return {
    providerAttachmentId: fixtureExactIdentifier(value.fileId)
      ?? fixtureExactIdentifier(value.videoId)
      ?? fixtureExactIdentifier(value.photoId),
    mediaKind,
    mimeHint,
    fileName: name,
    sizeBytes: optionalNonNegativeInteger(value.size),
    durationMs: optionalNonNegativeInteger(value.duration)
      ?? (optionalNonNegativeInteger(preview.duration) === null ? null : optionalNonNegativeInteger(preview.duration)! * 1000),
    fetchUrl: fetchReference,
    fetchReferenceAvailable: fetchReference === undefined && (value.token !== undefined || value['110'] !== undefined),
  }
}

function translateFixtureMessage(payload: UnknownRecord): UnknownRecord | null {
  const nested = isRecord(payload.message) ? payload.message : payload
  const providerMessageId = fixtureExactIdentifier(nested.id)
  const providerUserId = fixtureExactIdentifier(nested.sender)
  const protocolChatId = fixtureExactIdentifier(payload.chatId ?? nested.chatId)
  const rootAttachments = Array.isArray(payload.attaches) ? payload.attaches : []
  const nestedAttachments = Array.isArray(nested.attaches) ? nested.attaches : []
  const looseAttachments = Array.isArray(payload.loose) ? payload.loose : []
  const attachments = [...nestedAttachments, ...rootAttachments, ...looseAttachments].map(fixtureAttachment)
  const text = typeof nested.text === 'string' ? nested.text : null
  const link = isRecord(nested.link) && nested.link.type === 'REPLY' ? nested.link : null
  if (providerMessageId === undefined && text === null && attachments.length === 0 && link === null) return null
  const routeEvidence: UnknownRecord[] = []
  if (providerUserId !== undefined) routeEvidence.push({ identityKind: 'provider_user_id', identityValue: providerUserId })
  if (protocolChatId !== undefined) routeEvidence.push({ identityKind: 'protocol_chat_id', identityValue: protocolChatId })
  return {
    kind: 'message',
    direction: 'inbound',
    providerMessageId,
    senderProviderUserId: providerUserId,
    protocolChatId,
    providerOccurredAt: fixtureOccurredAt(nested.time),
    text: attachments.length > 0 ? null : text,
    caption: attachments.length > 0 ? text : null,
    attachments,
    reply: link === null ? undefined : { targetProviderMessageId: fixtureExactIdentifier(link.messageId) },
    routeEvidence,
  }
}

export class LegacyMaxFixtureAdapter implements VersionedInboundParserAdapter {
  readonly adapterId = 'max-established-fixture-adapter-v1'

  supports(input: NormalizeRawObservationInput): boolean {
    if (!['max_protocol', 'max_websocket', 'max_history', 'max_synthetic_fixture', 'websocket_frame'].includes(input.sourceTransport)) return false
    if (!isRecord(input.sanitizedPayload) || input.sanitizedPayload.kind !== undefined) return false
    return translateFixtureMessage(input.sanitizedPayload) !== null
  }

  normalize(input: NormalizeRawObservationInput): NormalizationOutcome {
    if (!isRecord(input.sanitizedPayload)) return unsupportedOutcome(input)
    const translated = translateFixtureMessage(input.sanitizedPayload)
    return translated === null ? unsupportedOutcome(input) : messageEvents(input, translated)
  }
}

export class VersionedInboundParserRegistry {
  readonly #adapters: readonly VersionedInboundParserAdapter[]

  constructor(adapters: readonly VersionedInboundParserAdapter[] = [new LegacyMaxFixtureAdapter(), new MaxSanitizedProtocolAdapter()]) {
    const ids = adapters.map(adapter => adapter.adapterId)
    if (ids.some(id => id.trim() === '') || new Set(ids).size !== ids.length) {
      throw new InboundNormalizationError('INVALID_INPUT', 'Parser adapter IDs must be unique and nonempty')
    }
    this.#adapters = [...adapters]
  }

  normalize(input: NormalizeRawObservationInput): NormalizationOutcome {
    const adapter = this.#adapters.find(candidate => candidate.supports(input))
    return adapter?.normalize(input) ?? unsupportedOutcome(input)
  }
}
