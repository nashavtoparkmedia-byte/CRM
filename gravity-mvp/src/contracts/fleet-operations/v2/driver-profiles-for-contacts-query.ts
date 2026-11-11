// fleet_operations.DriverProfilesForContactsQuery.v2 — v1 plus the driving
// licence (ВУ), shown only as the caller's `licenceView` allows (Owner D2, OD-03).
//
// v1 stays unchanged beside it and still carries no licence. v2 differs in two
// ways only:
// - the query REQUIRES `licenceView`, Contacts' ContactReadAuthorityQuery.v1
//   answer for this request, passed on unchanged; there is no default view;
// - every profile carries `licence`: the stored licence in full for 'full', its
//   last four characters for 'last4', or null when Fleet holds none.
// Subjects, bounds, ordering and every other profile field are v1's.
import {
  DRIVER_PROFILES_FOR_CONTACTS_QUERY_V1,
  isDriverLicenceViewV1,
  parseDriverProfilesForContactsQueryV1,
  type DriverLicenceViewV1,
  type DriverProfileForContactV1,
  type DriverProfilesForContactsSubjectV1,
} from '../v1'

export const DRIVER_PROFILES_FOR_CONTACTS_QUERY_V2 = 'fleet_operations.DriverProfilesForContactsQuery.v2' as const
export const DRIVER_PROFILES_FOR_CONTACTS_RESULT_V2 = 'fleet_operations.DriverProfilesForContactsResult.v2' as const

export interface DriverProfilesForContactsQueryV2 {
  contract: typeof DRIVER_PROFILES_FOR_CONTACTS_QUERY_V2
  licenceView: DriverLicenceViewV1
  /** As v1: 1..25 subjects with distinct, exact Contact ids, answered in this order. */
  subjects: DriverProfilesForContactsSubjectV1[]
}

export interface DriverProfileForContactV2 extends DriverProfileForContactV1 {
  /** The stored licence as `licenceView` allows, or null. */
  licence: string | null
}

export interface DriverProfilesForContactEntryV2 {
  contactId: string
  profiles: DriverProfileForContactV2[]
}

export interface DriverProfilesForContactsResultV2 {
  contract: typeof DRIVER_PROFILES_FOR_CONTACTS_RESULT_V2
  licenceView: DriverLicenceViewV1
  entries: DriverProfilesForContactEntryV2[]
}

export class DriverProfilesForContactsQueryV2ValidationError extends Error {
  readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'
  constructor(code: DriverProfilesForContactsQueryV2ValidationError['code'], message: string) {
    super(message)
    this.name = 'DriverProfilesForContactsQueryV2ValidationError'
    this.code = code
  }
}

function invalid(message: string): never {
  throw new DriverProfilesForContactsQueryV2ValidationError('INVALID_CONTRACT', message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseDriverProfilesForContactsQueryV2(input: unknown): DriverProfilesForContactsQueryV2 {
  if (!isRecord(input)) invalid('query must be an object')
  const extraFields = Object.keys(input).filter(key => key !== 'contract' && key !== 'licenceView' && key !== 'subjects')
  if (extraFields.length > 0) invalid(`unsupported field(s): ${extraFields.sort().join(', ')}`)
  if (input.contract !== DRIVER_PROFILES_FOR_CONTACTS_QUERY_V2) {
    if (typeof input.contract === 'string' && input.contract.startsWith('fleet_operations.DriverProfilesForContactsQuery.')) {
      throw new DriverProfilesForContactsQueryV2ValidationError('UNSUPPORTED_CONTRACT_VERSION', `unsupported contract version: ${input.contract}`)
    }
    invalid(`contract must equal ${DRIVER_PROFILES_FOR_CONTACTS_QUERY_V2}`)
  }
  if (!isDriverLicenceViewV1(input.licenceView)) invalid('licenceView must be full or last4')
  // The subjects are v1's, checked by v1's own parser.
  let subjects: DriverProfilesForContactsSubjectV1[]
  try {
    subjects = parseDriverProfilesForContactsQueryV1({ contract: DRIVER_PROFILES_FOR_CONTACTS_QUERY_V1, subjects: input.subjects }).subjects
  } catch (error) {
    invalid(error instanceof Error ? error.message : 'subjects are invalid')
  }
  return { contract: DRIVER_PROFILES_FOR_CONTACTS_QUERY_V2, licenceView: input.licenceView, subjects }
}
