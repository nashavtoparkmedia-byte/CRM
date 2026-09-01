export type DriverFleetEvidenceV1 = {
  legalRole: string | null
  sourceStatus: string | null
  sourceCity: string | null
  sourceProfileType: string | null
  sourcePhones: string[]
  sourceDates: Record<string, string | null>
  lastObservedAt: string | null
  lastSynchronizedAt: string | null
  sourceFreshness: 'fresh' | 'stale' | 'unknown'
  sourceState: 'current' | 'stale' | 'failed' | 'unknown'
  sourceMetadata: Record<string, unknown>
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

export function driverFleetEvidenceState(customFields: unknown): DriverFleetEvidenceV1 {
  const value = record(record(customFields).fleetSource)
  const freshness = value.sourceFreshness
  const state = value.sourceState
  return {
    legalRole: text(value.legalRole),
    sourceStatus: text(value.sourceStatus),
    sourceCity: text(value.sourceCity),
    sourceProfileType: text(value.sourceProfileType),
    sourcePhones: Array.isArray(value.sourcePhones)
      ? value.sourcePhones.filter((item): item is string => typeof item === 'string')
      : [],
    sourceDates: Object.fromEntries(Object.entries(record(value.sourceDates)).map(([key, item]) => [
      key,
      typeof item === 'string' ? item : null,
    ])),
    lastObservedAt: text(value.lastObservedAt),
    lastSynchronizedAt: text(value.lastSynchronizedAt),
    sourceFreshness: freshness === 'fresh' || freshness === 'stale' ? freshness : 'unknown',
    sourceState: state === 'current' || state === 'stale' || state === 'failed' ? state : 'unknown',
    sourceMetadata: record(value.sourceMetadata),
  }
}

export function withDriverFleetEvidence(
  customFields: unknown,
  evidence: DriverFleetEvidenceV1,
): Record<string, unknown> {
  const fields = record(customFields)
  return { ...fields, fleetSource: evidence }
}
