import { randomUUID } from 'node:crypto'
import { sanitizeRawObservationPayload } from '../journal/sanitizer.ts'
import { CaptureError } from './errors.ts'
import {
  CAPTURE_ADAPTER_VERSION,
  CAPTURE_ENVELOPE_VERSION,
  type CaptureEnvelope,
  type PhysicalCaptureInput,
} from './types.ts'

export interface CaptureEnvelopeFactoryOptions {
  readonly idGenerator?: () => string
  readonly clock?: () => Date
}

function exact(value: string, field: string): void {
  if (value.length === 0 || value !== value.trim() || value.length > 128) {
    throw new CaptureError('INVALID_CAPTURE_ENVELOPE', `${field} must be an exact bounded value`)
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

export class CaptureEnvelopeFactory {
  readonly #idGenerator: () => string
  readonly #clock: () => Date

  constructor(options: CaptureEnvelopeFactoryOptions = {}) {
    this.#idGenerator = options.idGenerator ?? randomUUID
    this.#clock = options.clock ?? (() => new Date())
  }

  createEnvelope(input: PhysicalCaptureInput): CaptureEnvelope {
    exact(input.accountId, 'accountId')
    exact(input.socketGeneration, 'socketGeneration')
    exact(input.sessionGeneration, 'sessionGeneration')
    const observedAt = input.observedAt ?? this.#clock()
    const capturedAt = this.#clock()
    if (!Number.isFinite(observedAt.valueOf()) || !Number.isFinite(capturedAt.valueOf())) {
      throw new CaptureError('INVALID_CAPTURE_ENVELOPE', 'capture timestamps must be valid')
    }
    const sanitized = sanitizeRawObservationPayload(input.payload)
    const envelope: CaptureEnvelope = {
      captureEnvelopeId: this.#idGenerator(),
      captureEnvelopeVersion: CAPTURE_ENVELOPE_VERSION,
      accountId: input.accountId,
      observedAt: observedAt.toISOString(),
      sourceTransport: input.sourceTransport ?? 'max_websocket',
      sourceOrigin: input.sourceOrigin,
      socketGeneration: input.socketGeneration,
      sessionGeneration: input.sessionGeneration,
      frameId: input.frameId ?? null,
      providerEventId: input.providerEventId ?? null,
      transportSequence: input.transportSequence ?? null,
      opcode: input.opcode ?? null,
      eventType: input.eventType ?? null,
      payloadEncoding: input.payloadEncoding,
      sanitizedPayload: sanitized.sanitizedPayload,
      payloadSha256: sanitized.payloadSha256,
      payloadSizeBytes: sanitized.payloadSizeBytes,
      replayAvailability: sanitized.replayAvailability,
      quarantineReason: sanitized.quarantineReason ?? null,
      redactionMetadata: sanitized.redactionMetadata,
      sanitizerVersion: sanitized.sanitizerVersion,
      captureAdapterVersion: CAPTURE_ADAPTER_VERSION,
      capturedAt: capturedAt.toISOString(),
      retryCount: 0,
      safeMetadata: input.safeMetadata ?? {},
    }
    return deepFreeze(envelope)
  }
}
