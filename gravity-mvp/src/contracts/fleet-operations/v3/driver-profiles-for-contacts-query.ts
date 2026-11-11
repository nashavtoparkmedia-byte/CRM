// fleet_operations.DriverProfilesForContactsQuery.v3 — v2 plus each profile's
// own phone and employment, for the person card's «Парки и занятость» (Owner
// V2 person card mandate, 2026-11-11).
//
// v1 and v2 stay unchanged beside it. v3 differs from v2 only in three profile
// fields, read from the same Fleet-owned Driver row:
// - `phone`: the profile's phone as Fleet stores it (E.164), or null;
// - `isSelfEmployed`: the stored self-employment flag, or null;
// - `employmentType`: one of DRIVER_EMPLOYMENT_TYPES_V3, 'unknown' for any other
//   stored value (a provider value is never passed through raw), or null when
//   nothing is stored.
// The query is v2's: `licenceView` is still required and is Contacts' read
// authority answer, passed on unchanged; the licence is v2's masked value. The
// phone crosses under that same read authority. Labels («ФЛ», «СМЗ», «Парковый
// ИП») belong to the card, not to this contract.
import {
  DRIVER_PROFILES_FOR_CONTACTS_QUERY_V2,
  parseDriverProfilesForContactsQueryV2,
  type DriverProfileForContactV2,
} from '../v2'
import type { DriverLicenceViewV1, DriverProfilesForContactsSubjectV1 } from '../v1'

export const DRIVER_PROFILES_FOR_CONTACTS_QUERY_V3 = 'fleet_operations.DriverProfilesForContactsQuery.v3' as const
export const DRIVER_PROFILES_FOR_CONTACTS_RESULT_V3 = 'fleet_operations.DriverProfilesForContactsResult.v3' as const

export const DRIVER_EMPLOYMENT_TYPES_V3 = ['park_employee', 'selfemployed', 'individual_entrepreneur', 'unknown'] as const
export type DriverEmploymentTypeV3 = typeof DRIVER_EMPLOYMENT_TYPES_V3[number]

/** A stored employment value as v3 shows it: an allowlisted code, 'unknown', or null when none is stored. */
export function driverEmploymentTypeV3(stored: unknown): DriverEmploymentTypeV3 | null {
  if (stored === null || stored === undefined) return null
  if (typeof stored !== 'string' || stored.trim() === '') return null
  return (DRIVER_EMPLOYMENT_TYPES_V3 as readonly string[]).includes(stored) && stored !== 'unknown'
    ? (stored as DriverEmploymentTypeV3)
    : 'unknown'
}

export interface DriverProfilesForContactsQueryV3 {
  contract: typeof DRIVER_PROFILES_FOR_CONTACTS_QUERY_V3
  licenceView: DriverLicenceViewV1
  /** As v1: 1..25 subjects with distinct, exact Contact ids, answered in this order. */
  subjects: DriverProfilesForContactsSubjectV1[]
}

export interface DriverProfileForContactV3 extends DriverProfileForContactV2 {
  /** The profile's own stored phone (E.164), or null. */
  phone: string | null
  isSelfEmployed: boolean | null
  employmentType: DriverEmploymentTypeV3 | null
}

export interface DriverProfilesForContactEntryV3 {
  contactId: string
  profiles: DriverProfileForContactV3[]
}

export interface DriverProfilesForContactsResultV3 {
  contract: typeof DRIVER_PROFILES_FOR_CONTACTS_RESULT_V3
  licenceView: DriverLicenceViewV1
  entries: DriverProfilesForContactEntryV3[]
}

export class DriverProfilesForContactsQueryV3ValidationError extends Error {
  readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'
  constructor(code: DriverProfilesForContactsQueryV3ValidationError['code'], message: string) {
    super(message)
    this.name = 'DriverProfilesForContactsQueryV3ValidationError'
    this.code = code
  }
}

function invalid(message: string): never {
  throw new DriverProfilesForContactsQueryV3ValidationError('INVALID_CONTRACT', message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseDriverProfilesForContactsQueryV3(input: unknown): DriverProfilesForContactsQueryV3 {
  if (!isRecord(input)) invalid('query must be an object')
  if (input.contract !== DRIVER_PROFILES_FOR_CONTACTS_QUERY_V3) {
    if (typeof input.contract === 'string' && input.contract.startsWith('fleet_operations.DriverProfilesForContactsQuery.')) {
      throw new DriverProfilesForContactsQueryV3ValidationError('UNSUPPORTED_CONTRACT_VERSION', 'unsupported contract version')
    }
    invalid(`contract must equal ${DRIVER_PROFILES_FOR_CONTACTS_QUERY_V3}`)
  }
  // Everything else is v2's query, checked by v2's own parser.
  try {
    const v2 = parseDriverProfilesForContactsQueryV2({ ...input, contract: DRIVER_PROFILES_FOR_CONTACTS_QUERY_V2 })
    return { contract: DRIVER_PROFILES_FOR_CONTACTS_QUERY_V3, licenceView: v2.licenceView, subjects: v2.subjects }
  } catch (error) {
    invalid(error instanceof Error ? error.message : 'query is invalid')
  }
}
