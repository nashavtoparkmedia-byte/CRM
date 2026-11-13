// fleet_operations.DriverProfilesByExactLicenceQuery.v1 — the persisted park
// profiles whose driving licence (ВУ) is exactly the typed one.
//
// Read-only and persisted: it answers from the Driver rows Fleet already owns and
// makes no park, scraper or provider call. Every reader may search by a full
// licence (Owner D2); what comes back shows the licence only as the caller's
// `licenceView` allows, and the typed licence itself is never echoed: not in the
// answer, not in an error. A licence matches when its letters and digits, upper
// case, are exactly the typed ones; there is no prefix or partial match.
//
// Which person a profile belongs to is NOT decided here: `linkedContactId` only
// reports the row's stored Contact link.
import { isDriverLicenceViewV1, type DriverLicenceViewV1 } from './driver-licence-view'

export const DRIVER_PROFILES_BY_EXACT_LICENCE_QUERY_V1 = 'fleet_operations.DriverProfilesByExactLicenceQuery.v1' as const
export const DRIVER_PROFILES_BY_EXACT_LICENCE_RESULT_V1 = 'fleet_operations.DriverProfilesByExactLicenceResult.v1' as const

/** At most this many profiles in one answer; `truncated` says when more matched. */
export const DRIVER_PROFILES_BY_EXACT_LICENCE_MAX_PROFILES_V1 = 20
/** A typed value longer than this is not a licence and is refused before any read. */
export const DRIVER_PROFILES_BY_EXACT_LICENCE_MAX_INPUT_V1 = 64

export interface DriverProfilesByExactLicenceQueryV1 {
  contract: typeof DRIVER_PROFILES_BY_EXACT_LICENCE_QUERY_V1
  /** The full licence as typed; separators and case do not matter. */
  licence: string
  /** Contacts' answer for this request, passed on unchanged. Required: there is no default view. */
  licenceView: DriverLicenceViewV1
}

export interface DriverProfileByExactLicenceV1 {
  driverId: string
  /** The Contact the row's own stored link points at (Driver.contactId), or null. */
  linkedContactId: string | null
  externalParkId: string | null
  externalDriverProfileId: string | null
  parkName: string | null
  fullName: string
  /** The stored licence as `licenceView` allows: full, or masked to its last four characters. */
  licence: string | null
  dismissedAt: string | null
}

export interface DriverProfilesByExactLicenceResultV1 {
  contract: typeof DRIVER_PROFILES_BY_EXACT_LICENCE_RESULT_V1
  /** Ordered by full name, then driver id. */
  profiles: DriverProfileByExactLicenceV1[]
  truncated: boolean
}

export class DriverProfilesByExactLicenceQueryValidationError extends Error {
  readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'
  constructor(code: DriverProfilesByExactLicenceQueryValidationError['code'], message: string) {
    super(message)
    this.name = 'DriverProfilesByExactLicenceQueryValidationError'
    this.code = code
  }
}

// No message below quotes the typed licence: a refused query must not echo it.
function invalid(message: string): never {
  throw new DriverProfilesByExactLicenceQueryValidationError('INVALID_CONTRACT', message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseDriverProfilesByExactLicenceQueryV1(input: unknown): DriverProfilesByExactLicenceQueryV1 {
  if (!isRecord(input)) invalid('query must be an object')
  const extraFields = Object.keys(input).filter(key => key !== 'contract' && key !== 'licence' && key !== 'licenceView')
  if (extraFields.length > 0) invalid(`unsupported field(s): ${extraFields.sort().join(', ')}`)
  if (input.contract !== DRIVER_PROFILES_BY_EXACT_LICENCE_QUERY_V1) {
    if (typeof input.contract === 'string' && input.contract.startsWith('fleet_operations.DriverProfilesByExactLicenceQuery.')) {
      throw new DriverProfilesByExactLicenceQueryValidationError('UNSUPPORTED_CONTRACT_VERSION', 'unsupported contract version')
    }
    invalid(`contract must equal ${DRIVER_PROFILES_BY_EXACT_LICENCE_QUERY_V1}`)
  }
  if (!isDriverLicenceViewV1(input.licenceView)) invalid('licenceView must be full or last4')
  if (typeof input.licence !== 'string') invalid('licence must be a string')
  if (input.licence.length > DRIVER_PROFILES_BY_EXACT_LICENCE_MAX_INPUT_V1) invalid('licence is too long')
  return { contract: DRIVER_PROFILES_BY_EXACT_LICENCE_QUERY_V1, licence: input.licence, licenceView: input.licenceView }
}
