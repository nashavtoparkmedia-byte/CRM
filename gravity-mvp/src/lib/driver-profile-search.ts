import { normalizeContactPhoneDigits, normalizeContactSearchText } from '@/lib/contact-search'
import { getDriverProfileStatusLabel, getEmploymentTypeLabel } from '@/lib/contact-profile-ui'
import {
  buildYandexDispatcherTarget,
  type YandexDispatcherTarget,
} from '@/lib/driver-profiles/dispatcher-links'
import { APPROVED_PARKS } from '@/lib/driver-profiles/park-identity'

type DateValue = Date | string | null

export interface DriverProfileSearchContact {
  id: string
  displayName: string
  mainDriverId: string | null
  isArchived: boolean
  chats: Array<{ id: string }>
}

export interface DriverProfileSearchCandidate {
  id: string
  fullName: string
  phone: string | null
  yandexDriverId: string
  externalDriverProfileId: string | null
  externalParkId: string | null
  externalPersonKey: string | null
  dismissedAt: Date | null
  contactId: string | null
  park: { id: string; parkCode: string; parkName: string } | null
  parkId?: string | null
  sourceConnectionId?: string | null
  statusOverride?: string | null
  lastFleetCheckStatus?: string | null
  lastFleetCheckAt?: DateValue
  customFields?: unknown
  personResolutionStatus?: string | null
  updatedAt?: DateValue
  lastSuccessfulSyncAt?: DateValue
  lastFailedSyncAt?: DateValue
  lastErrorSummary?: string | null
  contact?: DriverProfileSearchContact | null
  dispatcherConnection?: DriverCatalogConnection | null
}

export interface DriverCatalogConnection {
  parkId: string
  apiConnectionId: string
  externalParkId: string
  lastSuccessfulSyncAt: DateValue
  lastFailedSyncAt: DateValue
  lastErrorSummary: string | null
  park: { parkCode: string; parkName: string }
}

export interface DriverCatalogParkState {
  parkCode: string
  parkName: string
  externalParkId: string
  available: boolean
  state: 'fresh' | 'stale' | 'never' | 'missing'
  lastSuccessfulSyncAt: string | null
  lastFailedSyncAt: string | null
}

export interface DriverSearchResult {
  id: string
  profileId: string
  first_name: string
  last_name: string
  fullName: string
  phones: string[]
  phone: string | null
  status: 'working' | 'dismissed' | 'unknown'
  statusLabel: string
  currentStatus: string | null
  park: { id: string; parkCode: string; parkName: string } | null
  externalDriverProfileId: string | null
  externalParkId: string | null
  yandexDriverId: string
  employmentType: string | null
  employmentTypeLabel: string
  lastSuccessfulSyncAt: string | null
  linkedContact: { id: string; displayName: string; chatId: string | null } | null
  contactId: string | null
  isMain: boolean
  anomaly: string | null
  anomalies: string[]
  dispatcher: YandexDispatcherTarget
}

export interface DriverCatalogSummary {
  source: 'local_nightly_sync'
  configuredParkCount: number
  availableParkCount: number
  coverage: 'complete' | 'partial'
  lastSuccessfulSyncAt: string | null
  parks: DriverCatalogParkState[]
}

function normalizedText(value: string | null | undefined): string {
  return normalizeContactSearchText(value || '')
}

function queryDigits(query: string): string {
  return normalizeContactPhoneDigits(query)
}

