/**
 * LeadIntake — единый сервис «лид появился → создаём CRM-сущности».
 *
 * Pipeline:
 *   1. resolveContact() (через ContactService) — найти/создать Contact + ContactIdentity
 *   2. find-or-create Chat (один на пару Contact + source)
 *   3. append Message (inbound, preview из лида)
 *   4. (опционально) create Task — пока пропускаем, т.к. UI задач требует доработки
 *      под nullable driverId. Будет включено отдельной фазой.
 *
 * Webhook'и из Avito-worker'а (или catchup-sync) вызывают:
 *   - ingestLead(...)            — на новый отклик
 *   - updateLeadPhone(...)       — когда worker раскрыл телефон позже
 *
 * Идемпотентность:
 *   - resolveContact уже идемпотентен (channel+externalId unique)
 *   - Chat ищется по (contactId, channel) — повторный вызов вернёт тот же
 *   - Message дедуплицируется по externalId
 */

import { prisma } from '@/lib/prisma'
import { ContactService } from '@/lib/ContactService'
import { normalizePhoneE164 } from '@/lib/phoneUtils'
import type { ChatChannel } from '@prisma/client'
import type { LeadSource } from './types'

// LeadSource → ChatChannel. У нас сейчас полное совпадение (avito,
// whatsapp, telegram, phone), но 'site' не имеет канала в чатах.
// Для site-лидов Chat не создаётся — оператор работает с ними в
// другом месте (телефонный обзвон). Возвращаем null чтобы вызывающий
// мог skip создание чата.
function leadSourceToChatChannel(source: LeadSource): ChatChannel | null {
  switch (source) {
    case 'avito':
      return 'avito'
    case 'whatsapp':
      return 'whatsapp'
    case 'telegram':
      return 'telegram'
    case 'phone':
      return 'phone'
    case 'site':
      return null
  }
}

export interface IngestLeadInput {
  source: LeadSource
  /** Уникальный идентификатор лида внутри источника (avito_responses.external_id) */
  sourceExternalId: string
  /** Имя кандидата из источника (может быть null) */
  candidateName: string | null
  /** Телефон в свободной форме (если есть на момент создания) */
  phone: string | null
  /** Превью первого сообщения (отображается в /messages) */
  preview: string | null
  /** Когда лид появился (received_at источника) */
  receivedAt: Date
  /** Источникоспецифичные метаданные — кладутся в Chat.metadata и Message.metadata */
  sourceMeta?: Record<string, unknown>
  /** Заголовок Chat для UI (например "Иван — Курьер на личном авто") */
  chatTitle?: string | null
}

export interface IngestLeadResult {
  contactId: string
  chatId: string | null
  messageId: string | null
  taskId: string | null
  /** true если Contact был создан в этом вызове, false если уже существовал */
  contactCreated: boolean
}

/**
 * Главный entry-point — обрабатывает новый лид целиком.
 * Идемпотентен: повторный вызов для того же sourceExternalId не создаёт дублей.
 */
export async function ingestLead(input: IngestLeadInput): Promise<IngestLeadResult> {
  const channel = leadSourceToChatChannel(input.source)

  // ─── Step 1: Contact + Identity ─────────────────────────────────────
  // Для site-лидов канала нет — создаём Contact напрямую без Identity
  // (ContactService требует ChatChannel; для site-канала возможно
  // расширим enum позже).
  if (!channel) {
    throw new Error(
      `[LeadIntake] source='${input.source}' has no chat channel — site/web leads not yet supported`,
    )
  }

  const resolved = await ContactService.resolveContact(
    channel,
    input.sourceExternalId,
    input.phone,
    input.candidateName,
  )

  // ─── Step 2: Find or create Chat (один на пару Contact + channel) ──
  // Сначала ищем существующий чат для этого контакта и канала. Если
  // есть — переиспользуем (повторные отклики ложатся в тот же чат).
  // Если нет — создаём.
  let chat = await prisma.chat.findFirst({
    where: {
      contactId: resolved.contact.id,
      channel,
    },
    orderBy: { lastMessageAt: 'desc' },
  })

  if (!chat) {
    // Уникальный externalChatId. Берём первый externalId источника —
    // дальше Chat может содержать сообщения от других откликов того же
    // контакта; externalChatId остаётся «именем рождения». Префикс
    // канала — чтобы не было коллизий с другими источниками в этой
    // таблице.
    const externalChatId = `${input.source}:contact:${resolved.contact.id}`
    chat = await prisma.chat.create({
      data: {
        channel,
        externalChatId,
        contactId: resolved.contact.id,
        contactIdentityId: resolved.identity.id,
        name: input.chatTitle ?? input.candidateName ?? null,
        status: 'new',
        requiresResponse: true,
        lastMessageAt: input.receivedAt,
        lastInboundAt: input.receivedAt,
        metadata: {
          source: input.source,
          ...input.sourceMeta,
        },
      },
    })
  } else {
    // Чат уже существовал — обновим last-inbound маркеры. Без этого
    // повторный отклик не «всплывёт» наверх в /messages.
    await prisma.chat.update({
      where: { id: chat.id },
      data: {
        lastMessageAt: input.receivedAt,
        lastInboundAt: input.receivedAt,
        requiresResponse: true,
        unreadCount: { increment: 1 },
      },
    })
  }

  // ─── Step 3: Append Message (idempotent by externalId) ─────────────
  const messageExternalId = `${input.source}:msg:${input.sourceExternalId}`
  const messageContent =
    input.preview && input.preview.trim().length > 0
      ? input.preview.trim()
      : input.candidateName
        ? `Новый отклик от ${input.candidateName}`
        : 'Новый отклик'

  let message = await prisma.message.findUnique({
    where: { externalId: messageExternalId },
  })

  if (!message) {
    message = await prisma.message.create({
      data: {
        chatId: chat.id,
        direction: 'inbound',
        type: 'text',
        content: messageContent,
        status: 'delivered',
        sentAt: input.receivedAt,
        externalId: messageExternalId,
        channel,
        metadata: {
          source: input.source,
          sourceExternalId: input.sourceExternalId,
          ...input.sourceMeta,
        },
      },
    })
  }

  // ─── Step 4: Task — пропущено в MVP ────────────────────────────────
  // Task требует ручной адаптации UI под driverId=null. Создание задач
  // включим отдельно после патча TaskDetailsPane / InboxClient.
  const taskId: string | null = null

  return {
    contactId: resolved.contact.id,
    chatId: chat.id,
    messageId: message.id,
    taskId,
    contactCreated: resolved.isNew,
  }
}

