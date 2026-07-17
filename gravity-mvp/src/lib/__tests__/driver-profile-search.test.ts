import { describe, expect, it } from 'vitest'
import {
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
      park: { parkCode: 'YOKO', parkName: 'YOKO' },
    })
  })
})
