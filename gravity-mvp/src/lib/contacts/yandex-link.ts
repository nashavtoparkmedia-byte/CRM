/**
 * linkContactToBestDriver — связка Contact ↔ Driver по телефону с
 * правильным выбором «лучшего» Driver если их несколько.
 *
 * Реальный кейс: один человек имеет два профиля в Yandex Fleet с
 * одним телефоном — например, без СМЗ (уволенный) + с СМЗ (активный).
 * Стандартный matcher в `monitoring/sync/route.ts` берёт «первого
 * попавшегося», и операторы видят бейдж от уволенного профиля. Эта
 * функция выбирает по приоритету:
 *
 *   1. Активный (dismissedAt = null) > уволенный
 *   2. Среди равных — с самым свежим `lastOrderAt`
 *
 * Идемпотентна — повторный вызов не делает дублей. Если Contact
 * уже привязан к лучшему Driver — noop. Если привязан к худшему —
 * переключает связку.
 *
 * Вызывается после каждого upsert Driver в `syncDriversByStatuses`
 * (drivers/actions.ts) — так связка обновляется на каждом тике
 * cron'а sync-trips, без дополнительных passes по БД.
 */

import { prisma } from '@/lib/prisma'
import { normalizePhoneE164 } from '@/lib/phoneUtils'

export interface LinkResult {
  action: 'noop' | 'linked' | 'switched' | 'no_contact' | 'no_driver'
  contactId?: string
  bestDriverId?: string
  previousDriverId?: string | null
  reason?: string
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
  // Сортируем: активный (dismissedAt = null) — выше; среди равных —
  // самый свежий lastOrderAt. Prisma не поддерживает сложный nulls-first
  // в ORDER BY для всех версий, поэтому сортируем в JS после fetch.
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

  drivers.sort((a, b) => {
    // Активный лучше уволенного
    const aActive = a.dismissedAt == null ? 0 : 1
    const bActive = b.dismissedAt == null ? 0 : 1
    if (aActive !== bActive) return aActive - bActive
    // Среди равных — свежий заказ лучше старого/отсутствующего
    const aOrder = a.lastOrderAt ? a.lastOrderAt.getTime() : 0
    const bOrder = b.lastOrderAt ? b.lastOrderAt.getTime() : 0
    return bOrder - aOrder
  })
  const best = drivers[0]

  // 2. Найти Contact с этим телефоном (через ContactPhone).
  const contactPhone = await prisma.contactPhone.findFirst({
    where: { phone: normalized, isActive: true },
    include: { contact: true },
  })
  if (!contactPhone) {
    // Contact ещё не существует — sync ничего не создаёт. Когда
    // придёт лид с этим номером (Avito и т.п.), LeadIntake создаст
    // Contact, и следующий тик cron'а свяжет.
    return { action: 'no_contact', reason: `no Contact with phone ${normalized}` }
  }
  const contact = contactPhone.contact

  // 3. Если уже связан с лучшим — ничего не делаем.
  if (contact.yandexDriverId === best.yandexDriverId) {
    return {
      action: 'noop',
      contactId: contact.id,
      bestDriverId: best.yandexDriverId,
    }
  }

  // 4. Связываем (или переподвязываем). displayName обновляем только
  // если оператор не редактировал вручную (displayNameSource != 'manual').
  const update: any = {
    yandexDriverId: best.yandexDriverId,
    masterSource: 'yandex',
  }
  if (contact.displayNameSource !== 'manual' && best.fullName) {
    update.displayName = best.fullName
    update.displayNameSource = 'yandex'
  }
  await prisma.contact.update({
    where: { id: contact.id },
    data: update,
  })

  // 5. ContactIdentity на yandex_pro — upsert (может быть от прошлого
  // привязанного Driver; перезаписываем на лучшего).
  await prisma.contactIdentity.upsert({
    where: {
      channel_externalId: {
        channel: 'yandex_pro',
        externalId: best.yandexDriverId,
      },
    },
    create: {
      contactId: contact.id,
      channel: 'yandex_pro',
      externalId: best.yandexDriverId,
      phoneId: contactPhone.id,
      source: 'yandex',
      confidence: 1.0,
    },
    update: {
      contactId: contact.id, // на случай если identity была у другого Contact
      phoneId: contactPhone.id,
    },
  })

  const wasLinked = contact.yandexDriverId != null
  console.log(
    `[yandex-link] ${wasLinked ? 'switched' : 'linked'} contact=${contact.id} ` +
      `phone=${normalized} → driver=${best.yandexDriverId} ` +
      `(prev=${contact.yandexDriverId ?? 'none'}; ` +
      `dismissed=${best.dismissedAt ? 'yes' : 'no'}; ` +
      `lastOrder=${best.lastOrderAt?.toISOString() ?? 'none'})`,
  )

  return {
    action: wasLinked ? 'switched' : 'linked',
    contactId: contact.id,
    bestDriverId: best.yandexDriverId,
    previousDriverId: contact.yandexDriverId,
  }
}
