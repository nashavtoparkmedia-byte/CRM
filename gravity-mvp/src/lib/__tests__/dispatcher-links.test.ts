import { describe, expect, test } from 'vitest'

import {
  buildYandexDispatcherTarget,
  DEFAULT_YANDEX_DISPATCHER_BASE_URL,
} from '@/lib/driver-profiles/dispatcher-links'
import { APPROVED_PARKS } from '@/lib/driver-profiles/park-identity'

describe('Yandex dispatcher links', () => {
  test.each(APPROVED_PARKS)('builds a proven deep link for $parkCode', approvedPark => {
    const target = buildYandexDispatcherTarget({
      profile: {
        externalDriverProfileId: `driver-profile-${approvedPark.parkCode}`,
        externalParkId: approvedPark.externalParkId,
        phone: '+79222155750',
        parkName: approvedPark.parkName,
      },
      connection: {
        externalParkId: approvedPark.externalParkId,
        park: {
          parkCode: approvedPark.parkCode,
          parkName: approvedPark.parkName,
        },
      },
    })

    expect(target).toMatchObject({
      mode: 'deep_link',
      parkCode: approvedPark.parkCode,
      parkName: approvedPark.parkName,
      externalParkId: approvedPark.externalParkId,
      reason: 'ready',
    })
    expect(target.url).toBe(
      `${DEFAULT_YANDEX_DISPATCHER_BASE_URL}/map/drivers/driver-profile-${approvedPark.parkCode}?park_id=${approvedPark.externalParkId}`,
    )
    expect(target.parkRootUrl).toBe(
      `${DEFAULT_YANDEX_DISPATCHER_BASE_URL}/contractors?park_id=${approvedPark.externalParkId}`,
    )
  })

  test('falls back to the proven park driver list when a direct profile ID is unavailable', () => {
    const approvedPark = APPROVED_PARKS[0]
    expect(buildYandexDispatcherTarget({
      profile: {
        externalDriverProfileId: null,
        externalParkId: approvedPark.externalParkId,
        phone: '+79222155750',
        parkName: approvedPark.parkName,
      },
      connection: {
        externalParkId: approvedPark.externalParkId,
        park: { parkCode: approvedPark.parkCode, parkName: approvedPark.parkName },
      },
    })).toMatchObject({
      mode: 'fallback',
      url: `${DEFAULT_YANDEX_DISPATCHER_BASE_URL}/contractors?park_id=${approvedPark.externalParkId}`,
      externalDriverProfileId: null,
      phone: '+79222155750',
      reason: 'missing_profile_id',
    })
  })

  test('does not guess an account when ParkConnection does not match the profile park', () => {
    expect(buildYandexDispatcherTarget({
      profile: {
        externalDriverProfileId: 'driver-profile-1',
        externalParkId: APPROVED_PARKS[0].externalParkId,
        phone: '+79222155750',
        parkName: APPROVED_PARKS[0].parkName,
      },
      connection: {
        externalParkId: APPROVED_PARKS[1].externalParkId,
        park: { parkCode: APPROVED_PARKS[1].parkCode, parkName: APPROVED_PARKS[1].parkName },
      },
    })).toMatchObject({
      mode: 'unavailable',
      url: null,
      parkRootUrl: null,
      reason: 'park_connection_not_found',
    })
  })

  test('encodes provider IDs and rejects an unsafe configured protocol', () => {
    const approvedPark = APPROVED_PARKS[1]
    const target = buildYandexDispatcherTarget({
      profile: {
        externalDriverProfileId: 'profile/with?delimiters',
        externalParkId: approvedPark.externalParkId,
        phone: null,
        parkName: approvedPark.parkName,
      },
      connection: {
        externalParkId: approvedPark.externalParkId,
        park: { parkCode: approvedPark.parkCode, parkName: approvedPark.parkName },
      },
      configuredBaseUrl: 'http://unsafe.example.test',
    })
    expect(target.url).toBe(
      `${DEFAULT_YANDEX_DISPATCHER_BASE_URL}/map/drivers/profile%2Fwith%3Fdelimiters?park_id=${approvedPark.externalParkId}`,
    )
  })
})
