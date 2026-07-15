import {
  CONTACT_PROFILE_PARK_ORDER,
  type ContactDriverProfilePayload,
  type DriverProfileStatus,
} from './contact-profile-contract'

const EMPLOYMENT_TYPE_LABELS: Record<string, string> = {
  park_employee: 'Физлицо',
  selfemployed: 'Парковый СМЗ',
  individual_entrepreneur: 'Парковый ИП',
}

const STATUS_LABELS: Record<DriverProfileStatus, string> = {
  working: 'Работает',
  dismissed: 'Уволен',
  unknown: 'Статус не определён',
}

export function getEmploymentTypeLabel(code: string | null | undefined): string {
  if (!code) return 'Тип оформления не определён'
  return EMPLOYMENT_TYPE_LABELS[code.trim().toLowerCase()] || 'Тип оформления не определён'
}

export function getDriverProfileStatusLabel(status: DriverProfileStatus): string {
  return STATUS_LABELS[status]
}

export function getSuggestionBasis(matchedSignals: string[] | null | undefined): {
  code: string
  label: string
} {
  if (matchedSignals?.includes('phone')) {
    return { code: 'phone', label: 'Совпадение номера телефона' }
  }
  return { code: 'unknown', label: 'Основание предложения не определено' }
}

export function countUniqueProviderChannels(
  channels: Array<string | { channel: string }> | null | undefined,
): number {
  return new Set((channels || [])
    .map(item => typeof item === 'string' ? item : item.channel)
    .map(channel => channel.trim().toLowerCase())
    .filter(Boolean)).size
}

export function formatProviderChannelCount(count: number): string {
  return `${count} ${russianForm(count, 'канал', 'канала', 'каналов')}`
}

export function getIdentitySourceLabel(source: string | null | undefined): string {
  if (source === 'auto') return 'Автоматически'
  if (source === 'manual') return 'Вручную'
  return 'Связан'
}

function russianForm(count: number, one: string, few: string, many: string): string {
  const mod100 = Math.abs(count) % 100
  const mod10 = mod100 % 10
  if (mod100 >= 11 && mod100 <= 14) return many
  if (mod10 === 1) return one
  if (mod10 >= 2 && mod10 <= 4) return few
  return many
}

export function profileWord(count: number): string {
  return russianForm(count, 'профиль', 'профиля', 'профилей')
}

export function parkWord(count: number): string {
  return russianForm(count, 'парк', 'парка', 'парков')
}

export function formatAttachedProfilesHeader(profileCount: number, parkCount: number): string {
  return `Профили водителя: ${profileCount} в ${parkCount} ${parkCount === 1 ? 'парке' : 'парках'}`
}

export function formatFoundProfilesSummary(profileCount: number, parkCount: number): string {
  const verb = profileCount === 1 ? 'Найден' : 'Найдено'
  const parkForm = parkCount === 1 ? 'парке' : 'парках'
  return `${verb} ${profileCount} ${profileWord(profileCount)} в ${parkCount} ${parkForm}`
}

export function formatSelectedProfilesSummary(profileCount: number, parkCount: number): string {
  const verb = profileCount === 1 ? 'Выбран' : 'Выбрано'
  const parkForm = parkCount === 1 ? 'парка' : 'парков'
  return `${verb} ${profileCount} ${profileWord(profileCount)} из ${parkCount} ${parkForm}`
}

export function formatAttachButton(profileCount: number): string {
  return profileCount === 0
    ? 'Привязать выбранные'
    : `Привязать ${profileCount} ${profileWord(profileCount)}`
}

export function profileParkKey(profile: Pick<ContactDriverProfilePayload, 'parkCode' | 'parkName'>): string {
  return profile.parkCode || `name:${profile.parkName}`
}

function parkRank(parkName: string): number {
  const index = CONTACT_PROFILE_PARK_ORDER.indexOf(parkName as typeof CONTACT_PROFILE_PARK_ORDER[number])
  return index === -1 ? CONTACT_PROFILE_PARK_ORDER.length : index
}

export interface DriverProfileParkGroup {
  key: string
  parkCode: string | null
  parkName: string
  active: ContactDriverProfilePayload[]
  dismissed: ContactDriverProfilePayload[]
  activeCount: number
}

export function groupDriverProfilesByPark(profiles: ContactDriverProfilePayload[]): DriverProfileParkGroup[] {
  const groups = new Map<string, DriverProfileParkGroup>()
  for (const profile of profiles) {
    const key = profileParkKey(profile)
    const group = groups.get(key) || {
      key,
      parkCode: profile.parkCode,
      parkName: profile.parkName || 'Парк не указан',
      active: [],
      dismissed: [],
      activeCount: 0,
    }
    const status = profile.normalizedStatus || profile.status
    if (status === 'dismissed') group.dismissed.push(profile)
    else group.active.push(profile)
    if (status === 'working') group.activeCount += 1
    groups.set(key, group)
  }

  const byName = (left: ContactDriverProfilePayload, right: ContactDriverProfilePayload) =>
    left.fullName.localeCompare(right.fullName, 'ru') || left.id.localeCompare(right.id)

  return Array.from(groups.values())
    .map(group => ({
      ...group,
      active: group.active.sort(byName),
      dismissed: group.dismissed.sort(byName),
    }))
    .sort((left, right) => {
      const rank = parkRank(left.parkName) - parkRank(right.parkName)
      return rank || left.parkName.localeCompare(right.parkName, 'ru')
    })
}

export function getUniqueSelectedParkCount(profiles: ContactDriverProfilePayload[]): number {
  return new Set(profiles.map(profileParkKey)).size
}

export function isSuggestedProfileSelectable(profile: ContactDriverProfilePayload): boolean {
  return !profile.linkedContactConflict && !profile.conflictContactId
}
