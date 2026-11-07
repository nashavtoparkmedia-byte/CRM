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

/**
 * Conflict types that prove the Contact's person relationship is unresolved.
 * While one of these is open, no confirmed name may be displayed for the whole
 * Contact: the open question is which person this Contact is.
 */
const CONFIRMED_PERSON_BLOCKING_CONFLICT_TYPES_V1: readonly string[] = [
  'confirmed_driver_cluster_contradiction',
  'fleet_authoritative_person_contradiction',
]

const CONFIRMED_PERSON_NAME_MAX_LENGTH_V1 = 200

/**
 * A structurally usable person name, or null.
 *
 * The value reaches storage from scraped park pages, so it is bounded and
 * screened for ASCII control characters rather than trusted. Display
 * suitability is NOT decided here: whether a name is a technical provider
 * placeholder belongs to ContactDisplayPolicy, which owns every display rule.
 */
function confirmedPersonNameCandidateV1(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > CONFIRMED_PERSON_NAME_MAX_LENGTH_V1) return null
  return /[\u0000-\u001F\u007F]/u.test(trimmed) ? null : trimmed
}

/** An exact-form stored identifier: a non-empty string carrying no surrounding whitespace. */
function exactStoredIdV1(value: unknown): string | null {
  return typeof value === 'string' && value !== '' && value.trim() === value ? value : null
}

/**
 * The confirmed person name this Contact owns, or null.
 *
 * The authority is the operator's recorded decision, not a live foreign row:
 * `driverConfirmations[].evidenceSnapshot` froze the evidence the operator saw
 * at confirmation time, and this accessor only reads it back. Nothing here
 * queries Driver, Fleet, Chat or provider state, and `mainDriverId` is
 * deliberately not consulted — that column is a legacy Fleet relationship that
 * gates Driver-facing writes (see isContactConfirmedMainDriverV1), not a
 * display fact.
 *
 * It fails closed to null on every ambiguity: an unresolved reconciliation, an
 * open person contradiction, two different confirmed people, a snapshot that
 * does not contain the confirmed representative, or two spellings of the name.
 * Choosing between disagreeing evidence silently would invent a person.
 */
export function confirmedPersonNameV1(customFields: unknown): string | null {
  const fields = jsonRecord(customFields)
  const stored = fields.driverConfirmations
  if (!Array.isArray(stored)) return null

  const conflicts = fields.identityConflicts
  const contradicted = Array.isArray(conflicts) && conflicts.some(item => {
    const conflict = jsonRecord(item)
    return conflict.status === 'open'
      && typeof conflict.conflictType === 'string'
      && CONFIRMED_PERSON_BLOCKING_CONFLICT_TYPES_V1.includes(conflict.conflictType)
  })
  if (contradicted) return null

  const records = stored.map(jsonRecord)
  // A pending pair reconciliation means the person question is still open for
  // this Contact, whichever record it belongs to.
  if (records.some(record => record.status === 'needs_reconciliation')) return null

  // Contradicted and revoked records are not name sources and are ignored: the
  // live decision is carried only by the confirmed ones.
  const confirmed = records.filter(record => record.status === 'confirmed')
  if (confirmed.length === 0) return null

  const representatives = new Set<string>()
  for (const record of confirmed) {
    const representative = exactStoredIdV1(record.representativeDriverId)
    // A confirmed record without a usable representative cannot be proven to be
    // about the same person as its siblings, so it suppresses rather than being
    // skipped.
    if (representative === null) return null
    representatives.add(representative)
  }
  if (representatives.size !== 1) return null
  const [representative] = representatives

  const names = new Set<string>()
  for (const record of confirmed) {
    const snapshot = record.evidenceSnapshot
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null
    const profiles = jsonRecord(snapshot).profiles
    if (!Array.isArray(profiles)) return null
    const representativeProfiles = profiles
      .map(jsonRecord)
      .filter(profile => profile.driverId === representative)
    if (representativeProfiles.length === 0) return null
    for (const profile of representativeProfiles) {
      const name = confirmedPersonNameCandidateV1(profile.fullName)
      if (name === null) return null
      names.add(name)
    }
  }
  // Profiles of other drivers in the same cluster may spell their own names
  // differently; the representative's name may not disagree with itself.
  return names.size === 1 ? [...names][0] : null
}

// providerAccountMatches was deliberately REMOVED, not merely left uncalled.
// Comparing a stored provider-account stamp to an inbound one was an
// authorization boundary with no authority behind it: every available value
// names a mutable application transport slot rather than a provider-issued
// account, and no production identity carries the stamp at all. Reintroducing
// the helper would let that boundary return silently. identityEvidenceState
// still exposes providerAccountId as telemetry and future migration metadata.
// See docs/design/provider-account-identity-v1.md.
