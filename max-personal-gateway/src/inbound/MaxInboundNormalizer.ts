import {
  MAX_NORMALIZED_ENVELOPE_BYTES,
  NORMALIZED_ENVELOPE_VERSION,
} from './constants.ts'
import { InboundNormalizationError } from './errors.ts'
import { canonicalJson, VersionedInboundParserRegistry } from './parserRegistry.ts'
import type {
  InboundNormalizer,
  NormalizationOutcome,
  NormalizeRawObservationInput,
} from './types.ts'

function required(value: string, field: string): void {
  if (value.length === 0 || value !== value.trim()) {
    throw new InboundNormalizationError('INVALID_INPUT', `${field} is required and must be exact`)
  }
}
function quarantined(input: NormalizeRawObservationInput, issueCode: string, summary: string): NormalizationOutcome {
  return {
    status: 'quarantined',
    parserVersion: input.parserVersion,
    envelopeVersion: NORMALIZED_ENVELOPE_VERSION,
    events: [],
    issueCode,
    safeIssueSummary: summary,
  }
}

export class MaxInboundNormalizer implements InboundNormalizer {
  readonly #registry: VersionedInboundParserRegistry
  readonly #maxEnvelopeBytes: number

  constructor(
    registry = new VersionedInboundParserRegistry(),
    maxEnvelopeBytes = MAX_NORMALIZED_ENVELOPE_BYTES,
  ) {
    if (!Number.isSafeInteger(maxEnvelopeBytes) || maxEnvelopeBytes < 1) {
      throw new InboundNormalizationError('INVALID_INPUT', 'maxEnvelopeBytes must be positive')
    }
    this.#registry = registry
    this.#maxEnvelopeBytes = maxEnvelopeBytes
  }

  normalizeRawObservation(input: NormalizeRawObservationInput): NormalizationOutcome {
    required(input.accountId, 'accountId')
    required(input.observationId, 'observationId')
    required(input.sourceTransport, 'sourceTransport')
    required(input.payloadEncoding, 'payloadEncoding')
    required(input.payloadSha256, 'payloadSha256')
    required(input.captureAdapterVersion, 'captureAdapterVersion')
    required(input.parserVersion, 'parserVersion')
    if (input.journalSequence < 0n) throw new InboundNormalizationError('INVALID_INPUT', 'journalSequence must be nonnegative')
    if (!Number.isFinite(input.observedAt.valueOf())) throw new InboundNormalizationError('INVALID_INPUT', 'observedAt must be valid')
    if (input.replayAvailability === 'quarantined') {
      return quarantined(input, 'RAW_PAYLOAD_UNAVAILABLE', 'Raw journal payload is quarantined and unavailable to the parser')
    }

    try {
      const outcome = this.#registry.normalize(input)
      const bytes = Buffer.byteLength(canonicalJson({
        parserVersion: outcome.parserVersion,
        envelopeVersion: outcome.envelopeVersion,
        status: outcome.status,
        events: outcome.events,
      }), 'utf8')
      if (bytes > this.#maxEnvelopeBytes) {
        return quarantined(input, 'NORMALIZED_ENVELOPE_TOO_LARGE', 'Normalized envelope exceeded the safe storage limit')
      }
      return outcome
    } catch (error) {
      if (error instanceof InboundNormalizationError
        && (error.code === 'NORMALIZER_MALFORMED' || error.code === 'NORMALIZER_OVERSIZED')) {
        return quarantined(
          input,
          error.code === 'NORMALIZER_OVERSIZED' ? 'NORMALIZED_ENVELOPE_TOO_LARGE' : 'MALFORMED_PROVIDER_EVENT',
          error.code === 'NORMALIZER_OVERSIZED'
            ? 'Normalized envelope exceeded the safe storage limit'
            : 'Provider event could not be safely normalized',
        )
      }
      throw error
    }
  }
}
