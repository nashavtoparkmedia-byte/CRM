export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue }

export type ObservationId = string
export type ProcessingStateName =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'retryable'
  | 'quarantined'
  | 'dead_letter'

export type ReplayAvailability = 'available' | 'quarantined'
export type QuarantineReason =
  | 'binary_payload_not_persisted'
  | 'unsupported_payload'
  | 'sanitized_payload_too_large'

export interface RedactionEvidence {
  readonly sanitizerVersion: string
  readonly categories: readonly string[]
  readonly paths: readonly string[]
}

export interface SanitizedObservationInput {
  readonly accountId: string
  readonly captureEnvelopeId?: string
  readonly observedAt: Date
  readonly sourceTransport: string
  readonly sourceOrigin: string
  readonly historyLive: 'history' | 'live' | 'unknown'
  readonly socketGeneration?: string
  readonly frameId?: string
  readonly providerEventId?: string
  readonly transportSequence?: string
  readonly opcode?: number
  readonly eventType?: string
  readonly payloadEncoding: 'json' | 'msgpack_sanitized_json' | 'text_sanitized'
  readonly sanitizedPayload: JsonValue
  readonly payloadSha256: string
  readonly payloadSizeBytes: number
  readonly replayAvailability: ReplayAvailability
  readonly quarantineReason?: QuarantineReason
  readonly sanitizerVersion: string
  readonly captureAdapterVersion: string
  readonly schemaVersion: number
  readonly correlationMetadata?: JsonValue
  readonly redactionMetadata: RedactionEvidence
  readonly quarantineEligible: boolean
  readonly parserVersion: string
}

export interface RawTransportObservation extends Omit<SanitizedObservationInput, 'parserVersion'> {
  readonly observationId: ObservationId
  readonly journalSequence: bigint
  readonly persistedAt: Date
}

export interface ProcessingState {
  readonly id: string
  readonly observationId: ObservationId
  readonly parserVersion: string
  readonly state: ProcessingStateName
  readonly attempts: number
  readonly claimedBy?: string
  readonly claimedAt?: Date
  readonly leaseUntil?: Date
  readonly leaseVersion: number
  readonly completedAt?: Date
  readonly lastErrorCode?: string
  readonly lastErrorSummary?: string
  readonly quarantineReason?: string
  readonly replayMetadata?: JsonValue
}

export interface ConsumerCursor {
  readonly consumerId: string
  readonly accountId: string
  readonly parserVersion: string
  readonly lastJournalSequence: bigint
  readonly version: number
  readonly updatedAt: Date
}

export interface JournalPage {
  readonly observations: readonly RawTransportObservation[]
  readonly nextCursor: bigint
}

export interface ClaimProcessingInput {
  readonly accountId: string
  readonly observationId: ObservationId
  readonly parserVersion: string
  readonly workerId: string
  readonly now: Date
  readonly leaseUntil: Date
  readonly allowQuarantinedReplay?: boolean
}

export interface MarkProcessingInput {
  readonly accountId: string
  readonly observationId: ObservationId
  readonly parserVersion: string
  readonly workerId: string
  readonly expectedLeaseVersion: number
  readonly state: ProcessingStateName
  readonly completedAt?: Date
  readonly lastErrorCode?: string
  readonly lastErrorSummary?: string
  readonly quarantineReason?: string
  readonly replayMetadata?: JsonValue
}

export interface AdvanceCursorInput {
  readonly consumerId: string
  readonly accountId: string
  readonly parserVersion: string
  readonly lastJournalSequence: bigint
  readonly expectedVersion: number
}
