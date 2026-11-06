// The Fleet Operations handler behind fleet_operations.DriverProfilesForContactsQuery.v1.
//
// It reads persisted Driver rows through an injected port and projects them into
// the bounded contract shape. It never calls a park, never reconciles, never
// writes, and never decides which person a row is: `linkBasis` reports the stored
// relationship the row was matched by and `personResolutionStatus` reports Fleet's
// own recorded resolution state. Every asked subject gets an entry, in the asked
// order, even when it has no profile.
import {
  DRIVER_PROFILE_RESOLUTION_STATES_V1,
  DRIVER_PROFILES_FOR_CONTACTS_RESULT_V1,
  parseDriverProfilesForContactsQueryV1,
  type DriverProfileForContactV1,
  type DriverProfileLinkBasisV1,
  type DriverProfileResolutionStateV1,
  type DriverProfilesForContactsQueryV1,
  type DriverProfilesForContactsResultV1,
} from '../../../../contracts/fleet-operations/v1'
import { driverFleetEvidenceState } from './driver-fleet-evidence'

/** One persisted Driver row as the port returns it. Fleet-owned columns only. */
export interface DriverProfileRowV1 {
  id: string
  contactId: string | null
  yandexDriverId: string | null
  externalParkId: string | null
  externalDriverProfileId: string | null
  parkName: string | null
  fullName: string
  personResolutionStatus: string | null
  personKeyType: string | null
  customFields: unknown
  segment: string | null
  dismissedAt: Date | string | null
}

export interface DriverProfilesForContactsPersistencePortV1 {
  /**
   * Every Driver row whose `contactId` is one of `contactIds` or whose
   * `yandexDriverId` is one of `yandexDriverIds`. One bounded read, no write.
   */
  findDriverProfiles(input: {
    contactIds: readonly string[]
    yandexDriverIds: readonly string[]
  }): Promise<DriverProfileRowV1[]>
}

function resolutionState(value: unknown): DriverProfileResolutionStateV1 {
  return typeof value === 'string' && (DRIVER_PROFILE_RESOLUTION_STATES_V1 as readonly string[]).includes(value)
    ? value as DriverProfileResolutionStateV1
    : 'unknown'
}

function isoOrNull(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function compareProfiles(left: DriverProfileForContactV1, right: DriverProfileForContactV1): number {
  const keys: Array<[string, string]> = [
    [left.parkName ?? '', right.parkName ?? ''],
    [left.externalParkId ?? '', right.externalParkId ?? ''],
    [left.externalDriverProfileId ?? '', right.externalDriverProfileId ?? ''],
    [left.driverId, right.driverId],
  ]
  for (const [a, b] of keys) {
    // Code-point order, never locale order: the same person always lists the same way.
    if (a !== b) return a < b ? -1 : 1
  }
  return 0
}

export function projectDriverProfileForContactV1(
  row: DriverProfileRowV1,
  linkBasis: DriverProfileLinkBasisV1,
): DriverProfileForContactV1 {
  const evidence = driverFleetEvidenceState(row.customFields)
  return {
    driverId: row.id,
    linkBasis,
    externalParkId: text(row.externalParkId),
    externalDriverProfileId: text(row.externalDriverProfileId),
    parkName: text(row.parkName),
    fullName: typeof row.fullName === 'string' ? row.fullName : '',
    personResolutionStatus: resolutionState(row.personResolutionStatus),
    personKeyType: text(row.personKeyType),
    sourceFreshness: evidence.sourceFreshness,
    sourceState: evidence.sourceState,
    lastObservedAt: evidence.lastObservedAt,
    legalRole: evidence.legalRole,
    workStatus: evidence.workStatus,
    currentStatus: evidence.currentStatus,
    segment: text(row.segment),
    dismissedAt: isoOrNull(row.dismissedAt),
  }
}

export function createDriverProfilesForContactsHandlerV1(port: DriverProfilesForContactsPersistencePortV1) {
  return async function readDriverProfilesForContactsV1(
    query: DriverProfilesForContactsQueryV1 | unknown,
  ): Promise<DriverProfilesForContactsResultV1> {
    const parsed = parseDriverProfilesForContactsQueryV1(query)
    const contactIds = parsed.subjects.map(subject => subject.contactId)
    const yandexDriverIds = parsed.subjects
      .map(subject => subject.legacyYandexDriverId)
      .filter((id): id is string => id !== null)
    const rows = await port.findDriverProfiles({ contactIds, yandexDriverIds })
    const entries = parsed.subjects.map(subject => {
      const profiles: DriverProfileForContactV1[] = []
      for (const row of rows) {
        const byContact = row.contactId === subject.contactId
        const byLegacy = subject.legacyYandexDriverId !== null && row.yandexDriverId === subject.legacyYandexDriverId
        if (!byContact && !byLegacy) continue
        profiles.push(projectDriverProfileForContactV1(row, byContact && byLegacy ? 'both' : byContact ? 'contact_link' : 'legacy_yandex_link'))
      }
      profiles.sort(compareProfiles)
      return { contactId: subject.contactId, profiles }
    })
    return { contract: DRIVER_PROFILES_FOR_CONTACTS_RESULT_V1, entries }
  }
}
