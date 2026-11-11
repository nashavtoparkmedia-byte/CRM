// The Fleet Operations handler behind fleet_operations.DriverProfilesByExactLicenceQuery.v1.
//
// Any reader may find profiles by a full licence; the answer shows each stored
// licence only through maskDriverLicenceV1 with the caller's view, and never
// echoes the typed licence. A typed value with fewer than six letters and
// digits is not a licence: the answer is empty and nothing is read.
import {
  DRIVER_PROFILES_BY_EXACT_LICENCE_MAX_PROFILES_V1,
  DRIVER_PROFILES_BY_EXACT_LICENCE_RESULT_V1,
  parseDriverProfilesByExactLicenceQueryV1,
  type DriverProfilesByExactLicenceQueryV1,
  type DriverProfilesByExactLicenceResultV1,
} from '../../../../contracts/fleet-operations/v1'
import { driverLicenceKeyV1, maskDriverLicenceV1 } from './driver-licence-mask'
import type { DriverLicenceReadPortV1 } from './driver-licence-read-port'

/** The shortest typed licence that is searched at all. */
export const DRIVER_LICENCE_MIN_SEARCH_LENGTH_V1 = 6

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function isoOrNull(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export function createDriverProfilesByExactLicenceHandlerV1(port: Pick<DriverLicenceReadPortV1, 'findProfilesByLicenceKey'>) {
  return async function findDriverProfilesByExactLicenceV1(
    query: DriverProfilesByExactLicenceQueryV1 | unknown,
  ): Promise<DriverProfilesByExactLicenceResultV1> {
    const parsed = parseDriverProfilesByExactLicenceQueryV1(query)
    const key = driverLicenceKeyV1(parsed.licence)
    if (key === null || key.length < DRIVER_LICENCE_MIN_SEARCH_LENGTH_V1) {
      return { contract: DRIVER_PROFILES_BY_EXACT_LICENCE_RESULT_V1, profiles: [], truncated: false }
    }
    // One row past the bound tells whether more matched.
    const rows = await port.findProfilesByLicenceKey(key, DRIVER_PROFILES_BY_EXACT_LICENCE_MAX_PROFILES_V1 + 1)
    const truncated = rows.length > DRIVER_PROFILES_BY_EXACT_LICENCE_MAX_PROFILES_V1
    return {
      contract: DRIVER_PROFILES_BY_EXACT_LICENCE_RESULT_V1,
      profiles: rows.slice(0, DRIVER_PROFILES_BY_EXACT_LICENCE_MAX_PROFILES_V1).map(row => ({
        driverId: row.id,
        linkedContactId: text(row.contactId),
        externalParkId: text(row.externalParkId),
        externalDriverProfileId: text(row.externalDriverProfileId),
        parkName: text(row.parkName),
        fullName: typeof row.fullName === 'string' ? row.fullName : '',
        licence: maskDriverLicenceV1(row.licenseNumber, parsed.licenceView),
        dismissedAt: isoOrNull(row.dismissedAt),
      })),
      truncated,
    }
  }
}
