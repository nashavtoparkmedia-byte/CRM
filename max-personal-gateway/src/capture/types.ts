import type { JsonValue, QuarantineReason, RedactionEvidence, ReplayAvailability } from '../journal/types.ts'

export const CAPTURE_ENVELOPE_VERSION = 1 as const
export const CAPTURE_ADAPTER_VERSION = 'max-live-capture-adapter-v1' as const
export const CAPTURE_PARSER_VERSION = 'max-inbound-normalizer-v1' as const

export type CaptureOrigin = 'history' | 'live' | 'unknown'
export type CaptureHealthState = 'disabled' | 'healthy' | 'degraded' | 'critical'

export interface CaptureEnvelope {
  readonly captureEnvelopeId: string
  readonly captureEnvelopeVersion: typeof CAPTURE_ENVELOPE_VERSION
  readonly accountId: string
  readonly observedAt: string
  readonly sourceTransport: string
  readonly sourceOrigin: CaptureOrigin
  readonly socketGeneration: string
  readonly sessionGeneration: string
  readonly frameId: string | null
  readonly providerEventId: string | null
  readonly transportSequence: string | null
  readonly opcode: number | null
  readonly eventType: string | null
  readonly payloadEncoding: 'json' | 'msgpack_sanitized_json' | 'text_sanitized'
  readonly sanitizedPayload: JsonValue
  readonly payloadSha256: string
  readonly payloadSizeBytes: number
  readonly replayAvailability: ReplayAvailability
  readonly quarantineReason: QuarantineReason | null
  readonly redactionMetadata: RedactionEvidence
  readonly sanitizerVersion: string
  readonly captureAdapterVersion: typeof CAPTURE_ADAPTER_VERSION
  readonly capturedAt: string
  readonly retryCount: number
  readonly safeMetadata: JsonValue
}

export interface PhysicalCaptureInput {
  readonly accountId: string
  readonly observedAt?: Date
  readonly sourceTransport?: string
  readonly sourceOrigin: CaptureOrigin
  readonly socketGeneration: string
  readonly sessionGeneration: string
  readonly frameId?: string | null
  readonly providerEventId?: string | null
  readonly transportSequence?: string | null
  readonly opcode?: number | null
  readonly eventType?: string | null
  readonly payloadEncoding: CaptureEnvelope['payloadEncoding']
  readonly payload: unknown
  readonly safeMetadata?: JsonValue
}

export interface SpoolRecord {
  readonly spoolVersion: 1
  readonly sequence: number
  readonly envelope: CaptureEnvelope
  readonly checksum: string
  readonly bytes: number
}

export interface CaptureHealthSnapshot {
  readonly enabled: boolean
  readonly adapterState: CaptureHealthState
  readonly spoolPendingCount: number
  readonly spoolPendingBytes: number
  readonly oldestPendingAgeMs: number | null
  readonly acknowledgedCount: number
  readonly retryCount: number
  readonly rejectedCount: number
  readonly quarantinedCount: number
  readonly lostBeforeSpoolCount: number
  readonly lastSuccessfulJournalAck: string | null
  readonly lastDrainErrorCode: string | null
  readonly captureEnvelopeIdCollisionCount: number
  readonly ingressIdempotentRetryCount: number
}

export interface DurableCaptureSpool {
  appendToSpool(envelope: CaptureEnvelope): SpoolRecord
  readPending(limit: number): readonly SpoolRecord[]
  markAcknowledged(sequence: number): void
  quarantineRecord(sequence: number, reasonCode: string): void
  recoverSpool(): CaptureHealthSnapshot
  compactAcknowledged(): number
  getCaptureHealth(): CaptureHealthSnapshot
  close(): void
}

export interface CaptureIngressResult {
  readonly observationId: string
  readonly created: boolean
}

export interface RawCaptureIngress {
  ingestEnvelope(envelope: CaptureEnvelope): Promise<CaptureIngressResult>
  getCaptureHealth(): Pick<CaptureHealthSnapshot,
    'ingressIdempotentRetryCount' | 'rejectedCount' | 'captureEnvelopeIdCollisionCount'>
}

export interface CaptureDrainResult {
  readonly attempted: number
  readonly acknowledged: number
  readonly retained: number
  readonly nextDelayMs: number
}
