export type ContactPhoneLifecycleV1 = 'current' | 'superseded' | 'removed' | 'unknown'
export type ContactPhoneTrustV1 = 'provider_bound' | 'manually_verified' | 'source_asserted' | 'claimed' | 'unknown'
export type ContactPhoneFreshnessV1 = 'fresh' | 'stale' | 'unknown'
export type ContactPhoneResolutionStateV1 = 'unique' | 'shared' | 'disputed' | 'unknown'

export type ContactPhoneEvidenceStateV1 = {
  rawPhone: string | null
  lifecycle: ContactPhoneLifecycleV1
  trust: ContactPhoneTrustV1
  freshness: ContactPhoneFreshnessV1
  resolutionState: ContactPhoneResolutionStateV1
  verifiedBy: string | null
  verificationBasis: string | null
  observedAt: string | null
  lastSeenAt: string | null
  lifecycleUpdatedAt: string | null
  evidenceRoot: string | null
  auditTrail: unknown[]
}

export type ContactAutomationStateV1 = {
  canonicalPinnedAt: string | null
  canonicalPinnedBy: string | null
  doNotMerge: boolean
  mergedIntoContactId: string | null
  mergeRecoveryState: string | null
}

export type ContactIdentityEvidenceStateV1 = {
  providerAccountId: string
  origin: string
  evidenceRoot: string | null
  conflictState: string
  providerAliasValues: string[]
  providerAliases: unknown[]
}

export function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function enumValue<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === 'string' && values.includes(value as T) ? value as T : fallback
}

export function contactAutomationState(customFields: unknown): ContactAutomationStateV1 {
  const fields = jsonRecord(customFields)
  return {
    canonicalPinnedAt: optionalString(fields.canonicalPinnedAt),
    canonicalPinnedBy: optionalString(fields.canonicalPinnedBy),
    doNotMerge: fields.doNotMerge === true,
    mergedIntoContactId: optionalString(fields.mergedIntoContactId),
    mergeRecoveryState: optionalString(fields.mergeRecoveryState),
  }
}

export function identityEvidenceState(metadata: unknown): ContactIdentityEvidenceStateV1 {
  const value = jsonRecord(metadata)
  return {
    providerAccountId: optionalString(value.providerAccountId) ?? 'legacy',
    origin: optionalString(value.origin) ?? 'legacy',
    evidenceRoot: optionalString(value.evidenceRoot),
    conflictState: optionalString(value.conflictState) ?? 'clear',
    providerAliasValues: Array.isArray(value.providerAliasValues)
      ? value.providerAliasValues.filter((item): item is string => typeof item === 'string')
      : [],
    providerAliases: Array.isArray(value.providerAliases) ? value.providerAliases : [],
  }
}

export function phoneEvidenceByPhoneId(customFields: unknown): Record<string, unknown> {
  return jsonRecord(jsonRecord(customFields).phoneEvidenceByPhoneId)
}

export function phoneEvidenceState(
  customFields: unknown,
  phoneId: string,
  fallback: { phone: string; isActive: boolean; verifiedAt: Date | string | null },
): ContactPhoneEvidenceStateV1 {
  const value = jsonRecord(phoneEvidenceByPhoneId(customFields)[phoneId])
  return {
    rawPhone: optionalString(value.rawPhone) ?? fallback.phone,
    // Legacy rows deliberately remain ineligible for automatic ownership.
    lifecycle: enumValue(value.lifecycle, ['current', 'superseded', 'removed', 'unknown'] as const,
      fallback.isActive ? 'current' : 'removed'),
    trust: enumValue(value.trust, ['provider_bound', 'manually_verified', 'source_asserted', 'claimed', 'unknown'] as const,
      'unknown'),
    freshness: enumValue(value.freshness, ['fresh', 'stale', 'unknown'] as const, 'unknown'),
    resolutionState: enumValue(value.resolutionState, ['unique', 'shared', 'disputed', 'unknown'] as const,
      'unknown'),
    verifiedBy: optionalString(value.verifiedBy),
    verificationBasis: optionalString(value.verificationBasis),
    observedAt: optionalString(value.observedAt),
    lastSeenAt: optionalString(value.lastSeenAt),
    lifecycleUpdatedAt: optionalString(value.lifecycleUpdatedAt),
    evidenceRoot: optionalString(value.evidenceRoot),
    auditTrail: Array.isArray(value.auditTrail) ? value.auditTrail : [],
  }
}

export function withPhoneEvidence(
  customFields: unknown,
  phoneId: string,
  evidence: ContactPhoneEvidenceStateV1,
): Record<string, unknown> {
  const fields = jsonRecord(customFields)
  return {
    ...fields,
    phoneEvidenceByPhoneId: {
      ...phoneEvidenceByPhoneId(fields),
      [phoneId]: evidence,
    },
  }
}

export function withoutPhoneEvidence(customFields: unknown, phoneIds: readonly string[]): Record<string, unknown> {
  const fields = jsonRecord(customFields)
  const map = { ...phoneEvidenceByPhoneId(fields) }
  for (const id of phoneIds) delete map[id]
  return { ...fields, phoneEvidenceByPhoneId: map }
}

export function providerAccountMatches(metadata: unknown, requested: string): boolean {
  const stored = identityEvidenceState(metadata).providerAccountId
  return stored === requested
}
