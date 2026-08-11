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
import { normalizePhoneE164 } from '@/modules/contacts/public/v1/phone-identity'
import type { ChatChannel } from '@prisma/client'
import type { LeadSource } from './types'
import { ENSURE_LEAD_CONVERSATION_COMMAND_V1, RECEIVE_MESSAGE_COMMAND_V1 } from '@/contracts/messaging/v1'
import { ensureLeadConversationV1, receiveMessageV1 } from '@/modules/messaging/public/v1'
import { MARK_TEMPORARY_CONTACT_PHONE_COMMAND_V1 } from '@/contracts/contacts/v1'
import { markTemporaryContactPhoneV1 } from '@/modules/contacts/public/v1'

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

  // Mark Avito-phones as temporary. From 28.05.2026 onwards Avito hides
  // the candidate's real number behind a disposable proxy that rotates —
  // we want it visible in the contact card AS temporary so the operator
  // doesn't save it, and we want it auto-cleaned after TTL if the real
  // number never arrives. Other sources (telegram/whatsapp/phone) skip
  // this entirely.
  if (input.source === 'avito' && input.phone) {
    const normalized = normalizePhoneE164(input.phone)
    if (normalized) {
      const ttlDays = Number(process.env.AVITO_TEMP_PHONE_TTL_DAYS ?? '14')
      const expiresAt = new Date(Date.now() + ttlDays * 86400_000)
      await markTemporaryContactPhoneV1({ contract: MARK_TEMPORARY_CONTACT_PHONE_COMMAND_V1, contactId: resolved.contact.id, phone: normalized, expiresAt, label: 'Временный (Авито)' })
    }
  }

  // ─── Step 2: Find or create Chat (один на пару Contact + channel) ──
  // Сначала ищем существующий чат для этого контакта и канала. Если
  // есть — переиспользуем (повторные отклики ложатся в тот же чат).
  // Если нет — создаём.
  const chat = await ensureLeadConversationV1({
    contract: ENSURE_LEAD_CONVERSATION_COMMAND_V1,
    contactId: resolved.contact.id,
    contactIdentityId: resolved.identity.id,
    channel,
    externalChatId: `${input.source}:contact:${resolved.contact.id}`,
    name: input.chatTitle ?? input.candidateName ?? null,
    receivedAt: input.receivedAt,
    metadata: { source: input.source, ...input.sourceMeta },
  })

  // ─── Step 3: Append Message (idempotent by externalId) ─────────────
  const messageExternalId = `${input.source}:msg:${input.sourceExternalId}`
  const messageContent =
    input.preview && input.preview.trim().length > 0
      ? input.preview.trim()
      : input.candidateName
        ? `Новый отклик от ${input.candidateName}`
        : 'Новый отклик'

  const receivedMessage = await receiveMessageV1({
    contract: RECEIVE_MESSAGE_COMMAND_V1,
    chatId: chat.chatId,
    content: messageContent,
    sentAt: input.receivedAt.toISOString(),
    externalId: messageExternalId,
    channel,
    metadata: {
      source: input.source,
      sourceExternalId: input.sourceExternalId,
      ...input.sourceMeta,
    },
  })

  // ─── Step 4: Task — пропущено в MVP ────────────────────────────────
  // Task требует ручной адаптации UI под driverId=null. Создание задач
  // включим отдельно после патча TaskDetailsPane / InboxClient.
  const taskId: string | null = null

  return {
    contactId: resolved.contact.id,
    chatId: chat.chatId,
    messageId: receivedMessage.messageId,
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

  // Avito-worker раскрыл настоящий номер — добавляем его как новый
  // primary phone, и одновременно деактивируем все временные у этого
  // Contact'a. Если в `expiresAt` ещё был live временный — он уйдёт в
  // isActive:false, чтобы Авито при следующей ротации временного не
  // случайно сматчился через resolveByPhone в этот же Contact.
  const result = await ContactService.addPhoneToContact(contactId, normalized, {
    isTemporary: false,
    source: input.source as 'manual' | 'avito' | 'whatsapp' | 'telegram' | 'phone',
    label: 'Личный',
    makePrimary: true,
    deactivateTemporaries: true,
  })

  if (result.kind === 'exists_same_contact') {
    return { phoneId: result.phoneId, merged: false }
  }
  if (result.kind === 'conflict') {
    // Number is already attached to a different Contact — we surface this
    // up the call stack so the webhook / catchup-sync can decide whether
    // to merge or just log. Auto-merge is intentionally avoided here.
    throw new Error(
      `[LeadIntake] updateLeadPhone: phone ${normalized} belongs to contact ${result.otherContactId} (${result.otherContactName}); manual merge required`,
    )
  }
  return { phoneId: result.phoneId, merged: false }
}
