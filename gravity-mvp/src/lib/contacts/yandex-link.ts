/**
 * linkContactToBestDriver — безопасная связка Contact ↔ Driver по
 * подтверждённому телефону.
 *
 * Важно: если найдено несколько Driver с одним телефоном, автоматический
 * выбор запрещён. Активность, dismissedAt и lastOrderAt можно использовать
 * только для диагностики/сортировки кандидатов оператору, но не как
 * доказательство личности.
 *
 * Вызывается после каждого upsert Driver в `syncDriversByStatuses`
 * (drivers/actions.ts) — так связка обновляется на каждом тике
 * cron'а sync-trips, без дополнительных passes по БД.
 */

import { prisma } from '@/lib/prisma'
import { normalizePhoneE164 } from '@/modules/contacts/public/v1/phone-identity'

export interface LinkResult {
  action: 'noop' | 'linked' | 'no_contact' | 'no_driver' | 'ambiguous'
  contactId?: string
  driverId?: string
  previousDriverYandexId?: string | null
  candidates?: Array<{
    id: string
    yandexDriverId: string
    dismissedAt: Date | null
    lastOrderAt: Date | null
  }>
  contactCandidates?: Array<{
    contactId: string
    contactPhoneId: string
    yandexDriverId: string | null
    isArchived: boolean
  }>
  reason?: string
}

function sortCandidatesForDiagnostics<T extends { dismissedAt: Date | null; lastOrderAt: Date | null }>(drivers: T[]): T[] {
  return [...drivers].sort((a, b) => {
    const aActive = a.dismissedAt == null ? 0 : 1
    const bActive = b.dismissedAt == null ? 0 : 1
    if (aActive !== bActive) return aActive - bActive
    const aOrder = a.lastOrderAt ? a.lastOrderAt.getTime() : 0
    const bOrder = b.lastOrderAt ? b.lastOrderAt.getTime() : 0
    return bOrder - aOrder
  })
}

function logAmbiguousYandexLink(
  normalizedPhone: string,
  contactId: string | null,
  candidates: LinkResult['candidates'],
) {
  console.warn(JSON.stringify({
    level: 'warn',
    event: 'contact_driver_match_ambiguous',
    source: 'yandex-link',
    phoneSuffix: normalizedPhone.slice(-4),
    contactId,
    candidateCount: candidates?.length ?? 0,
    candidates,
  }))
}

function logAmbiguousContactPhoneOwners(
  normalizedPhone: string,
  contactCandidates: NonNullable<LinkResult['contactCandidates']>,
) {
  console.warn(JSON.stringify({
    level: 'warn',
    event: 'contact_phone_owner_ambiguous',
    source: 'yandex-link',
    phoneSuffix: normalizedPhone.slice(-4),
    candidateCount: contactCandidates.length,
    contactCandidates,
  }))
}

/**
 * Найти Contact с этим телефоном и связать с лучшим Driver.
 * Если Contact не найден — ничего не делаем (создание Contact'а — это
 * задача LeadIntake / messages-pipeline, не sync'а).
 */
