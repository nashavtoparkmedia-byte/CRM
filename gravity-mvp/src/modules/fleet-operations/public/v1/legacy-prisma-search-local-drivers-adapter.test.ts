import { beforeEach, describe, expect, it, vi } from 'vitest'

import { prisma } from '@/lib/prisma'

import { legacyPrismaSearchLocalDriversPortV1 } from './legacy-prisma-search-local-drivers-adapter'

vi.mock('@/lib/prisma', () => ({
  prisma: { $queryRaw: vi.fn(), driver: { findMany: vi.fn() } },
}))

const findMany = vi.mocked(prisma.driver.findMany)
const queryRaw = vi.mocked(prisma.$queryRaw)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('Fleet Prisma local-driver phone lookup', () => {
  it.each([
    '+7 999 123-45-67',
    '8 (999) 123 45 67',
  ])('matches normalized phone identity stored as %s', async storedPhone => {
    queryRaw.mockResolvedValue([
      { id: 'match', yandexDriverId: 'yandex-1', fullName: 'Иван Иванов', phone: storedPhone },
    ] as never)

    await expect(legacyPrismaSearchLocalDriversPortV1.search({
      phoneDigits: '79991234567',
      nameTokens: [],
      take: 10,
    })).resolves.toEqual([
      { id: 'match', yandexDriverId: 'yandex-1', fullName: 'Иван Иванов', phone: storedPhone },
    ])
    const [queryParts, ...parameters] = queryRaw.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]]
    expect(queryParts.join(' ')).toContain("regexp_replace(COALESCE(\"phone\", ''), '[^0-9]', '', 'g')")
    expect(parameters).toEqual(['79991234567', 10])
    expect(findMany).not.toHaveBeenCalled()
  })
})
