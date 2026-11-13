// The Fleet Operations handler behind fleet_operations.DriverProfilesForContactsQuery.v2.
//
// It answers exactly what v1 answers for the same subjects, plus each profile's
// licence masked by the caller's licence view. The v1 read is reused unchanged,
// so the two versions cannot drift; the stored licence comes from the licence
// port and leaves this handler only through maskDriverLicenceV1.
import {
  DRIVER_PROFILES_FOR_CONTACTS_QUERY_V1,
  type DriverProfilesForContactsQueryV1,
  type DriverProfilesForContactsResultV1,
} from '../../../../contracts/fleet-operations/v1'
import {
  DRIVER_PROFILES_FOR_CONTACTS_RESULT_V2,
  parseDriverProfilesForContactsQueryV2,
  type DriverProfilesForContactsQueryV2,
  type DriverProfilesForContactsResultV2,
} from '../../../../contracts/fleet-operations/v2'
import { maskDriverLicenceV1 } from './driver-licence-mask'
import type { DriverLicenceReadPortV1 } from './driver-licence-read-port'

export function createDriverProfilesForContactsHandlerV2(
  readV1: (query: DriverProfilesForContactsQueryV1) => Promise<DriverProfilesForContactsResultV1>,
  licences: Pick<DriverLicenceReadPortV1, 'findLicencesOfDrivers'>,
) {
  return async function readDriverProfilesForContactsV2(
    query: DriverProfilesForContactsQueryV2 | unknown,
  ): Promise<DriverProfilesForContactsResultV2> {
    const parsed = parseDriverProfilesForContactsQueryV2(query)
    const v1 = await readV1({ contract: DRIVER_PROFILES_FOR_CONTACTS_QUERY_V1, subjects: parsed.subjects })
    const driverIds = [...new Set(v1.entries.flatMap(entry => entry.profiles.map(profile => profile.driverId)))]
    const stored = await licences.findLicencesOfDrivers(driverIds)
    return {
      contract: DRIVER_PROFILES_FOR_CONTACTS_RESULT_V2,
      licenceView: parsed.licenceView,
      entries: v1.entries.map(entry => ({
        contactId: entry.contactId,
        profiles: entry.profiles.map(profile => ({
          ...profile,
          licence: maskDriverLicenceV1(stored.get(profile.driverId) ?? null, parsed.licenceView),
        })),
      })),
    }
  }
}
