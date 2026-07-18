import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { NextRequest } from 'next/server'

import { GET } from '@/app/api/drivers-search/route'
import { APPROVED_PARKS } from '@/lib/driver-profiles/park-identity'
import { prisma } from '@/lib/prisma'

const dbDescribe = process.env.DRIVER_SEARCH_DB_TEST === '1' ? describe : describe.skip

dbDescribe('local DriverProfile search across six ParkConnection rows', () => {
  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "Driver", "ParkConnection", "ApiConnection", "Park", "Contact" CASCADE',
    )
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('returns all six approved parks from the nightly-synced catalogue without a provider request', async () => {
    const contact = await prisma.contact.create({
      data: { displayName: 'Fixture Driver Six Parks' },
    })
    const driverIds: string[] = []
    const lastSuccessfulSyncAt = new Date('2026-07-18T00:30:00.000Z')

    for (const [index, approvedPark] of APPROVED_PARKS.entries()) {
      const apiConnection = await prisma.apiConnection.create({
        data: {
          clid: `fixture-clid-${index}`,
          apiKey: `fixture-api-key-${index}`,
          parkId: approvedPark.externalParkId,
          name: approvedPark.parkName,
        },
      })
      const park = await prisma.park.create({
        data: {
          parkCode: approvedPark.parkCode,
          parkName: approvedPark.parkName,
          externalParkId: approvedPark.externalParkId,
        },
      })
      await prisma.parkConnection.create({
        data: {
          parkId: park.id,
          apiConnectionId: apiConnection.id,
          externalParkId: approvedPark.externalParkId,
          lastSuccessfulSyncAt,
        },
      })
      const driver = await prisma.driver.create({
        data: {
          yandexDriverId: `fixture-yandex-${index}`,
          externalDriverProfileId: `fixture-profile-${index}`,
          externalParkId: approvedPark.externalParkId,
          externalPersonKey: 'fixture-person-six-parks',
          personResolutionStatus: 'resolved',
          parkId: park.id,
          sourceConnectionId: apiConnection.id,
          fullName: 'Fixture Driver Six Parks',
          phone: '+79222155750',
          statusOverride: 'working',
          lastFleetCheckStatus: 'offline',
          lastFleetCheckAt: lastSuccessfulSyncAt,
          contactId: contact.id,
          customFields: {
            yandexProfile: {
              employmentType: index === 0 ? 'park_employee' : 'selfemployed',
              sourceUpdatedAt: lastSuccessfulSyncAt.toISOString(),
            },
          },
        },
      })
      driverIds.push(driver.id)
    }

    await prisma.contact.update({
      where: { id: contact.id },
      data: { mainDriverId: driverIds[0] },
    })

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const response = await GET(new NextRequest('http://localhost/api/drivers-search?q=Fixture%20Driver&limit=20'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(await prisma.parkConnection.count({
      where: { enabled: true, archivedAt: null },
    })).toBe(6)
    expect(body.catalog).toMatchObject({
      source: 'local_nightly_sync',
      configuredParkCount: 6,
      availableParkCount: 6,
      coverage: 'complete',
      lastSuccessfulSyncAt: lastSuccessfulSyncAt.toISOString(),
    })
    expect(body.catalog.parks.map((park: { parkCode: string }) => park.parkCode))
      .toEqual(APPROVED_PARKS.map(park => park.parkCode))
    expect(body.drivers).toHaveLength(6)
    expect(new Set(body.drivers.map((driver: { park: { parkCode: string } }) => driver.park.parkCode)))
      .toEqual(new Set(APPROVED_PARKS.map(park => park.parkCode)))
    expect(body.drivers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        fullName: 'Fixture Driver Six Parks',
        phone: '+79222155750',
        status: 'working',
        externalDriverProfileId: expect.stringMatching(/^fixture-profile-/),
        lastSuccessfulSyncAt: lastSuccessfulSyncAt.toISOString(),
        linkedContact: expect.objectContaining({ id: contact.id }),
        anomaly: null,
      }),
    ]))
    expect(body.drivers.filter((driver: { isMain: boolean }) => driver.isMain)).toHaveLength(1)
  })
})
