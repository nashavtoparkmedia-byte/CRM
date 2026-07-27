import { PrismaRawEventJournal, type RawJournalPrismaClient } from '../journal/PrismaRawEventJournal.ts'
import type { SanitizedObservationInput } from '../journal/types.ts'
import { CaptureError } from './errors.ts'
import { CAPTURE_PARSER_VERSION, type CaptureEnvelope, type CaptureIngressResult, type RawCaptureIngress } from './types.ts'

export class PrismaRawCaptureIngress implements RawCaptureIngress {
  readonly #journal: PrismaRawEventJournal
  #idempotentRetries = 0
  #rejected = 0
  #collisions = 0

  constructor(client: RawJournalPrismaClient) {
    this.#journal = new PrismaRawEventJournal(client)
  }

  async ingestEnvelope(envelope: CaptureEnvelope): Promise<CaptureIngressResult> {
    if (envelope.captureEnvelopeVersion !== 1 || envelope.captureEnvelopeId.length === 0) {
      this.#rejected += 1
      throw new CaptureError('INGRESS_REJECTED', 'Capture envelope version or identity is invalid')
    }
    const input: SanitizedObservationInput = {
      accountId: envelope.accountId,
      captureEnvelopeId: envelope.captureEnvelopeId,
      observedAt: new Date(envelope.observedAt),
      sourceTransport: envelope.sourceTransport,
      sourceOrigin: 'physical-frame',
      historyLive: envelope.sourceOrigin,
      socketGeneration: envelope.socketGeneration,
      frameId: envelope.frameId ?? undefined,
      providerEventId: envelope.providerEventId ?? undefined,
      transportSequence: envelope.transportSequence ?? undefined,
      opcode: envelope.opcode ?? undefined,
      eventType: envelope.eventType ?? undefined,
      payloadEncoding: envelope.payloadEncoding,
      sanitizedPayload: envelope.sanitizedPayload,
      payloadSha256: envelope.payloadSha256,
      payloadSizeBytes: envelope.payloadSizeBytes,
      replayAvailability: envelope.replayAvailability,
      quarantineReason: envelope.quarantineReason ?? undefined,
      sanitizerVersion: envelope.sanitizerVersion,
      captureAdapterVersion: envelope.captureAdapterVersion,
      schemaVersion: envelope.captureEnvelopeVersion,
      correlationMetadata: {
        sessionGeneration: envelope.sessionGeneration,
        capturedAt: envelope.capturedAt,
        retryCount: envelope.retryCount,
        safeMetadata: envelope.safeMetadata,
      },
      redactionMetadata: envelope.redactionMetadata,
      quarantineEligible: true,
      parserVersion: CAPTURE_PARSER_VERSION,
    }
    try {
      const result = await this.#journal.appendCapture(input)
      if (result.captureEnvelopeCollision === true) {
        this.#collisions += 1
        this.#rejected += 1
        throw new CaptureError(
          'CAPTURE_ENVELOPE_ID_COLLISION',
          'Capture envelope identity collides with a different physical observation',
        )
      }
      if (!result.created) this.#idempotentRetries += 1
      return result
    } catch (error) {
      if (error instanceof CaptureError) throw error
      this.#rejected += 1
      throw new CaptureError('INGRESS_UNAVAILABLE', 'Capture ingress persistence failed', { cause: error })
    }
  }

  getCaptureHealth() {
    return {
      ingressIdempotentRetryCount: this.#idempotentRetries,
      rejectedCount: this.#rejected,
      captureEnvelopeIdCollisionCount: this.#collisions,
    }
  }
}