function compactNameParts(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean)
  return {
    firstName: parts[0] || fullName,
    lastName: parts.slice(1).join(' '),
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function dateOrNull(value: DateValue | undefined): Date | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function dateIsoOrNull(value: DateValue | undefined): string | null {
  return dateOrNull(value)?.toISOString() || null
}

function latestDateIso(values: Array<DateValue | undefined>): string | null {
  const timestamps = values
    .map(dateOrNull)
    .filter((value): value is Date => Boolean(value))
    .map(value => value.getTime())
  return timestamps.length > 0 ? new Date(Math.max(...timestamps)).toISOString() : null
}

function isStale(lastSuccessfulSyncAt: DateValue | undefined, lastFailedSyncAt: DateValue | undefined): boolean {
  const success = dateOrNull(lastSuccessfulSyncAt)
  const failed = dateOrNull(lastFailedSyncAt)
  return Boolean(failed && (!success || failed.getTime() > success.getTime()))
}

function findCatalogConnection(
  profile: DriverProfileSearchCandidate,
  connections: DriverCatalogConnection[],
): DriverCatalogConnection | null {
  return connections.find(connection =>
    Boolean(
      (profile.sourceConnectionId
        && connection.apiConnectionId === profile.sourceConnectionId
        && connection.externalParkId === profile.externalParkId)
      || (profile.parkId && connection.parkId === profile.parkId)
      || (profile.externalParkId && connection.externalParkId === profile.externalParkId),
    ),
  ) || null
}

export function addDriverCatalogSyncMetadata(
  profiles: DriverProfileSearchCandidate[],
  connections: DriverCatalogConnection[],
): DriverProfileSearchCandidate[] {
  return profiles.map(profile => {
    const connection = findCatalogConnection(profile, connections)
    return {
      ...profile,
      lastSuccessfulSyncAt: connection?.lastSuccessfulSyncAt || null,
      lastFailedSyncAt: connection?.lastFailedSyncAt || null,
      lastErrorSummary: connection?.lastErrorSummary || null,
      dispatcherConnection: connection,
    }
  })
}

export function buildDriverCatalogSummary(connections: DriverCatalogConnection[]): DriverCatalogSummary {
  const parks = APPROVED_PARKS.map(approvedPark => {
    const connection = connections.find(item =>
      item.externalParkId === approvedPark.externalParkId
      || item.park.parkCode === approvedPark.parkCode,
    )
    if (!connection) {
      return {
        parkCode: approvedPark.parkCode,
        parkName: approvedPark.parkName,
        externalParkId: approvedPark.externalParkId,
        available: false,
        state: 'missing' as const,
        lastSuccessfulSyncAt: null,
        lastFailedSyncAt: null,
      }
    }
    const success = dateIsoOrNull(connection.lastSuccessfulSyncAt)
    return {
      parkCode: approvedPark.parkCode,
      parkName: approvedPark.parkName,
      externalParkId: approvedPark.externalParkId,
      available: true,
      state: isStale(connection.lastSuccessfulSyncAt, connection.lastFailedSyncAt)
        ? 'stale' as const
        : success
          ? 'fresh' as const
          : 'never' as const,
      lastSuccessfulSyncAt: success,
      lastFailedSyncAt: dateIsoOrNull(connection.lastFailedSyncAt),
    }
  })
  const availableParkCount = parks.filter(park => park.available).length
  return {
    source: 'local_nightly_sync',
    configuredParkCount: APPROVED_PARKS.length,
    availableParkCount,
    coverage: availableParkCount === APPROVED_PARKS.length ? 'complete' : 'partial',
    lastSuccessfulSyncAt: latestDateIso(connections.map(connection => connection.lastSuccessfulSyncAt)),
    parks,
  }
}

export function matchesDriverProfileSearch(profile: DriverProfileSearchCandidate, query: string): boolean {
  const normalizedQuery = normalizedText(query)
  const digits = queryDigits(query)
  const searchableText = [
    profile.fullName,
    profile.yandexDriverId,
    profile.externalDriverProfileId,
    profile.externalParkId,
    profile.externalPersonKey,
    profile.park?.parkCode,
    profile.park?.parkName,
  ].map(normalizedText)

  if (digits.length >= 4 && normalizeContactPhoneDigits(profile.phone).includes(digits)) {
    return true
  }
  return normalizedQuery.length >= 2
    && searchableText.some(value => value.includes(normalizedQuery))
}

function matchScore(profile: DriverProfileSearchCandidate, query: string): number {
  const normalizedQuery = normalizedText(query)
  const digits = queryDigits(query)
  const phoneDigits = normalizeContactPhoneDigits(profile.phone)
  const externalIds = [
    profile.yandexDriverId,
    profile.externalDriverProfileId,
    profile.externalPersonKey,
  ].filter((value): value is string => Boolean(value))

  let score = profile.dismissedAt ? 0 : 10
  if (digits.length >= 4 && phoneDigits === digits) score += 100
  else if (digits.length >= 4 && phoneDigits.includes(digits)) score += 70
  if (externalIds.some(value => value === query)) score += 90
  else if (externalIds.some(value => value.startsWith(query))) score += 60
  const name = normalizedText(profile.fullName)
  if (name === normalizedQuery) score += 80
  else if (name.startsWith(normalizedQuery)) score += 50
  else if (name.includes(normalizedQuery)) score += 30
  return score
}

export function rankDriverProfileSearchResults(
  profiles: DriverProfileSearchCandidate[],
  query: string,
): DriverProfileSearchCandidate[] {
  return [...profiles].sort((left, right) => {
    const scoreDiff = matchScore(right, query) - matchScore(left, query)
    if (scoreDiff !== 0) return scoreDiff
    const parkDiff = (left.park?.parkName || '').localeCompare(right.park?.parkName || '', 'ru')
    if (parkDiff !== 0) return parkDiff
    return left.fullName.localeCompare(right.fullName, 'ru')
  })
}

export function toDriverSearchResult(profile: DriverProfileSearchCandidate): DriverSearchResult {
  const { firstName, lastName } = compactNameParts(profile.fullName)
  const customFields = asRecord(profile.customFields)
  const yandexProfile = asRecord(customFields.yandexProfile)
  const employmentType = stringOrNull(yandexProfile.employmentType)
  const status = profile.dismissedAt || profile.statusOverride === 'dismissed'
    ? 'dismissed'
    : profile.statusOverride === 'working'
      ? 'working'
      : 'unknown'
  const anomalies: string[] = []
  if (profile.personResolutionStatus === 'ambiguous') {
    anomalies.push('Неоднозначная идентификация человека')
  }
  if (!profile.externalDriverProfileId || !profile.externalParkId) {
    anomalies.push('Не заполнен внешний идентификатор профиля')
  }
  if (isStale(profile.lastSuccessfulSyncAt, profile.lastFailedSyncAt)) {
    anomalies.push('Данные парка устарели; показана последняя успешная синхронизация')
  }
  if (profile.contact?.isArchived) {
    anomalies.push('Профиль связан с архивным контактом')
  }
  const linkedContact = profile.contact
    ? {
        id: profile.contact.id,
        displayName: profile.contact.displayName,
        chatId: profile.contact.chats[0]?.id || null,
      }
    : null
  return {
    id: profile.id,
    profileId: profile.id,
    first_name: firstName,
    last_name: lastName,
    fullName: profile.fullName,
    phones: profile.phone ? [profile.phone] : [],
    phone: profile.phone,
    status,
    statusLabel: getDriverProfileStatusLabel(status),
    currentStatus: profile.lastFleetCheckStatus || null,
    park: profile.park,
    externalDriverProfileId: profile.externalDriverProfileId,
    externalParkId: profile.externalParkId,
    yandexDriverId: profile.yandexDriverId,
    employmentType,
    employmentTypeLabel: getEmploymentTypeLabel(employmentType),
    lastSuccessfulSyncAt: dateIsoOrNull(profile.lastSuccessfulSyncAt),
    linkedContact,
    contactId: profile.contactId,
    isMain: Boolean(profile.contact && profile.contact.mainDriverId === profile.id),
    anomaly: anomalies[0] || null,
    anomalies,
    dispatcher: buildYandexDispatcherTarget({
      profile: {
        externalDriverProfileId: profile.externalDriverProfileId,
        externalParkId: profile.externalParkId,
        phone: profile.phone,
        parkName: profile.park?.parkName || null,
      },
      connection: profile.dispatcherConnection
        ? {
            externalParkId: profile.dispatcherConnection.externalParkId,
            park: profile.dispatcherConnection.park,
          }
        : null,
      configuredBaseUrl: process.env.YANDEX_DISPATCHER_BASE_URL,
    }),
  }
}
