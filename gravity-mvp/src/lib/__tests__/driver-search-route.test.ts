import { beforeEach, describe, expect, it, vi } from 'vitest'

const prismaMock = vi.hoisted(() => ({
  driver: { findMany: vi.fn() },
  parkConnection: { findMany: vi.fn() },
}))
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))

import { GET } from '@/app/api/drivers-search/route'

describe('local DriverProfile search route', () => {
  beforeEach(() => vi.clearAllMocks())

  it('searches locally across parks and returns DriverProfile identity', async () => {
    prismaMock.parkConnection.findMany.mockResolvedValue([{
      parkId: 'park-yoko',
      apiConnectionId: 'connection-yoko',
      externalParkId: 'external-park-yoko',
      lastSuccessfulSyncAt: new Date('2026-07-17T03:00:00.000Z'),
      lastFailedSyncAt: null,
      lastErrorSummary: null,
      park: { parkCode: 'YOKO', parkName: 'YOKO' },
    }])
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
      parkId: 'park-yoko',
      sourceConnectionId: 'connection-yoko',
      statusOverride: 'working',
      lastFleetCheckStatus: 'offline',
      lastFleetCheckAt: new Date('2026-07-17T03:00:00.000Z'),
      customFields: { yandexProfile: { employmentType: 'selfemployed' } },
      personResolutionStatus: 'resolved',
      updatedAt: new Date('2026-07-17T03:00:00.000Z'),
      park: { id: 'park-yoko', parkCode: 'YOKO', parkName: 'YOKO' },
      contact: {
        id: 'contact-1',
        displayName: 'Иванов Иван Иванович',
        mainDriverId: 'profile-1',
        isArchived: false,
        chats: [{ id: 'chat-1' }],
      },
    }])

    const response = await GET(new Request('http://localhost/api/drivers-search?q=9222155750'))

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      total: 1,
      drivers: [{
        id: 'profile-1',
        profileId: 'profile-1',
        park: { parkCode: 'YOKO' },
        employmentTypeLabel: 'Парковый СМЗ',
        lastSuccessfulSyncAt: '2026-07-17T03:00:00.000Z',
        linkedContact: { id: 'contact-1', chatId: 'chat-1' },
        isMain: true,
      }],
      catalog: {
        source: 'local_nightly_sync',
        configuredParkCount: 6,
        availableParkCount: 1,
        coverage: 'partial',
      },
    })
    expect(prismaMock.driver.findMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.parkConnection.findMany).toHaveBeenCalledTimes(1)
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
