import { describe, expect, test } from 'vitest'

import {
  makeParkQualifiedDriverKeyV1,
  canAdoptUnqualifiedLegacyDriverProfileV1,
  normalizeDriverLicenceVuV1,
  yandexFleetProfileObservationV1,
} from './yandex-fleet-reconciler'

describe('Fleet profile identity and VU evidence', () => {
  test.each([
    ['12 34-567890', '1234567890'],
    ['AB 123456', 'AB123456'],
    ['АБ 123456', 'АБ123456'],
  ])('normalizes conservative valid source value %s', (raw, expected) => {
    expect(normalizeDriverLicenceVuV1(raw)).toBe(expected)
  })

  test.each(['', '12345', 'name-only', 'AА123456', '12/34/567890'])('rejects invalid or ambiguous value %s', raw => {
    expect(normalizeDriverLicenceVuV1(raw)).toBeNull()
  })

  test('park/profile composite is stable and park-qualified', () => {
    expect(makeParkQualifiedDriverKeyV1('park-a', 'profile-1'))
      .toBe(makeParkQualifiedDriverKeyV1('park-a', 'profile-1'))
    expect(makeParkQualifiedDriverKeyV1('park-a', 'profile-1'))
      .not.toBe(makeParkQualifiedDriverKeyV1('park-b', 'profile-1'))
  })

  test('never lets the first of several parks claim an unqualified legacy provider id', () => {
    expect(canAdoptUnqualifiedLegacyDriverProfileV1(1)).toBe(true)
    expect(canAdoptUnqualifiedLegacyDriverProfileV1(2)).toBe(false)
    expect(canAdoptUnqualifiedLegacyDriverProfileV1(6)).toBe(false)
  })

  test('preserves raw profile metadata while producing normalized comparison evidence', () => {
    const observedAt = new Date('2026-09-01T12:00:00.000Z')
    const observation = yandexFleetProfileObservationV1('park-a', 'local-a', 'connection-a', {
      driver_profile: {
        id: 'profile-1', last_name: 'Иванов', first_name: 'Иван', middle_name: 'Иванович',
        phones: ['8 (999) 000-00-00'], driver_license: { number: '12 34-567890' },
        legal_role: 'driver', work_status: 'working', city: 'Москва', profile_type: 'staff',
        created_date: '2024-01-01', modified_date: '2026-09-01',
      },
      current_status: { status: 'online', status_updated_at: '2026-09-01T11:00:00Z' },
    }, observedAt)
    expect(observation).toMatchObject({
      externalParkId: 'park-a', externalDriverProfileId: 'profile-1',
      fullName: 'Иванов Иван Иванович', phones: ['+79990000000'],
      rawVu: '12 34-567890', normalizedVu: '1234567890', legalRole: 'driver',
      workStatus: 'working', currentStatus: 'online', city: 'Москва', profileType: 'staff',
    })
    expect(observation?.rawMetadata).toHaveProperty('driverProfile')
  })
})
