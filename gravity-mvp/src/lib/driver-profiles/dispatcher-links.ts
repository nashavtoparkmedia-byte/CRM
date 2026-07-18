export const DEFAULT_YANDEX_DISPATCHER_BASE_URL = 'https://fleet.yandex.ru'

export interface YandexDispatcherConnection {
  externalParkId: string
  park: {
    parkCode: string
    parkName: string
  }
}

export interface YandexDispatcherProfile {
  externalDriverProfileId: string | null
  externalParkId: string | null
  phone: string | null
  parkName: string | null
}

export interface YandexDispatcherTarget {
  mode: 'deep_link' | 'fallback' | 'unavailable'
  url: string | null
  parkRootUrl: string | null
  parkCode: string | null
  parkName: string
  externalParkId: string | null
  externalDriverProfileId: string | null
  phone: string | null
  reason: 'ready' | 'missing_profile_id' | 'missing_park_id' | 'park_connection_not_found'
}

function dispatcherBaseUrl(configuredBaseUrl: string | null | undefined): URL {
  try {
    const configured = new URL(configuredBaseUrl || DEFAULT_YANDEX_DISPATCHER_BASE_URL)
    if (configured.protocol !== 'https:') return new URL(DEFAULT_YANDEX_DISPATCHER_BASE_URL)
    configured.pathname = '/'
    configured.search = ''
    configured.hash = ''
    return configured
  } catch {
    return new URL(DEFAULT_YANDEX_DISPATCHER_BASE_URL)
  }
}

function dispatcherUrl(
  path: string,
  externalParkId: string,
  configuredBaseUrl?: string | null,
): string {
  const url = new URL(path, dispatcherBaseUrl(configuredBaseUrl))
  url.searchParams.set('park_id', externalParkId)
  return url.toString()
}

/**
 * Builds only routes already exercised by the fleet scraper:
 *   /map/drivers/<driver_profile.id>?park_id=<park.id>
 *   /contractors?park_id=<park.id>
 *
 * The ParkConnection match is mandatory. A tag, creation order, name or
 * legacy yandexDriverId is never used to guess the account.
 */
export function buildYandexDispatcherTarget(input: {
  profile: YandexDispatcherProfile
  connection: YandexDispatcherConnection | null
  configuredBaseUrl?: string | null
}): YandexDispatcherTarget {
  const { profile, connection, configuredBaseUrl } = input
  const externalParkId = profile.externalParkId?.trim() || null
  const externalDriverProfileId = profile.externalDriverProfileId?.trim() || null
  const parkName = connection?.park.parkName || profile.parkName || 'Парк не определён'

  if (!externalParkId) {
    return {
      mode: 'unavailable',
      url: null,
      parkRootUrl: null,
      parkCode: connection?.park.parkCode || null,
      parkName,
      externalParkId: null,
      externalDriverProfileId,
      phone: profile.phone,
      reason: 'missing_park_id',
    }
  }
  if (!connection || connection.externalParkId !== externalParkId) {
    return {
      mode: 'unavailable',
      url: null,
      parkRootUrl: null,
      parkCode: connection?.park.parkCode || null,
      parkName,
      externalParkId,
      externalDriverProfileId,
      phone: profile.phone,
      reason: 'park_connection_not_found',
    }
  }

  const parkRootUrl = dispatcherUrl('/contractors', externalParkId, configuredBaseUrl)
  if (!externalDriverProfileId) {
    return {
      mode: 'fallback',
      url: parkRootUrl,
      parkRootUrl,
      parkCode: connection.park.parkCode,
      parkName,
      externalParkId,
      externalDriverProfileId: null,
      phone: profile.phone,
      reason: 'missing_profile_id',
    }
  }

  return {
    mode: 'deep_link',
    url: dispatcherUrl(
      `/map/drivers/${encodeURIComponent(externalDriverProfileId)}`,
      externalParkId,
      configuredBaseUrl,
    ),
    parkRootUrl,
    parkCode: connection.park.parkCode,
    parkName,
    externalParkId,
    externalDriverProfileId,
    phone: profile.phone,
    reason: 'ready',
  }
}
