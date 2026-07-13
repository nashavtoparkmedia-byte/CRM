import { prisma } from '@/lib/prisma'
import { normalizePhoneE164 } from '@/lib/phoneUtils'

export const PARK_PRIORITY = [
  'Наш Автопарк',
  'YOKO',
  'YOKO-2',
  'YOKO-3',
  'YOKO-4',
  'YOKO.Доставка',
] as const

const PARK_ALIASES: Record<string, string> = {
  'наш автопарк': 'Наш Автопарк',
  'нашавтопарк': 'Наш Автопарк',
  'yoko': 'YOKO',
  'yoko-2': 'YOKO-2',
  'yoko 2': 'YOKO-2',
  'yoko-3': 'YOKO-3',
  'yoko 3': 'YOKO-3',
  'yoko-4': 'YOKO-4',
  'yoko 4': 'YOKO-4',
  'yoko.доставка': 'YOKO.Доставка',
  'yoko доставка': 'YOKO.Доставка',
  'yoko.delivery': 'YOKO.Доставка',
}

export type DriverProfileStatus = 'working' | 'dismissed' | 'unknown'

export type DriverProfileCandidate = {
  id: string
  yandexDriverId: string
  fullName: string
  phone: string | null
  lastExternalPark: string | null
  statusOverride?: string | null
  dismissedAt: Date | string | null
  hiredAt?: Date | string | null
  lastOrderAt?: Date | string | null
}

export type DriverProfileAnomaly = {
  park: string
  activeCount: number
  driverIds: string[]
}

export type MainDriverDecision = {
  main: DriverProfileCandidate | null
  anomalies: DriverProfileAnomaly[]
  reason: 'manual' | 'park_priority' | 'no_active_profile'
}

export function normalizeParkName(value: string | null | undefined): string {
  const raw = (value || '').trim()
  if (!raw) return 'Парк не указан'
  const normalized = raw.replace(/\s+/g, ' ')
  const alias = PARK_ALIASES[normalized.toLowerCase()]
  if (alias) return alias
  const known = PARK_PRIORITY.find(park => park.toLowerCase() === normalized.toLowerCase())
  return known || normalized
}

export function getDriverProfileStatus(profile: Pick<DriverProfileCandidate, 'dismissedAt' | 'statusOverride'>): DriverProfileStatus {
  const override = (profile.statusOverride || '').toLowerCase()
  if (profile.dismissedAt || ['dismissed', 'fired', 'уволен', 'уволена'].includes(override)) return 'dismissed'
  if (['unknown', 'неизвестно'].includes(override)) return 'unknown'
  return 'working'
}

function parkRank(park: string | null | undefined): number {
  const normalized = normalizeParkName(park)
  const index = PARK_PRIORITY.indexOf(normalized as typeof PARK_PRIORITY[number])
  return index === -1 ? PARK_PRIORITY.length + 1 : index
}

export function chooseMainDriverProfile(
  profiles: DriverProfileCandidate[],
  manualMainDriverId?: string | null,
): MainDriverDecision {
  const working = profiles.filter(profile => getDriverProfileStatus(profile) === 'working')
  const byPark = new Map<string, DriverProfileCandidate[]>()
  for (const profile of working) {
    const park = normalizeParkName(profile.lastExternalPark)
    byPark.set(park, [...(byPark.get(park) || []), profile])
  }

  const anomalies = Array.from(byPark.entries())
    .filter(([, list]) => list.length > 1)
    .map(([park, list]) => ({ park, activeCount: list.length, driverIds: list.map(profile => profile.id) }))
  const anomalousParks = new Set(anomalies.map(item => item.park))

  if (manualMainDriverId) {
    const manual = working.find(profile => profile.id === manualMainDriverId)
    if (manual && !anomalousParks.has(normalizeParkName(manual.lastExternalPark))) {
      return { main: manual, anomalies, reason: 'manual' }
    }
  }

  const eligible = working.filter(profile => !anomalousParks.has(normalizeParkName(profile.lastExternalPark)))
  eligible.sort((a, b) => {
    const rankDiff = parkRank(a.lastExternalPark) - parkRank(b.lastExternalPark)
    if (rankDiff !== 0) return rankDiff
    const aHired = a.hiredAt ? new Date(a.hiredAt).getTime() : 0
    const bHired = b.hiredAt ? new Date(b.hiredAt).getTime() : 0
    if (aHired !== bHired) return bHired - aHired
    return a.yandexDriverId.localeCompare(b.yandexDriverId)
  })

  return { main: eligible[0] || null, anomalies, reason: eligible[0] ? 'park_priority' : 'no_active_profile' }
}

