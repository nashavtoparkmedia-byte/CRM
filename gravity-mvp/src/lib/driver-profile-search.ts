import { normalizeContactPhoneDigits, normalizeContactSearchText } from '@/lib/contact-search'

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

export function toDriverSearchResult(profile: DriverProfileSearchCandidate) {
  const { firstName, lastName } = compactNameParts(profile.fullName)
  return {
    id: profile.id,
    profileId: profile.id,
    first_name: firstName,
    last_name: lastName,
    fullName: profile.fullName,
    phones: profile.phone ? [profile.phone] : [],
    phone: profile.phone,
    status: profile.dismissedAt ? 'dismissed' : 'working',
    park: profile.park,
    externalDriverProfileId: profile.externalDriverProfileId,
    externalParkId: profile.externalParkId,
    yandexDriverId: profile.yandexDriverId,
    contactId: profile.contactId,
  }
}
