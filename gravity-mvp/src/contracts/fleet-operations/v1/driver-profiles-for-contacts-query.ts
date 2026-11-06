// fleet_operations.DriverProfilesForContactsQuery.v1 — the persisted Yandex driver
// profiles Fleet Operations holds for one or more canonical Contacts.
//
// Read-only and persisted: it answers from the Driver rows Fleet already owns and
// makes no park, scraper or provider call. It exists so a Contacts-composed person
// card can show every park profile of one person without Contacts copying Fleet
// data: Contacts says which Contact ids (its lineage) and, for the legacy link,
// which Yandex driver id belong to the person; Fleet answers with its own rows.
//
// Which Contact a Driver belongs to is NOT decided here. `linkBasis` only reports
// the stored relationship the row was matched by, and `personResolutionStatus` is
// Fleet's own recorded resolution state, carried as a bounded enum. Whether the
// person is confirmed is Contacts' evidence, not this contract's.
export const DRIVER_PROFILES_FOR_CONTACTS_QUERY_V1 = 'fleet_operations.DriverProfilesForContactsQuery.v1' as const
export const DRIVER_PROFILES_FOR_CONTACTS_RESULT_V1 = 'fleet_operations.DriverProfilesForContactsResult.v1' as const

/** At most this many Contacts in one query; the composition asks for one lineage at a time. */
export const DRIVER_PROFILES_FOR_CONTACTS_MAX_CONTACTS_V1 = 25

/** One asked Contact: its exact id and, when Contacts holds one, its legacy Yandex driver link. */
export interface DriverProfilesForContactsSubjectV1 {
  contactId: string
  legacyYandexDriverId: string | null
}

export interface DriverProfilesForContactsQueryV1 {
  contract: typeof DRIVER_PROFILES_FOR_CONTACTS_QUERY_V1
  /** 1..25 subjects with distinct, exact Contact ids. The answer has one entry per subject, in this order. */
  subjects: DriverProfilesForContactsSubjectV1[]
}

/** Fleet's recorded person-resolution state of one Driver row, bounded. */
export const DRIVER_PROFILE_RESOLUTION_STATES_V1 = [
  'operator_confirmed',
  'vu_clustered',
  'vu_observed',
  'unlinked',
  'conflict',
  'unknown',
] as const
export type DriverProfileResolutionStateV1 = typeof DRIVER_PROFILE_RESOLUTION_STATES_V1[number]

/** Which stored relationship matched the row to the asked Contact. */
export type DriverProfileLinkBasisV1 = 'contact_link' | 'legacy_yandex_link' | 'both'

export interface DriverProfileForContactV1 {
  driverId: string
  linkBasis: DriverProfileLinkBasisV1
  externalParkId: string | null
  externalDriverProfileId: string | null
  parkName: string | null
  fullName: string
  personResolutionStatus: DriverProfileResolutionStateV1
  /** `normalized_vu` when the row is clustered by a driving licence; the licence itself never crosses. */
  personKeyType: string | null
  sourceFreshness: 'fresh' | 'stale' | 'unknown'
  sourceState: 'current' | 'stale' | 'failed' | 'unknown'
  lastObservedAt: string | null
  legalRole: string | null
  workStatus: string | null
  currentStatus: string | null
  segment: string | null
  dismissedAt: string | null
}

export interface DriverProfilesForContactEntryV1 {
  contactId: string
  /** Ordered by park name, then external park id, then external profile id, then driver id. */
  profiles: DriverProfileForContactV1[]
}

export interface DriverProfilesForContactsResultV1 {
  contract: typeof DRIVER_PROFILES_FOR_CONTACTS_RESULT_V1
  entries: DriverProfilesForContactEntryV1[]
}

export class DriverProfilesForContactsQueryValidationError extends Error {
  readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'
  constructor(code: DriverProfilesForContactsQueryValidationError['code'], message: string) {
    super(message)
    this.name = 'DriverProfilesForContactsQueryValidationError'
    this.code = code
  }
}

function invalid(message: string): never {
  throw new DriverProfilesForContactsQueryValidationError('INVALID_CONTRACT', message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** An exact stored identifier: non-empty, with no surrounding whitespace. */
function exactId(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value.trim() === value
}

export function parseDriverProfilesForContactsQueryV1(input: unknown): DriverProfilesForContactsQueryV1 {
  if (!isRecord(input)) invalid('query must be an object')
  const extraFields = Object.keys(input).filter(key => key !== 'contract' && key !== 'subjects')
  if (extraFields.length > 0) invalid(`unsupported field(s): ${extraFields.sort().join(', ')}`)
  if (input.contract !== DRIVER_PROFILES_FOR_CONTACTS_QUERY_V1) {
    if (typeof input.contract === 'string' && input.contract.startsWith('fleet_operations.DriverProfilesForContactsQuery.')) {
      throw new DriverProfilesForContactsQueryValidationError(
        'UNSUPPORTED_CONTRACT_VERSION',
        `unsupported contract version: ${input.contract}`,
      )
    }
    invalid(`contract must equal ${DRIVER_PROFILES_FOR_CONTACTS_QUERY_V1}`)
  }
  if (!Array.isArray(input.subjects) || input.subjects.length === 0) invalid('subjects must be a non-empty array')
  if (input.subjects.length > DRIVER_PROFILES_FOR_CONTACTS_MAX_CONTACTS_V1) {
    invalid(`subjects must not exceed ${DRIVER_PROFILES_FOR_CONTACTS_MAX_CONTACTS_V1}`)
  }
  const seen = new Set<string>()
  const subjects: DriverProfilesForContactsSubjectV1[] = []
  for (const subject of input.subjects) {
    if (!isRecord(subject)) invalid('each subject must be an object')
    const subjectExtra = Object.keys(subject).filter(key => key !== 'contactId' && key !== 'legacyYandexDriverId')
    if (subjectExtra.length > 0) invalid(`unsupported subject field(s): ${subjectExtra.sort().join(', ')}`)
    if (!exactId(subject.contactId)) invalid('subject.contactId must be an exact, non-empty Contact id')
    if (seen.has(subject.contactId)) invalid('subject contact ids must be distinct')
    seen.add(subject.contactId)
    const legacy = subject.legacyYandexDriverId
    if (legacy !== undefined && legacy !== null && !exactId(legacy)) {
      invalid('subject.legacyYandexDriverId must be null or an exact, non-empty id')
    }
    subjects.push({ contactId: subject.contactId, legacyYandexDriverId: exactId(legacy) ? legacy : null })
  }
  return { contract: DRIVER_PROFILES_FOR_CONTACTS_QUERY_V1, subjects }
}
