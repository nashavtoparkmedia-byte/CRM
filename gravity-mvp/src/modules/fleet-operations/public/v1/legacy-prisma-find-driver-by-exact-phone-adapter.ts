import { prisma } from '@/lib/prisma'
import type { FindDriverByExactPhonePersistencePortV1 } from './find-driver-by-exact-phone-handler'

export const legacyPrismaFindDriverByExactPhonePortV1: FindDriverByExactPhonePersistencePortV1 = {
  async findByExactPhone(phone) {
    return prisma.driver.findFirst({
      where: { phone },
      select: { id: true },
    })
  },
}
