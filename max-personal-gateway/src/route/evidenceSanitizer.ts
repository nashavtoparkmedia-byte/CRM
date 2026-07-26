import { sanitizeRawObservationPayload } from '../journal/sanitizer.ts'
import type { JsonValue } from '../journal/types.ts'
import type { RouteEvidenceEnvelope } from './types.ts'

export const MAX_ROUTE_EVIDENCE_SIZE_LIMIT_BYTES = 64 * 1024

export function sanitizeRouteEvidence(
  input: unknown,
  maxBytes = MAX_ROUTE_EVIDENCE_SIZE_LIMIT_BYTES,
): RouteEvidenceEnvelope {
  const sanitized = sanitizeRawObservationPayload(input)
  if (sanitized.payloadSizeBytes <= maxBytes) {
    return {
      sanitizedEvidence: sanitized.sanitizedPayload,
      evidenceSha256: sanitized.payloadSha256,
      evidenceSizeBytes: sanitized.payloadSizeBytes,
      evidenceQuarantined: sanitized.replayAvailability === 'quarantined',
      redactionMetadata: sanitized.redactionMetadata,
    }
  }

  const envelope: JsonValue = {
    $routeEvidenceQuarantine: {
      reason: 'sanitized_evidence_too_large',
      sanitizedSizeBytes: sanitized.payloadSizeBytes,
      sanitizedEvidenceSha256: sanitized.payloadSha256,
      evidenceStored: false,
    },
  }
  return {
    sanitizedEvidence: envelope,
    evidenceSha256: sanitized.payloadSha256,
    evidenceSizeBytes: sanitized.payloadSizeBytes,
    evidenceQuarantined: true,
    redactionMetadata: {
      sanitizerVersion: sanitized.redactionMetadata.sanitizerVersion,
      categories: [...new Set([...sanitized.redactionMetadata.categories, 'oversized_route_evidence'])].sort(),
      paths: [...new Set([...sanitized.redactionMetadata.paths, '$'])].sort(),
    },
  }
}
