import { prisma } from '@/lib/prisma'
import type { GetDriverCallablePhonePersistencePortV1 } from './get-driver-callable-phone-handler'

export const legacyPrismaGetDriverCallablePhonePortV1: GetDriverCallablePhonePersistencePortV1 = {
  async findById(driverId) {
    return prisma.driver.findUnique({
      where: { id: driverId },
      select: { id: true, phone: true },
    })
  },
}
