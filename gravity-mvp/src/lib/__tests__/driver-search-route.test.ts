import { beforeEach, describe, expect, it, vi } from 'vitest'

const prismaMock = vi.hoisted(() => ({ driver: { findMany: vi.fn() } }))
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))

import { GET } from '@/app/api/drivers-search/route'

describe('local DriverProfile search route', () => {
  beforeEach(() => vi.clearAllMocks())

  it('searches locally across parks and returns DriverProfile identity', async () => {
    prismaMock.driver.findMany.mockResolvedValue([{
      id: 'profile-1',
      fullName: 'Иванов Иван Иванович',
      phone: '+79222155750',
      yandexDriverId: 'yandex-profile-1',
      externalDriverProfileId: 'external-profile-1',
      externalParkId: 'external-park-yoko',
      externalPersonKey: 'person-1',
      dismissedAt: null,
      contactId: 'contact-1',
      park: { id: 'park-yoko', parkCode: 'YOKO', parkName: 'YOKO' },
    }])

    const response = await GET(new Request('http://localhost/api/drivers-search?q=9222155750'))

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      total: 1,
      drivers: [{ id: 'profile-1', profileId: 'profile-1', park: { parkCode: 'YOKO' } }],
    })
    expect(prismaMock.driver.findMany).toHaveBeenCalledTimes(1)
  })
})

describe('legacy Messenger DriverProfile search compatibility', () => {
  it('uses the local multi-park catalogue and retains an array response', async () => {
    const source = await import('node:fs/promises').then(fs => fs.readFile('src/app/api/messages/drivers/search/route.ts', 'utf8'))
    expect(source).toContain("from '@/lib/driver-profile-search'")
    expect(source).toContain('rankDriverProfileSearchResults')
    expect(source).toContain('return NextResponse.json(drivers)')
    expect(source).toContain('unsaved_${phoneDigits}')
    expect(source).not.toContain('prisma.driver.findFirst')
    expect(source).not.toContain('fetch(')
  })
})
