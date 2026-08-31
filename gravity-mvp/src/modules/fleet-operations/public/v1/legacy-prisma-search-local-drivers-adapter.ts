import { prisma } from '@/lib/prisma'
import type { LocalDriverSearchRowV1, SearchLocalDriversPersistencePortV1 } from './search-local-drivers-handler'

export const legacyPrismaSearchLocalDriversPortV1: SearchLocalDriversPersistencePortV1 = {
  async search(input) {
    if (input.phoneDigits) {
      return prisma.$queryRaw<LocalDriverSearchRowV1[]>`
        WITH normalized_driver_phones AS (
          SELECT
            "id",
            "yandexDriverId",
            "fullName",
            "phone",
            "updatedAt",
            regexp_replace(COALESCE("phone", ''), '[^0-9]', '', 'g') AS digits
          FROM "Driver"
        )
        SELECT "id", "yandexDriverId", "fullName", "phone"
        FROM normalized_driver_phones
        WHERE CASE
          WHEN length(digits) = 11 AND left(digits, 1) = '8' THEN '7' || substring(digits FROM 2)
          WHEN length(digits) = 10 THEN '7' || digits
          ELSE digits
        END = ${input.phoneDigits}
        ORDER BY "updatedAt" DESC, "id" ASC
        LIMIT ${input.take}
      `
    }

    return prisma.driver.findMany({
      where: {
        AND: input.nameTokens.map(token => ({
          fullName: { contains: token, mode: 'insensitive' as const },
        })),
      },
      select: { id: true, yandexDriverId: true, fullName: true, phone: true },
      take: input.take,
    })
  },
}
