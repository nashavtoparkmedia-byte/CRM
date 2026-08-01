import type { JsonValue } from '../journal/types.ts'

export type NormalizationStatus = 'normalized' | 'unsupported' | 'quarantined'
export type NormalizedEventKind = 'message' | 'reaction' | 'receipt' | 'route_evidence' | 'unsupported'
export type NormalizedDirection = 'inbound' | 'outbound_echo' | 'system' | 'unknown'
export type NormalizedOrigin = 'live' | 'history' | 'replay' | 'unknown'
export type MediaKind = 'image' | 'document' | 'video' | 'audio' | 'voice' | 'unknown'

export interface NormalizeRawObservationInput {
  readonly accountId: string
  readonly observationId: string
  readonly journalSequence: bigint
  readonly observedAt: Date
  readonly sourceTransport: string
  readonly sourceOrigin: string
  readonly historyLive: 'history' | 'live' | 'unknown'
  readonly payloadEncoding: string
  readonly sanitizedPayload: JsonValue
  readonly payloadSha256: string
  readonly captureAdapterVersion: string
  readonly parserVersion: string
  readonly opcode?: number
  readonly eventType?: string
  readonly replayAvailability?: 'available' | 'quarantined'
  readonly quarantineReason?: string
}
export interface AttachmentDescriptor {
  readonly attachmentOrdinal: number
  readonly providerAttachmentId: string | null
  readonly mediaKind: MediaKind
  readonly mimeHint: string | null
  readonly fileName: string | null
  readonly sizeBytes: number | null
  readonly durationMs: number | null
  readonly width: number | null
  readonly height: number | null
  readonly captionRelation: 'message_caption' | 'attachment_caption' | 'none'
  readonly fetchReferenceStatus: 'absent' | 'metadata_only' | 'redacted'
  readonly metadataCompleteness: 'complete' | 'partial' | 'unsupported'
  readonly issueCode: string | null
}

export interface ReplyEnvelope {
  readonly status: 'none' | 'exact' | 'unresolved'
  readonly targetProviderMessageId: string | null
  readonly issueCode: string | null
}

export interface NormalizedMessageEnvelope {
  readonly envelopeVersion: string
  readonly messageType: 'text' | 'media' | 'mixed' | 'unknown'
  readonly providerMessageId: string | null
  readonly senderProviderUserId: string | null
  readonly protocolChatId: string | null
  readonly webRouteId: string | null
  readonly clientMessageId: string | null
  readonly attemptCorrelationId: string | null
  readonly providerOccurredAt: string | null
  readonly observedAt: string
  readonly text: string | null
  readonly caption: string | null
  readonly attachments: readonly AttachmentDescriptor[]
  readonly reply: ReplyEnvelope
  readonly direction: NormalizedDirection
  readonly origin: NormalizedOrigin
}

export interface NormalizedReactionEnvelope {
  readonly envelopeVersion: string
  readonly operation: 'add' | 'remove'
  readonly targetProviderMessageId: string | null
  readonly actorProviderUserId: string | null
  readonly reactionValue: string
  readonly providerEventId: string | null
  readonly providerOccurredAt: string | null
  readonly resolutionStatus: 'exact' | 'unresolved'
  readonly direction: NormalizedDirection
  readonly origin: NormalizedOrigin
}

export type ProviderReceiptType =
  | 'provider_acceptance'
  | 'recipient_delivery'
  | 'recipient_read'
  | 'unknown_receipt'

export interface NormalizedReceiptEnvelope {
  readonly envelopeVersion: string
  readonly receiptType: ProviderReceiptType
  readonly targetProviderMessageId: string | null
  readonly providerOccurredAt: string | null
  readonly evidenceClassification: 'exact' | 'acceptance_only' | 'unknown'
  readonly origin: NormalizedOrigin
}

export interface RouteEvidenceEnvelope {
  readonly envelopeVersion: string
  readonly identityKind: 'provider_user_id' | 'protocol_chat_id' | 'web_route_id'
  readonly identityValue: string
  readonly authority: 'provider_exact' | 'protocol_exact' | 'web_route_observed'
  readonly classification: 'exact' | 'weak'
  readonly mutationPerformed: false
}

