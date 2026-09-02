export const CONFIRM_DRIVER_PERSON_COMMAND_V1 = 'contacts.ConfirmDriverPersonCommand.v1' as const
export const RECONCILE_DRIVER_CLUSTER_COMMAND_V1 = 'contacts.ReconcileDriverClusterCommand.v1' as const

export type DriverClusterProfileEvidenceV1 = {
  driverId: string
  externalParkId: string
  externalDriverProfileId: string
  fullName: string
  phones: string[]
  normalizedVu: string | null
  evidenceRoot: string
  sourceFreshness: 'fresh' | 'stale' | 'unknown'
  legalRole?: string | null
  status?: string | null
  workStatus?: string | null
  currentStatus?: string | null
  city?: string | null
  profileType?: string | null
  rawVu?: string | null
  sourceDates?: Record<string, string | null>
}

export type ConfirmDriverPersonCommandV1 = {
  contract: typeof CONFIRM_DRIVER_PERSON_COMMAND_V1
  contactId: string
  profileClusterKey: string
  representativeDriverId: string
  confirmedBy: string
  confirmationBasis: 'fio' | 'phone' | 'vu'
  searchInput: string
  evidenceSnapshot: {
    profiles: DriverClusterProfileEvidenceV1[]
    warnings: string[]
  }
}

export type ReconcileDriverClusterCommandV1 = {
  contract: typeof RECONCILE_DRIVER_CLUSTER_COMMAND_V1
  profileClusterKey: string
  profiles: DriverClusterProfileEvidenceV1[]
}

export class DriverPersonCommandValidationError extends Error {
  readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'

  constructor(code: DriverPersonCommandValidationError['code'], message: string) {
    super(message)
    this.name = 'DriverPersonCommandValidationError'
    this.code = code
  }
}

