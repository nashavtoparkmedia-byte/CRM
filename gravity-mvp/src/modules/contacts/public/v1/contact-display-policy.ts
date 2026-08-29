// Shared canonical Contact display rules for Messages UI/API.
// Rebuild marker for canonical Contact title deploy.
// Rebuild marker after Docker image cleanup.
export type CanonicalContactSummary = {
  displayName: string
  primaryPhone: string | null
  displayTitle: string
  currentMainDriverProfile: {
    id: string
    fullName: string
    phone: string | null
    segment: string | null
  } | null
  currentChannel: string | null
  providerIdentities: { channel: string; externalId: string; displayName: string | null }[]
  channelCount: number
}

const CHANNEL_CONTACT_LABEL: Record<string, string> = {
  max: 'Контакт MAX',
  telegram: 'Контакт Telegram',
  whatsapp: 'Контакт WhatsApp',
}

export const SEGMENT_LABELS: Record<string, string> = {
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
  const digits = String(phone).replace(/\D/g, '')
  if (digits.length === 11 && (digits[0] === '7' || digits[0] === '8')) {
    return `+7 ${digits.slice(1, 4)} ${digits.slice(4, 7)}-${digits.slice(7, 9)}-${digits.slice(9)}`
  }
  if (digits.length === 10) {
    return `+7 ${digits.slice(0, 3)} ${digits.slice(3, 6)}-${digits.slice(6, 8)}-${digits.slice(8)}`
  }
  return phone
}

export function getSegmentLabel(segment?: string | null): string {
  if (!segment) return 'Не определён'
  return SEGMENT_LABELS[segment] || 'Не определён'
}

function isTechnicalProviderName(value?: string | null): boolean {
  if (!value) return true
  const trimmed = value.trim()
  return /^(MAX|TG|WA|Telegram|WhatsApp|Max)\s*[: ]\s*\d+$/i.test(trimmed)
    || /^[a-z]+:\d+$/i.test(trimmed)
    || /^\d{8,}$/.test(trimmed)
    || /@(lid|c\.us|g\.us|s\.whatsapp\.net|broadcast)$/i.test(trimmed)
}

export function buildCanonicalContactSummary(input: {
  contact?: any | null
  driver?: any | null
  currentChannel?: string | null
}): CanonicalContactSummary {
  const contact = input.contact || null
  const driver = input.driver || null
  const phones = Array.isArray(contact?.phones) ? contact.phones : []
  const identities = Array.isArray(contact?.identities) ? contact.identities : []
  const primaryPhoneRaw =
    phones.find((p: any) => p.id && p.id === contact?.primaryPhoneId)?.phone
    || phones.find((p: any) => p.isPrimary)?.phone
    || phones[0]?.phone
    || driver?.phone
    || null
  const primaryPhone = formatContactPhone(primaryPhoneRaw)
  const activeDriver = driver && !driver.dismissedAt ? driver : driver
  const providerName = identities
    .map((i: any) => i.displayName)
    .find((name: string | null | undefined) => name && !isTechnicalProviderName(name))
  const displayName =
    activeDriver?.fullName
    || (!isTechnicalProviderName(contact?.displayName) ? contact?.displayName : null)
    || providerName
    || primaryPhone
    || CHANNEL_CONTACT_LABEL[input.currentChannel || '']
    || 'Контакт'
  const displayTitle = primaryPhone && primaryPhone !== displayName
    ? `${displayName} · ${primaryPhone}`
    : displayName
  const providerIdentities = identities.map((i: any) => ({
    channel: i.channel,
    externalId: i.externalId,
    displayName: i.displayName || null,
  }))
  const channelCount = new Set(providerIdentities.map((i: any) => i.channel)).size

  return {
    displayName,
    primaryPhone,
    displayTitle,
    currentMainDriverProfile: activeDriver ? {
      id: activeDriver.id,
      fullName: activeDriver.fullName,
      phone: activeDriver.phone || null,
      segment: activeDriver.segment || null,
    } : null,
    currentChannel: input.currentChannel || null,
    providerIdentities,
    channelCount,
  }
}
