import { describe, expect, it } from 'vitest'
import {
  addDriverCatalogSyncMetadata,
  buildDriverCatalogSummary,
  matchesDriverProfileSearch,
  rankDriverProfileSearchResults,
  toDriverSearchResult,
  type DriverProfileSearchCandidate,
} from '@/lib/driver-profile-search'

function profile(overrides: Partial<DriverProfileSearchCandidate> = {}): DriverProfileSearchCandidate {
  return {
    id: 'profile-1',
    fullName: 'Иванов Иван Иванович',
    phone: '+7 922 215-57-50',
    yandexDriverId: 'yandex-profile-1',
    externalDriverProfileId: 'external-profile-1',
    externalParkId: 'external-park-yoko',
    externalPersonKey: 'person-1',
    dismissedAt: null,
    contactId: 'contact-1',
    park: { id: 'park-yoko', parkCode: 'YOKO', parkName: 'YOKO' },
    parkId: 'park-yoko',
    sourceConnectionId: 'connection-yoko',
    statusOverride: 'working',
    lastFleetCheckStatus: 'offline',
    customFields: { yandexProfile: { employmentType: 'selfemployed' } },
    personResolutionStatus: 'resolved',
    contact: {
      id: 'contact-1',
      displayName: 'Иванов Иван Иванович',
      mainDriverId: 'profile-1',
      isArchived: false,
      chats: [{ id: 'chat-1' }],
    },
    ...overrides,
  }
}

describe('global DriverProfile search', () => {
  it('matches formatted phone input without choosing a park', () => {
    expect(matchesDriverProfileSearch(profile(), '8 (922) 215-57-50')).toBe(true)
  })

  it('matches FIO prefix and external profile identifiers', () => {
    expect(matchesDriverProfileSearch(profile(), 'ивано')).toBe(true)
    expect(matchesDriverProfileSearch(profile(), 'external-profile')).toBe(true)
  })

  it('ranks an exact working phone match above a dismissed profile', () => {
    const working = profile({ id: 'working' })
    const dismissed = profile({ id: 'dismissed', dismissedAt: new Date('2026-01-01') })
    expect(rankDriverProfileSearchResults([dismissed, working], '79222155750').map(item => item.id))
      .toEqual(['working', 'dismissed'])
  })

  it('returns park identity and a backward-compatible driver id', () => {
    expect(toDriverSearchResult(profile())).toMatchObject({
      id: 'profile-1',
      profileId: 'profile-1',
      first_name: 'Иванов',
      last_name: 'Иван Иванович',
      phones: ['+7 922 215-57-50'],
      status: 'working',
      statusLabel: 'Работает',
      employmentType: 'selfemployed',
      employmentTypeLabel: 'Парковый СМЗ',
      park: { parkCode: 'YOKO', parkName: 'YOKO' },
      linkedContact: { id: 'contact-1', displayName: 'Иванов Иван Иванович', chatId: 'chat-1' },
      isMain: true,
      anomaly: null,
    })
  })

  it('maps park sync metadata and preserves stale profiles as operator-visible data', () => {
    const connections = [{
      parkId: 'park-yoko',
      apiConnectionId: 'connection-yoko',
      externalParkId: 'external-park-yoko',
      lastSuccessfulSyncAt: new Date('2026-07-17T01:00:00.000Z'),
      lastFailedSyncAt: new Date('2026-07-17T02:00:00.000Z'),
      lastErrorSummary: 'rate_limited',
      park: { parkCode: 'YOKO', parkName: 'YOKO' },
    }]
    const [withSync] = addDriverCatalogSyncMetadata([profile()], connections)
    expect(toDriverSearchResult(withSync)).toMatchObject({
      lastSuccessfulSyncAt: '2026-07-17T01:00:00.000Z',
      anomaly: 'Данные парка устарели; показана последняя успешная синхронизация',
    })
  })

  it('reports explicit six-park catalogue coverage instead of inferring it from the query', () => {
    const connections = [
      ['NASH_AVTOPARK', 'Наш Автопарк', '45e30e9d6b824c608e5d28719cb19a6e'],
      ['YOKO', 'YOKO', '3a23295d8d714c03b61a17a6fc86601b'],
      ['YOKO_2', 'YOKO-2', 'a0e45c39ffc64ecdaec96fe02cb221d9'],
      ['YOKO_3', 'YOKO-3', '9acdd6782806467ab284ac269a719324'],
      ['YOKO_4', 'YOKO-4', '02a96db4914c4a59adf874a1f07d97b7'],
      ['YOKO_DELIVERY', 'YOKO.Доставка', 'b3d310d51da54b15a9306420c820469e'],
    ].map(([parkCode, parkName, externalParkId], index) => ({
      parkId: `park-${index}`,
      apiConnectionId: `connection-${index}`,
      externalParkId,
      lastSuccessfulSyncAt: new Date(`2026-07-17T0${index}:00:00.000Z`),
      lastFailedSyncAt: null,
      lastErrorSummary: null,
      park: { parkCode, parkName },
    }))

    expect(buildDriverCatalogSummary(connections)).toMatchObject({
      source: 'local_nightly_sync',
      configuredParkCount: 6,
      availableParkCount: 6,
      coverage: 'complete',
      parks: expect.arrayContaining([
        expect.objectContaining({ parkCode: 'NASH_AVTOPARK', available: true }),
        expect.objectContaining({ parkCode: 'YOKO_DELIVERY', available: true }),
      ]),
    })
  })
})