export interface UpdateLeadPhoneInput {
  source: LeadSource
  sourceExternalId: string
  /** Существующий contactId если уже создан (ускорит lookup; иначе найдём по identity) */
  contactId?: string | null
  phone: string
}

/**
 * Догрузка телефона: вызывается когда Avito-worker раскрыл номер
 * (avito_responses.phone заполнился позже после INSERT).
 *
 * Логика:
 *   1. Нормализуем телефон (E.164)
 *   2. Если Contact уже имеет такой ContactPhone — ничего не делаем
 *   3. Иначе — добавляем ContactPhone (через стандартный механизм,
 *      который запустит ContactMerge если найдёт совпадение)
 *
 * НЕ обрабатывает случай "телефон совпал с другим Contact'ом" — это
 * сделает ContactMergeService автоматически (см. логику merge).
 */
export async function updateLeadPhone(
  input: UpdateLeadPhoneInput,
): Promise<{ phoneId: string; merged: boolean }> {
  const channel = leadSourceToChatChannel(input.source)
  if (!channel) {
    throw new Error(
      `[LeadIntake] updateLeadPhone: source='${input.source}' has no chat channel`,
    )
  }

  const normalized = normalizePhoneE164(input.phone)
  if (!normalized) {
    throw new Error(`[LeadIntake] updateLeadPhone: invalid phone '${input.phone}'`)
  }

  // Найти Contact либо по входному contactId, либо по identity (channel + externalId)
  let contactId = input.contactId ?? null
  if (!contactId) {
    const identity = await prisma.contactIdentity.findUnique({
      where: {
        channel_externalId: { channel, externalId: input.sourceExternalId },
      },
      select: { contactId: true },
    })
    if (!identity) {
      throw new Error(
        `[LeadIntake] updateLeadPhone: no identity for ${input.source}:${input.sourceExternalId}`,
      )
    }
    contactId = identity.contactId
  }

  // Уже есть такой телефон у этого Contact'а?
  const existing = await prisma.contactPhone.findFirst({
    where: { contactId, phone: normalized, isActive: true },
  })
  if (existing) {
    return { phoneId: existing.id, merged: false }
  }

  // Добавляем ContactPhone. Source='avito' (или соответствующий source).
  // Если такой телефон уже есть у ДРУГОГО Contact'а —
  // ContactMergeService должен сработать асинхронно; здесь мы только
  // создаём запись, merge-логика выходит за рамки intake.
  const newPhone = await prisma.contactPhone.create({
    data: {
      contactId,
      phone: normalized,
      // ContactPhoneSource enum теперь содержит 'avito' / 'site' и т.п.
      source: input.source as 'avito' | 'whatsapp' | 'telegram' | 'phone',
      isPrimary: false,
    },
  })

  // Если у контакта ещё нет primaryPhoneId — назначим этот.
  // Только когда primary не задан, чтобы не перетереть осознанный
  // оператором выбор первого телефона.
  const contact = await prisma.contact.findUnique({
    where: { id: contactId },
    select: { primaryPhoneId: true },
  })
  if (contact && !contact.primaryPhoneId) {
    await prisma.contact.update({
      where: { id: contactId },
      data: { primaryPhoneId: newPhone.id },
    })
  }

  return { phoneId: newPhone.id, merged: false }
}
