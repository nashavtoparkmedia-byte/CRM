// The only database reader behind fleet_operations.DriverProfilesForContactsQuery.v1.
//
// It reads Fleet-owned Driver rows (with the park name of their Fleet-owned Park)
// by the stored Contact link or the legacy Yandex driver link, in one bounded
// query, and never writes. It never reads Contact, ContactIdentity, Chat or any
// provider table: which Contacts to ask about is the caller's knowledge.
import { prisma } from '@/lib/prisma'
import type {
  DriverProfileRowV1,
  DriverProfilesForContactsPersistencePortV1,
} from './driver-profiles-for-contacts-handler'

export const legacyPrismaDriverProfilesForContactsPortV1: DriverProfilesForContactsPersistencePortV1 = {
  async findDriverProfiles({ contactIds, yandexDriverIds }): Promise<DriverProfileRowV1[]> {
    const or: Array<{ contactId: { in: string[] } } | { yandexDriverId: { in: string[] } }> = []
    if (contactIds.length > 0) or.push({ contactId: { in: [...contactIds] } })
    if (yandexDriverIds.length > 0) or.push({ yandexDriverId: { in: [...yandexDriverIds] } })
    if (or.length === 0) return []
    const rows = await prisma.driver.findMany({
      where: { OR: or },
      select: {
        id: true,
        contactId: true,
        yandexDriverId: true,
        externalParkId: true,
        externalDriverProfileId: true,
        fullName: true,
        personResolutionStatus: true,
        personKeyType: true,
        customFields: true,
        segment: true,
        dismissedAt: true,
        park: { select: { parkName: true } },
      },
      orderBy: [{ id: 'asc' }],
      take: 500,
    })
    return rows.map(row => ({
      id: row.id,
      contactId: row.contactId,
      yandexDriverId: row.yandexDriverId,
      externalParkId: row.externalParkId,
      externalDriverProfileId: row.externalDriverProfileId,
      parkName: row.park?.parkName ?? null,
      fullName: row.fullName,
      personResolutionStatus: row.personResolutionStatus,
      personKeyType: row.personKeyType,
      customFields: row.customFields,
      segment: row.segment,
      dismissedAt: row.dismissedAt,
    }))
  },
}
