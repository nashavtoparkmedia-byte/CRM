import {
  CONTACT_PROFILE_PARK_ORDER,
  type CanonicalContactSummaryPayload,
} from './contact-profile-contract'

interface ContactPhoneDisplayInput {
  id?: string
  phone: string
  isPrimary?: boolean
}

interface ContactIdentityDisplayInput {
  channel: string
  externalId: string
  displayName?: string | null
  metadata?: unknown
}

interface DriverProfileDisplayInput {
  id: string
  fullName: string
  phone?: string | null
  segment?: string | null
  dismissedAt?: string | Date | null
  lastExternalPark?: string | null
  parkName?: string | null
}

interface ContactDisplayInput {
  displayName?: string | null
  displayNameSource?: string | null
  primaryPhoneId?: string | null
  mainDriverId?: string | null
  phones?: ContactPhoneDisplayInput[]
  identities?: ContactIdentityDisplayInput[]
}

const CHANNEL_CONTACT_LABEL: Record<string, string> = {
  max: 'Контакт MAX',
  telegram: 'Контакт Telegram',
  whatsapp: 'Контакт WhatsApp',
}

const SEGMENT_LABELS: Record<string, string> = {
  small: 'Малый',
  medium: 'Средний',
  profitable: 'Прибыльный',
  high: 'Прибыльный',
  vip: 'VIP',
  active: 'Активный',
  new: 'Новый',
  inactive: 'Неактивный',
  sleeping: 'Спящий',
  churned: 'Ушёл',
  dropped: 'Выпал',
  unknown: 'Не определён',
}

export function formatContactPhone(phone?: string | null): string | null {
  if (!phone) return null
  const digits = phone.replace(/\D/g, '')
  if (digits.length === 11 && (digits.startsWith('7') || digits.startsWith('8'))) {
    return `+7 ${digits.slice(1, 4)} ${digits.slice(4, 7)}-${digits.slice(7, 9)}-${digits.slice(9)}`
  }
  if (digits.length === 10) {
    return `+7 ${digits.slice(0, 3)} ${digits.slice(3, 6)}-${digits.slice(6, 8)}-${digits.slice(8)}`
  }
  return phone
}

export function getSegmentLabel(segment?: string | null): string {
  if (!segment) return 'Не определён'
  return SEGMENT_LABELS[segment.trim().toLowerCase()] || 'Не определён'
}

export function isTechnicalProviderName(value?: string | null): boolean {
  if (!value?.trim()) return true
  const trimmed = value.trim()
  return /^(MAX|TG|WA|Telegram|WhatsApp|Max)\s*[: ]\s*\d+$/i.test(trimmed)
    || /^[a-z]+:\d+$/i.test(trimmed)
    || /^\+?[\d\s()\-]{10,}$/.test(trimmed)
    || /^\d{8,}$/.test(trimmed)
    || /@(lid|c\.us|g\.us|s\.whatsapp\.net|broadcast)$/i.test(trimmed)
}

function parkRank(profile: DriverProfileDisplayInput): number {
  const parkName = profile.parkName || profile.lastExternalPark || ''
  const index = CONTACT_PROFILE_PARK_ORDER.indexOf(
    parkName as typeof CONTACT_PROFILE_PARK_ORDER[number],
  )
  return index === -1 ? CONTACT_PROFILE_PARK_ORDER.length : index
}

function chooseDisplayProfile(
  profiles: DriverProfileDisplayInput[],
  mainDriverId?: string | null,
): DriverProfileDisplayInput | null {
  const active = profiles.filter(profile => !profile.dismissedAt)
  const selectedMain = active.find(profile => profile.id === mainDriverId)
  if (selectedMain) return selectedMain
  return [...active].sort((left, right) =>
    parkRank(left) - parkRank(right)
    || left.fullName.localeCompare(right.fullName, 'ru')
    || left.id.localeCompare(right.id)
  )[0] || null
}

function providerDisplayName(identity: ContactIdentityDisplayInput): string | null {
  if (identity.displayName && !isTechnicalProviderName(identity.displayName)) {
    return identity.displayName.trim()
  }
  const metadata = identity.metadata && typeof identity.metadata === 'object' && !Array.isArray(identity.metadata)
    ? identity.metadata as Record<string, unknown>
    : null
  const readMetadataString = (key: string) => {
    const value = metadata?.[key]
    return typeof value === 'string' ? value.trim() : ''
  }
  const firstName = readMetadataString('firstName')
  const lastName = readMetadataString('lastName')
  const fullName = [firstName, lastName].filter(Boolean).join(' ')
  if (fullName) return fullName
  const username = readMetadataString('username')
  return username ? `@${username.replace(/^@/, '')}` : null
}

export function buildCanonicalContactSummary(input: {
  contact: ContactDisplayInput
  profiles?: DriverProfileDisplayInput[]
  currentChannel?: string | null
  providerChannels?: string[]
}): CanonicalContactSummaryPayload {
  const phones = input.contact.phones || []
  const identities = input.contact.identities || []
  const profile = chooseDisplayProfile(input.profiles || [], input.contact.mainDriverId)
  const primaryPhoneRaw = phones.find(phone => phone.id === input.contact.primaryPhoneId)?.phone
    || phones.find(phone => phone.isPrimary)?.phone
    || phones[0]?.phone
    || profile?.phone
    || null
  const primaryPhone = formatContactPhone(primaryPhoneRaw)
  const contactName = !isTechnicalProviderName(input.contact.displayName)
    ? input.contact.displayName!.trim()
    : null
  const manualContactName = input.contact.displayNameSource === 'manual' ? contactName : null
  const identityName = identities.map(providerDisplayName).find(Boolean) || null
  const currentChannel = input.currentChannel?.trim().toLowerCase() || null
  const displayName = manualContactName
    || profile?.fullName?.trim()
    || identityName
    || contactName
    || primaryPhone
    || CHANNEL_CONTACT_LABEL[currentChannel || '']
    || 'Контакт'
  const displayTitle = primaryPhone && primaryPhone !== displayName
    ? `${displayName} · ${primaryPhone}`
    : displayName
  const providerIdentities = identities.map(identity => ({
    channel: identity.channel,
    externalId: identity.externalId,
    displayName: identity.displayName || null,
  }))
  const providerChannels = input.providerChannels || providerIdentities.map(identity => identity.channel)

  return {
    displayName,
    primaryPhone,
    displayTitle,
    currentMainDriverProfile: profile ? {
      id: profile.id,
      fullName: profile.fullName,
      phone: profile.phone || null,
      segment: profile.segment || null,
    } : null,
    currentChannel,
    providerIdentities,
    channelCount: new Set(providerChannels.map(channel => channel.trim().toLowerCase()).filter(Boolean)).size,
  }
}