export interface UnsupportedEnvelope {
  readonly envelopeVersion: string
  readonly issueCode: string
  readonly sourceTransport: string
  readonly eventType: string | null
  readonly opcode: number | null
  readonly payloadPersisted: false
}

export type NormalizedPayload =
  | NormalizedMessageEnvelope
  | NormalizedReactionEnvelope
  | NormalizedReceiptEnvelope
  | RouteEvidenceEnvelope
  | UnsupportedEnvelope

export interface NormalizedEventDraft {
  readonly eventOrdinal: number
  readonly eventKind: NormalizedEventKind
  readonly direction: NormalizedDirection
  readonly origin: NormalizedOrigin
  readonly providerMessageId: string | null
  readonly providerUserId: string | null
  readonly protocolChatId: string | null
  readonly webRouteId: string | null
  readonly clientMessageId: string | null
  readonly targetProviderMessageId: string | null
  readonly providerOccurredAt: Date | null
  readonly normalizedPayload: NormalizedPayload
  readonly semanticSha256: string
}

interface OutcomeBase {
  readonly parserVersion: string
  readonly envelopeVersion: string
  readonly events: readonly NormalizedEventDraft[]
  readonly issueCode: string | null
  readonly safeIssueSummary: string | null
}

export interface NormalizedOutcome extends OutcomeBase {
  readonly status: 'normalized'
}

export interface UnsupportedOutcome extends OutcomeBase {
  readonly status: 'unsupported'
}

export interface QuarantinedOutcome extends OutcomeBase {
  readonly status: 'quarantined'
}

export type NormalizationOutcome = NormalizedOutcome | UnsupportedOutcome | QuarantinedOutcome

export interface InboundNormalizer {
  normalizeRawObservation(input: NormalizeRawObservationInput): NormalizationOutcome
}

export interface NormalizationResult {
  readonly normalizationResultId: string
  readonly accountId: string
  readonly sourceObservationId: string
  readonly sourceJournalSequence: bigint
  readonly parserVersion: string
  readonly envelopeVersion: string
  readonly status: NormalizationStatus
  readonly eventCount: number
  readonly issueCode: string | null
  readonly safeIssueSummary: string | null
  readonly startedAt: Date
  readonly completedAt: Date
  readonly createdAt: Date
}

export interface NormalizedTransportEvent extends NormalizedEventDraft {
  readonly normalizedEventId: string
  readonly normalizationResultId: string
  readonly accountId: string
  readonly sourceObservationId: string
  readonly sourceJournalSequence: bigint
  readonly parserVersion: string
  readonly envelopeVersion: string
  readonly createdAt: Date
}

export interface NormalizedStreamCursor {
  readonly sourceJournalSequence: bigint
  readonly eventOrdinal: number
}

export interface NormalizedEventPage {
  readonly events: readonly NormalizedTransportEvent[]
  readonly nextCursor: NormalizedStreamCursor
}

export interface NormalizeObservationInput {
  readonly accountId: string
  readonly observationId: string
  readonly parserVersion: string
  readonly workerId: string
  readonly now?: Date
}

export interface NormalizeObservationResult {
  readonly result: NormalizationResult
  readonly events: readonly NormalizedTransportEvent[]
  readonly idempotent: boolean
}

export interface NormalizeBatchInput {
  readonly accountId: string
  readonly consumerId: string
  readonly parserVersion: string
  readonly workerId: string
  readonly limit: number
}

export interface NormalizeBatchResult {
  readonly processed: number
  readonly normalized: number
  readonly unsupported: number
  readonly quarantined: number
  readonly idempotent: number
  readonly lastJournalSequence: bigint
}

export interface ShadowInboundNormalizationProcessor {
  normalizeObservation(input: NormalizeObservationInput): Promise<NormalizeObservationResult>
  normalizeBatch(input: NormalizeBatchInput): Promise<NormalizeBatchResult>
  getNormalizationResult(
    accountId: string,
    observationId: string,
    parserVersion: string,
  ): Promise<NormalizeObservationResult | null>
  readNormalizedAfter(
    accountId: string,
    parserVersion: string,
    cursor: NormalizedStreamCursor,
    limit: number,
  ): Promise<NormalizedEventPage>
}