export async function linkContactToBestDriver(
  phone: string | null | undefined,
): Promise<LinkResult> {
  if (!phone) return { action: 'noop', reason: 'phone is empty' }
  const normalized = normalizePhoneE164(phone)
  if (!normalized) return { action: 'noop', reason: 'phone could not be normalized' }

  // 1. Найти все Driver с этим телефоном.
  const drivers = await prisma.driver.findMany({
    where: { phone: normalized },
    select: {
      id: true,
      yandexDriverId: true,
      fullName: true,
      dismissedAt: true,
      lastOrderAt: true,
    },
  })
  if (drivers.length === 0) {
    return { action: 'no_driver', reason: `no Driver with phone ${normalized}` }
  }

  // 2. Find all active phone owners. DB order, isArchived, primary phone,
  // and activity are not identity proof and must not pick a winner.
  const contactPhones = await prisma.contactPhone.findMany({
    where: { phone: normalized, isActive: true },
    include: { contact: true },
  })
  const contactPhonesByContactId = new Map<string, typeof contactPhones[number]>()
  for (const record of contactPhones) {
    if (!contactPhonesByContactId.has(record.contactId)) {
      contactPhonesByContactId.set(record.contactId, record)
    }
  }

  if (contactPhonesByContactId.size === 0) {
    // Contact does not exist yet; this sync does not create it.
    return { action: 'no_contact', reason: `no Contact with phone ${normalized}` }
  }

  if (contactPhonesByContactId.size > 1) {
    const contactCandidates = Array.from(contactPhonesByContactId.values()).map(record => ({
      contactId: record.contactId,
      contactPhoneId: record.id,
      yandexDriverId: record.contact.yandexDriverId,
      isArchived: record.contact.isArchived,
    }))
    logAmbiguousContactPhoneOwners(normalized, contactCandidates)
    return {
      action: 'ambiguous',
      contactCandidates,
      reason: `multiple Contacts with phone ${normalized}`,
    }
  }

  const contactPhone = contactPhonesByContactId.values().next().value
  if (!contactPhone) {
    return { action: 'no_contact', reason: `no Contact with phone ${normalized}` }
  }
  const contact = contactPhone.contact

  if (drivers.length > 1) {
    const candidates = sortCandidatesForDiagnostics(drivers).map(driver => ({
      id: driver.id,
      yandexDriverId: driver.yandexDriverId,
      dismissedAt: driver.dismissedAt,
      lastOrderAt: driver.lastOrderAt,
    }))
    logAmbiguousYandexLink(normalized, contact.id, candidates)
    return {
      action: 'ambiguous',
      contactId: contact.id,
      previousDriverYandexId: contact.yandexDriverId,
      candidates,
      reason: `multiple Drivers with phone ${normalized}`,
    }
  }

  const matched = drivers[0]

  // 3. Если уже связан с единственным найденным Driver — ничего не делаем.
  if (contact.yandexDriverId === matched.yandexDriverId) {
    return {
      action: 'noop',
      contactId: contact.id,
      driverId: matched.yandexDriverId,
    }
  }

  if (contact.yandexDriverId && contact.yandexDriverId !== matched.yandexDriverId) {
    console.warn(JSON.stringify({
      level: 'warn',
      event: 'contact_driver_existing_link_conflict',
      source: 'yandex-link',
      contactId: contact.id,
      existingYandexDriverId: contact.yandexDriverId,
      matchedYandexDriverId: matched.yandexDriverId,
      phoneSuffix: normalized.slice(-4),
    }))
    return {
      action: 'noop',
      contactId: contact.id,
      driverId: contact.yandexDriverId,
      reason: `contact already linked to another Driver (${contact.yandexDriverId})`,
    }
  }

  // 4. Связываем. displayName обновляем только
  // если оператор не редактировал вручную (displayNameSource != 'manual').
  const update: any = {
    yandexDriverId: matched.yandexDriverId,
    masterSource: 'yandex',
  }
  if (contact.displayNameSource !== 'manual' && matched.fullName) {
    update.displayName = matched.fullName
    update.displayNameSource = 'yandex'
  }
  await prisma.contact.update({
    where: { id: contact.id },
    data: update,
  })

  console.log(
    `[yandex-link] linked contact=${contact.id} ` +
      `phone=${normalized} → driver=${matched.yandexDriverId} ` +
      `(prev=${contact.yandexDriverId ?? 'none'}; ` +
      `dismissed=${matched.dismissedAt ? 'yes' : 'no'}; ` +
      `lastOrder=${matched.lastOrderAt?.toISOString() ?? 'none'})`,
  )

  return {
    action: 'linked',
    contactId: contact.id,
    driverId: matched.yandexDriverId,
    previousDriverYandexId: contact.yandexDriverId,
  }
}
