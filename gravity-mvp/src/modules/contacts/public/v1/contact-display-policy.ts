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
  return /^Контакт\s+(MAX|TG|WA|Telegram|WhatsApp)$/i.test(trimmed)
    || /^(MAX|TG|WA|Telegram|WhatsApp|Max)\s*[: ]\s*\d+$/i.test(trimmed)
    || /^[a-z]+:\d+$/i.test(trimmed)
    || /^\d{8,}$/.test(trimmed)
    || /@(lid|c\.us|g\.us|s\.whatsapp\.net|broadcast)$/i.test(trimmed)
}

/** The generic fallback used when no human-readable evidence is available. */
const GENERIC_CONTACT_DISPLAY_NAME = 'Контакт'

/**
 * The canonical display-name candidates, computed once.
 *
 * Both the canonical summary and the provider-neutral projection derive their
 * title from this, so the precedence rule — manual pin, then the confirmed
 * person, then an ordinary contact name, then the phone, then a safe provider
 * display name — exists in exactly one place. `stableProviderId` is the raw
 * provider external id and is a candidate only for the legacy canonical
 * summary; see buildProviderNeutralContactDisplayV1.
 */
function contactDisplayNameCandidates(input: {
  contact: any | null
  identities: any[]
  primaryPhone: string | null
  confirmedPersonName: string | null
}) {
  const { contact, identities, primaryPhone, confirmedPersonName } = input
  return {
    manualCanonicalName: contact?.canonicalPinnedAt || contact?.displayNameSource === 'manual'
      ? (!isTechnicalProviderName(contact?.displayName) ? contact.displayName : null)
      : null,
    confirmedFleetName: confirmedPersonName && !isTechnicalProviderName(confirmedPersonName)
      ? confirmedPersonName
      : null,
    normalContactName: !isTechnicalProviderName(contact?.displayName)
      ? contact.displayName
      : null,
    primaryPhone,
    providerName: identities
      .map((i: any) => i.displayName)
      .find((name: string | null | undefined) => name && !isTechnicalProviderName(name)) || null,
    stableProviderId: identities
      .map((identity: any) => String(identity.externalId || '').trim())
      .find(Boolean)
      || null,
  }
}

/** The one place a display title is composed, so both projections agree. */
function composeContactDisplayTitle(displayName: string, primaryPhone: string | null): string {
  return primaryPhone && primaryPhone !== displayName
    ? `${displayName} · ${primaryPhone}`
    : displayName
}

/** The canonical primary phone, formatted. `driverPhone` is a legacy fallback only. */
function canonicalPrimaryPhone(contact: any | null, phones: any[], driverPhone: string | null): string | null {
  return formatContactPhone(
    phones.find((p: any) => p.id === contact?.primaryPhoneId && p.lifecycle !== 'removed')?.phone
    || (!contact?.primaryPhoneId
      ? phones.find((p: any) => p.isActive !== false && !['removed', 'superseded'].includes(p.lifecycle))?.phone
      : null)
    || driverPhone
    || null,
  )
}

export type ProviderNeutralContactDisplayV1 = {
  displayName: string
  displayTitle: string
  primaryPhone: string | null
}

/**
 * The canonical Contact title with the provider-external-id fallback removed.
 *
 * `buildCanonicalContactSummary` may fall back to `ContactIdentity.externalId`
 * when a Contact has no other name, which puts a provider target — a Telegram
 * user id, a WhatsApp jid, a MAX sender id — into a human-readable field. Any
 * consumer that is provider-neutral by contract must therefore not use that
 * projection, and must not be trusted to strip the value afterwards: the
 * invariant lives here, where the precedence is decided, and is not expressible
 * as a caller convention such as passing an empty external id.
 *
 * Every other canonical rule is shared with the summary, including the technical
 * provider-name filter and the generic fallback. The confirmed person name is
 * supplied by the caller from Contacts-owned evidence (confirmedPersonNameV1) —
 * no Driver or Fleet row participates.
 */
export function buildProviderNeutralContactDisplayV1(input: {
  contact?: any | null
  confirmedPersonName?: string | null
}): ProviderNeutralContactDisplayV1 {
  const contact = input.contact || null
  const phones = Array.isArray(contact?.phones) ? contact.phones : []
  const identities = Array.isArray(contact?.identities) ? contact.identities : []
  const primaryPhone = canonicalPrimaryPhone(contact, phones, null)
  const candidates = contactDisplayNameCandidates({
    contact,
    identities,
    primaryPhone,
    confirmedPersonName: input.confirmedPersonName ?? null,
  })
  // stableProviderId is deliberately absent from this cascade.
  const displayName =
    candidates.manualCanonicalName
    || candidates.confirmedFleetName
    || candidates.normalContactName
    || candidates.primaryPhone
    || candidates.providerName
    || GENERIC_CONTACT_DISPLAY_NAME
  return {
    displayName,
    displayTitle: composeContactDisplayTitle(displayName, primaryPhone),
    primaryPhone,
  }
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
  const primaryPhone = canonicalPrimaryPhone(contact, phones, driver?.phone || null)
  const activeDriver = driver && !driver.dismissedAt ? driver : driver
  const hasConfirmedDriver = Boolean(
    contact?.driverConfirmations?.some?.((confirmation: any) => confirmation.status === 'confirmed')
      || activeDriver?.personResolutionStatus === 'confirmed'
      || activeDriver?.personResolutionStatus === 'operator_confirmed',
  )
  const candidates = contactDisplayNameCandidates({
    contact,
    identities,
    primaryPhone,
    confirmedPersonName: hasConfirmedDriver ? (activeDriver?.fullName ?? null) : null,
  })
  const { providerName, manualCanonicalName, confirmedFleetName, normalContactName, stableProviderId } = candidates
  const displayName =
    manualCanonicalName
    || confirmedFleetName
    || normalContactName
    || primaryPhone
    || providerName
    || stableProviderId
    || GENERIC_CONTACT_DISPLAY_NAME
  const displayTitle = composeContactDisplayTitle(displayName, primaryPhone)
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