function invalid(message: string): never {
  throw new DriverPersonCommandValidationError('INVALID_CONTRACT', message)
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${field} must be an object`)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) invalid(`${field} must be a plain object`)
  return value as Record<string, unknown>
}

function exactFields(value: Record<string, unknown>, supported: readonly string[], field: string): void {
  const extra = Object.keys(value).filter(key => !supported.includes(key))
  if (extra.length > 0) invalid(`unsupported ${field} field(s): ${extra.sort().join(', ')}`)
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) invalid(`${field} must be a non-empty string`)
  return value
}

function nullableText(value: unknown, field: string): string | null {
  if (value === null) return null
  return text(value, field)
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) {
    invalid(`${field} must be an array of non-empty strings`)
  }
  return value as string[]
}

function parseSourceDates(value: unknown, field: string): Record<string, string | null> {
  const sourceDates = record(value, field)
  for (const [key, item] of Object.entries(sourceDates)) {
    if (!key.trim() || (item !== null && typeof item !== 'string')) {
      invalid(`${field} must contain only string or null values`)
    }
  }
  return sourceDates as Record<string, string | null>
}

function parseProfile(input: unknown, field: string): DriverClusterProfileEvidenceV1 {
  const value = record(input, field)
  exactFields(value, [
    'driverId',
    'externalParkId',
    'externalDriverProfileId',
    'fullName',
    'phones',
    'normalizedVu',
    'evidenceRoot',
    'sourceFreshness',
    'legalRole',
    'status',
    'workStatus',
    'currentStatus',
    'city',
    'profileType',
    'rawVu',
    'sourceDates',
  ], field)
  text(value.driverId, `${field}.driverId`)
  text(value.externalParkId, `${field}.externalParkId`)
  text(value.externalDriverProfileId, `${field}.externalDriverProfileId`)
  text(value.fullName, `${field}.fullName`)
  stringArray(value.phones, `${field}.phones`)
  nullableText(value.normalizedVu, `${field}.normalizedVu`)
  text(value.evidenceRoot, `${field}.evidenceRoot`)
  if (typeof value.sourceFreshness !== 'string'
    || !['fresh', 'stale', 'unknown'].includes(value.sourceFreshness)) {
    invalid(`${field}.sourceFreshness is unsupported`)
  }
  for (const optional of [
    'legalRole', 'status', 'workStatus', 'currentStatus', 'city', 'profileType', 'rawVu',
  ] as const) {
    if (value[optional] !== undefined) nullableText(value[optional], `${field}.${optional}`)
  }
  if (value.sourceDates !== undefined) parseSourceDates(value.sourceDates, `${field}.sourceDates`)
  return value as unknown as DriverClusterProfileEvidenceV1
}

function parseProfiles(value: unknown, field: string): DriverClusterProfileEvidenceV1[] {
  if (!Array.isArray(value)) invalid(`${field} must be an array`)
  return value.map((profile, index) => parseProfile(profile, `${field}[${index}]`))
}

function clusterKeyForProfile(profile: DriverClusterProfileEvidenceV1): string {
  return profile.normalizedVu
    ? `vu:${profile.normalizedVu}`
    : `profile:${profile.externalParkId}:${profile.externalDriverProfileId}`
}

function assertContract(
  value: Record<string, unknown>,
  expected: string,
  versionPrefix: string,
): void {
  if (value.contract === expected) return
  if (typeof value.contract === 'string' && value.contract.startsWith(versionPrefix)) {
    throw new DriverPersonCommandValidationError(
      'UNSUPPORTED_CONTRACT_VERSION',
      `unsupported contract version: ${value.contract}`,
    )
  }
  invalid(`contract must equal ${expected}`)
}

export function parseConfirmDriverPersonCommandV1(input: unknown): ConfirmDriverPersonCommandV1 {
  const value = record(input, 'command')
  assertContract(value, CONFIRM_DRIVER_PERSON_COMMAND_V1, 'contacts.ConfirmDriverPersonCommand.')
  exactFields(value, [
    'contract',
    'contactId',
    'profileClusterKey',
    'representativeDriverId',
    'confirmedBy',
    'confirmationBasis',
    'searchInput',
    'evidenceSnapshot',
  ], 'command')
  text(value.contactId, 'contactId')
  const profileClusterKey = text(value.profileClusterKey, 'profileClusterKey')
  const representativeDriverId = text(value.representativeDriverId, 'representativeDriverId')
  text(value.confirmedBy, 'confirmedBy')
  if (typeof value.confirmationBasis !== 'string'
    || !['fio', 'phone', 'vu'].includes(value.confirmationBasis)) {
    invalid('confirmationBasis is unsupported')
  }
  text(value.searchInput, 'searchInput')
  const snapshot = record(value.evidenceSnapshot, 'evidenceSnapshot')
  exactFields(snapshot, ['profiles', 'warnings'], 'evidenceSnapshot')
  const profiles = parseProfiles(snapshot.profiles, 'evidenceSnapshot.profiles')
  if (profiles.length === 0) {
    invalid('evidenceSnapshot.profiles must contain authoritative evidence')
  }
  if (profiles.some(profile => profile.sourceFreshness !== 'fresh')) {
    invalid('evidenceSnapshot.profiles must contain only fresh evidence')
  }
  if (profiles.some(profile => clusterKeyForProfile(profile) !== profileClusterKey)) {
    invalid('profileClusterKey must match every evidenceSnapshot profile')
  }
  if (!profiles.some(profile => profile.driverId === representativeDriverId)) {
    invalid('representativeDriverId must belong to evidenceSnapshot.profiles')
  }
  stringArray(snapshot.warnings, 'evidenceSnapshot.warnings')
  return value as unknown as ConfirmDriverPersonCommandV1
}

export function parseReconcileDriverClusterCommandV1(input: unknown): ReconcileDriverClusterCommandV1 {
  const value = record(input, 'command')
  assertContract(value, RECONCILE_DRIVER_CLUSTER_COMMAND_V1, 'contacts.ReconcileDriverClusterCommand.')
  exactFields(value, ['contract', 'profileClusterKey', 'profiles'], 'command')
  text(value.profileClusterKey, 'profileClusterKey')
  parseProfiles(value.profiles, 'profiles')
  return value as unknown as ReconcileDriverClusterCommandV1
}
