// The Fleet Operations handler behind fleet_operations.DriverProfilesForContactsQuery.v3.
//
// It answers exactly what v2 answers for the same subjects and licence view,
// plus each profile's own phone and employment. The v2 read is reused
// unchanged (so the masked licence and every v1 field cannot drift), and the
// employment value leaves this handler only through driverEmploymentTypeV3.
import {
  DRIVER_PROFILES_FOR_CONTACTS_QUERY_V2,
  type DriverProfilesForContactsQueryV2,
  type DriverProfilesForContactsResultV2,
} from '../../../../contracts/fleet-operations/v2'
import {
  DRIVER_PROFILES_FOR_CONTACTS_RESULT_V3,
  driverEmploymentTypeV3,
  parseDriverProfilesForContactsQueryV3,
  type DriverProfilesForContactsQueryV3,
  type DriverProfilesForContactsResultV3,
} from '../../../../contracts/fleet-operations/v3'
import type { DriverCardFieldsReadPortV1 } from './driver-card-fields-read-port'

export function createDriverProfilesForContactsHandlerV3(
  readV2: (query: DriverProfilesForContactsQueryV2) => Promise<DriverProfilesForContactsResultV2>,
  cardFields: DriverCardFieldsReadPortV1,
) {
  return async function readDriverProfilesForContactsV3(
    query: DriverProfilesForContactsQueryV3 | unknown,
  ): Promise<DriverProfilesForContactsResultV3> {
    const parsed = parseDriverProfilesForContactsQueryV3(query)
    const v2 = await readV2({ contract: DRIVER_PROFILES_FOR_CONTACTS_QUERY_V2, licenceView: parsed.licenceView, subjects: parsed.subjects })
    const driverIds = [...new Set(v2.entries.flatMap(entry => entry.profiles.map(profile => profile.driverId)))]
    const stored = await cardFields.findCardFieldsOfDrivers(driverIds)
    return {
      contract: DRIVER_PROFILES_FOR_CONTACTS_RESULT_V3,
      licenceView: v2.licenceView,
      entries: v2.entries.map(entry => ({
        contactId: entry.contactId,
        profiles: entry.profiles.map(profile => {
          const fields = stored.get(profile.driverId)
          return {
            ...profile,
            phone: typeof fields?.phone === 'string' && fields.phone.trim() !== '' ? fields.phone : null,
            isSelfEmployed: typeof fields?.isSelfEmployed === 'boolean' ? fields.isSelfEmployed : null,
            employmentType: driverEmploymentTypeV3(fields?.employmentType ?? null),
          }
        }),
      })),
    }
  }
}
