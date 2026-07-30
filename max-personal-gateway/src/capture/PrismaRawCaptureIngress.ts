import { PrismaRawEventJournal, type RawJournalPrismaClient } from '../journal/PrismaRawEventJournal.ts'
import { normalizePostgresSafeJson } from '../journal/sanitizer.ts'
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
    const compatibilityPaths: string[] = []
    const safeText = (value: string | null, path: string): string | null => {
      if (value === null || !value.includes('\u0000')) return value
      compatibilityPaths.push(path)
      return value.replaceAll('\u0000', '\uFFFD')
    }
    const payload = normalizePostgresSafeJson(envelope.sanitizedPayload)
    const safeMetadata = normalizePostgresSafeJson(envelope.safeMetadata)
    compatibilityPaths.push(...payload.paths.map(path => `$.sanitizedPayload${path.slice(1)}`))
    compatibilityPaths.push(...safeMetadata.paths.map(path => `$.safeMetadata${path.slice(1)}`))
    const socketGeneration = safeText(envelope.socketGeneration, '$.socketGeneration')!
    const sessionGeneration = safeText(envelope.sessionGeneration, '$.sessionGeneration')!
    const frameId = safeText(envelope.frameId, '$.frameId')
    const providerEventId = safeText(envelope.providerEventId, '$.providerEventId')
    const transportSequence = safeText(envelope.transportSequence, '$.transportSequence')
    const eventType = safeText(envelope.eventType, '$.eventType')
    const compatibilityApplied = compatibilityPaths.length > 0
    const sanitizerVersion = compatibilityApplied
      ? `${envelope.sanitizerVersion}+postgres-nul-v1`
      : envelope.sanitizerVersion
    const input: SanitizedObservationInput = {
      accountId: envelope.accountId,
      captureEnvelopeId: envelope.captureEnvelopeId,
      observedAt: new Date(envelope.observedAt),
      sourceTransport: envelope.sourceTransport,
      sourceOrigin: 'physical-frame',
      historyLive: envelope.sourceOrigin,
      socketGeneration,
      frameId: frameId ?? undefined,
      providerEventId: providerEventId ?? undefined,
      transportSequence: transportSequence ?? undefined,
      opcode: envelope.opcode ?? undefined,
      eventType: eventType ?? undefined,
      payloadEncoding: envelope.payloadEncoding,
      sanitizedPayload: payload.value,
      payloadSha256: payload.changed ? payload.payloadSha256 : envelope.payloadSha256,
      payloadSizeBytes: payload.changed ? payload.payloadSizeBytes : envelope.payloadSizeBytes,
      replayAvailability: envelope.replayAvailability,
      quarantineReason: envelope.quarantineReason ?? undefined,
      sanitizerVersion,
      captureAdapterVersion: envelope.captureAdapterVersion,
      schemaVersion: envelope.captureEnvelopeVersion,
      correlationMetadata: {
        sessionGeneration,
        capturedAt: envelope.capturedAt,
        retryCount: envelope.retryCount,
        safeMetadata: safeMetadata.value,
        ...(compatibilityApplied ? {
          sourcePayloadSha256: envelope.payloadSha256,
          postgresNulReplacementPaths: [...new Set(compatibilityPaths)].sort(),
        } : {}),
      },
      redactionMetadata: {
        sanitizerVersion,
        categories: [...new Set([
          ...envelope.redactionMetadata.categories,
          ...(compatibilityApplied ? ['postgres_nul_replacement'] : []),
        ])].sort(),
        paths: [...new Set([...envelope.redactionMetadata.paths, ...compatibilityPaths])].sort(),
      },
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
