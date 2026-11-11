// The only database reader behind DriverProfilesForContactsQuery.v3's extra
// profile fields. It reads exactly three columns of Fleet-owned Driver rows,
// by id, never writes, and reads no Contact, ContactIdentity, Chat or provider
// table. The stored licence is not read here (v2's licence port reads it).
import { prisma } from '@/lib/prisma'
import type { DriverCardFieldsReadPortV1 } from './driver-card-fields-read-port'

export const legacyPrismaDriverCardFieldsPortV1: DriverCardFieldsReadPortV1 = {
  async findCardFieldsOfDrivers(driverIds) {
    if (driverIds.length === 0) return new Map()
    const rows = await prisma.driver.findMany({
      where: { id: { in: [...driverIds] } },
      select: { id: true, phone: true, isSelfEmployed: true, employmentType: true },
      take: 500,
    })
    return new Map(rows.map(row => [row.id, { phone: row.phone, isSelfEmployed: row.isSelfEmployed, employmentType: row.employmentType }]))
  },
}
