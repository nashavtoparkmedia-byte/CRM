// The only database reader of the stored driving licence (ВУ) behind Fleet's
// licence-carrying public reads: DriverProfilesForContactsQuery.v2 and
// DriverProfilesByExactLicenceQuery.v1.
//
// It reads Fleet-owned Driver rows (with the park name of their Fleet-owned
// Park), never writes, and never reads Contact, ContactIdentity, Chat or any
// provider table. It returns the stored licence only to the handlers, which
// mask it before anything leaves Fleet.
import { prisma } from '@/lib/prisma'
import type { DriverLicenceReadPortV1, DriverLicenceProfileRowV1 } from './driver-licence-read-port'

export const legacyPrismaDriverLicencePortV1: DriverLicenceReadPortV1 = {
  async findLicencesOfDrivers(driverIds) {
    if (driverIds.length === 0) return new Map()
    const rows = await prisma.driver.findMany({
      where: { id: { in: [...driverIds] } },
      select: { id: true, licenseNumber: true },
      take: 500,
    })
    return new Map(rows.map(row => [row.id, row.licenseNumber]))
  },

  async findProfilesByLicenceKey(licenceKey, limit) {
    // Parameterized: the key and the bound are bind values, never SQL text.
    const rows = await prisma.$queryRaw<DriverLicenceProfileRowV1[]>`
      SELECT d."id", d."contactId", d."externalParkId", d."externalDriverProfileId",
             p."parkName", d."fullName", d."licenseNumber", d."dismissedAt"
      FROM "Driver" d
      LEFT JOIN "Park" p ON p."id" = d."parkId"
      WHERE upper(regexp_replace(coalesce(d."licenseNumber", ''), '[^0-9A-Za-zА-Яа-яЁё]', '', 'g')) = ${licenceKey}::text
      ORDER BY d."fullName" ASC, d."id" ASC
      LIMIT ${limit}`
    return rows
  },
}