export async function refreshContactMainDriver(contactId: string, selectedBy = 'system') {
  const contact = await prisma.contact.findUnique({
    where: { id: contactId },
    select: { id: true, mainDriverId: true, mainDriverSelection: true },
  })
  if (!contact) return null

  const profiles = await prisma.driver.findMany({
    where: { contactId },
    select: {
      id: true,
      yandexDriverId: true,
      fullName: true,
      phone: true,
      lastExternalPark: true,
      statusOverride: true,
      dismissedAt: true,
      hiredAt: true,
      lastOrderAt: true,
    },
  })
  const manualId = contact.mainDriverSelection === 'manual' ? contact.mainDriverId : null
  const decision = chooseMainDriverProfile(profiles || [], manualId)
  const nextMainDriverId = decision.main?.id ?? null
  const nextSelection = decision.reason === 'manual' ? 'manual' : 'auto'

  if (contact.mainDriverId !== nextMainDriverId || contact.mainDriverSelection !== nextSelection) {
    await prisma.contact.update({
      where: { id: contactId },
      data: {
        mainDriverId: nextMainDriverId,
        mainDriverSelection: nextSelection,
        mainDriverSelectedBy: selectedBy,
        mainDriverSelectedAt: new Date(),
        yandexDriverId: decision.main?.yandexDriverId ?? null,
        ...(decision.main?.fullName ? { masterSource: 'yandex' as const } : {}),
      },
    })
    await prisma.contactDriverProfileAudit.create({
      data: {
        contactId,
        driverId: nextMainDriverId,
        previousMainDriverId: contact.mainDriverId,
        action: 'main_profile_auto_refresh',
        selectedBy,
        reason: decision.reason,
        metadata: { anomalies: decision.anomalies },
      },
    })
  }

  return decision
}

export async function setManualMainDriverProfile(contactId: string, driverId: string, selectedBy = 'operator') {
  const driver = await prisma.driver.findFirst({
    where: { id: driverId, contactId },
    select: { id: true, dismissedAt: true, statusOverride: true },
  })
  if (!driver) return { ok: false as const, error: 'driver_profile_not_found' }
  if (getDriverProfileStatus(driver) !== 'working') return { ok: false as const, error: 'driver_profile_not_active' }

  const contact = await prisma.contact.findUnique({ where: { id: contactId }, select: { mainDriverId: true } })
  await prisma.contact.update({
    where: { id: contactId },
    data: {
      mainDriverId: driverId,
      mainDriverSelection: 'manual',
      mainDriverSelectedBy: selectedBy,
      mainDriverSelectedAt: new Date(),
    },
  })
  await prisma.contactDriverProfileAudit.create({
    data: {
      contactId,
      driverId,
      previousMainDriverId: contact?.mainDriverId ?? null,
      action: 'main_profile_manual_set',
      selectedBy,
      reason: 'operator_selected_active_profile',
    },
  })
  return { ok: true as const }
}

export async function attachDriverProfilesToContactByPhone(phone: string | null | undefined, selectedBy = 'system') {
  const normalized = phone ? normalizePhoneE164(phone) : null
  if (!normalized) return { action: 'noop' as const, reason: 'phone could not be normalized' }

  const phoneOwners = await prisma.contactPhone.findMany({
    where: { phone: normalized, isActive: true },
    select: { contactId: true, contact: { select: { id: true, isArchived: true } } },
  })
  const activeOwnersByContact = new Map((phoneOwners || []).filter(owner => !owner.contact.isArchived).map(owner => [owner.contactId, owner]))
  if (activeOwnersByContact.size === 0) return { action: 'no_contact' as const, reason: `no Contact with phone ${normalized}` }
  if (activeOwnersByContact.size > 1) return { action: 'ambiguous_contact' as const, contactIds: Array.from(activeOwnersByContact.keys()) }

  const contactId = Array.from(activeOwnersByContact.keys())[0]
  const suffix = normalized.slice(-10)
  const drivers = await prisma.driver.findMany({
    where: {
      OR: [
        { phone: normalized },
        { phone: normalized.replace(/^\+/, '') },
        { phone: '8' + suffix },
        { phone: { endsWith: suffix } },
      ],
    },
    select: { id: true, contactId: true, externalPersonKey: true },
  })
  if (!drivers || drivers.length === 0) return { action: 'no_driver' as const, contactId }

  const conflicting = drivers.filter(driver => driver.contactId && driver.contactId !== contactId)
  if (conflicting.length > 0) return { action: 'ambiguous_driver_contact' as const, contactId, driverIds: conflicting.map(driver => driver.id) }

  const personKeys = Array.from(new Set(drivers.map(driver => driver.externalPersonKey).filter((key): key is string => Boolean(key))))
  if (personKeys.length !== 1 || drivers.some(driver => !driver.externalPersonKey)) {
    return {
      action: 'suggested_profiles' as const,
      contactId,
      profileCount: drivers.length,
      driverIds: drivers.map(driver => driver.id),
      reason: 'phone is not proof of cross-park person ownership',
    }
  }

  const unlinkedIds = drivers.filter(driver => driver.contactId !== contactId).map(driver => driver.id)
  if (unlinkedIds.length > 0) {
    await prisma.driver.updateMany({
      where: { id: { in: unlinkedIds }, externalPersonKey: personKeys[0] },
      data: {
        contactId,
        personResolutionStatus: 'proven',
        personResolutionBasis: 'STABLE_PROVIDER_PERSON_KEY',
        personResolutionAt: new Date(),
        personResolvedBy: selectedBy,
      },
    })
  }
  await refreshContactMainDriver(contactId, selectedBy)
  return { action: unlinkedIds.length > 0 ? 'linked_profiles' as const : 'noop' as const, contactId, linkedCount: unlinkedIds.length, profileCount: drivers.length }
}
