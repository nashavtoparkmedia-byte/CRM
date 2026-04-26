/**
 * Avito mapper — приводит avito_responses-строку к InboxLead.
 *
 * Маппинг статусов avito → общий статус витрины:
 *   - new / phone_pending           → 'new'
 *   - phone_received / phone_failed → 'in_progress'  (лид у системы, ждём оператора)
 *   - ready_for_manager             → 'processed'
 *   - duplicate                     → 'processed'    (дубликат — не считаем активным)
 */

import type {
  InboxLead,
  LeadInboxStatus,
} from '../types'

// camelCase-форма avito_responses (не сама Prisma-строка — мы получаем её
// из API /api/avito/responses или из mapped query). Чтобы не зависеть от
// Prisma-типов, описываем вручную минимальный shape.
export interface AvitoResponseRow {
  id: number
  account_id: number
  external_id: string
  chat_url: string | null
  candidate_name: string | null
  vacancy_title: string | null
  preview: string | null
  phone: string | null
  received_at: Date | string | null
  detected_at: Date | string
  status: string
  processed_at: Date | string | null
  phone_revealed_at: Date | string | null
  auto_reply_sent_at: Date | string | null
  auto_reply_status: string | null
  // Связи с CRM (заполнены LeadIntake)
  crm_contact_id: string | null
  crm_chat_id: string | null
  crm_task_id: string | null
}

/** Информация про аккаунт для sourceMeta (имя профиля Avito). */
export interface AvitoAccountSummary {
  id: number
  name: string
}

const AVITO_STATUS_LABEL_RU: Record<string, string> = {
  new: 'новый',
  phone_pending: 'получаем номер',
  phone_received: 'номер получен',
  phone_failed: 'номер не получен',
  ready_for_manager: 'обработан',
  duplicate: 'дубликат',
}

function avitoStatusToInbox(status: string): LeadInboxStatus {
  switch (status) {
    case 'new':
    case 'phone_pending':
      return 'new'
    case 'phone_received':
    case 'phone_failed':
      return 'in_progress'
    case 'ready_for_manager':
    case 'duplicate':
      return 'processed'
    default:
      return 'new'
  }
}

function toIso(d: Date | string | null | undefined): string {
  if (!d) return new Date(0).toISOString()
  return typeof d === 'string' ? d : d.toISOString()
}

function toIsoNullable(d: Date | string | null | undefined): string | null {
  if (!d) return null
  return typeof d === 'string' ? d : d.toISOString()
}

// Avito-парсер диалога склеивает телефон и время (`+7 (908) 404-85-8821:42`)
// — это `textContent.trim()` в исходнике, между span с номером и span со
// временем нет пробела. Если превью начинается с RU-номера (+7/8 + 10
// цифр) и опционально времени HH:MM — переписываем в чистый E.164,
// сохраняя любой текст после времени. Превью без ведущего номера —
// возвращаем как есть.
function normalizePreview(s: string | null): string | null {
  if (!s) return s
  const m = s.match(
    /^\s*(?:\+7|8)[\s\-()]*(\d)[\s\-()]*(\d)[\s\-()]*(\d)[\s\-()]*(\d)[\s\-()]*(\d)[\s\-()]*(\d)[\s\-()]*(\d)[\s\-()]*(\d)[\s\-()]*(\d)[\s\-()]*(\d)(?:\s*(\d{1,2}:\d{2}))?\s*(.*)$/,
  )
  if (!m) return s
  const digits = m.slice(1, 11).join('')
  const rest = (m[12] ?? '').trim()
  const e164 = `+7${digits}`
  return rest.length > 0 ? `${e164} ${rest}` : e164
}

export function mapAvitoToInbox(
  row: AvitoResponseRow,
  account: AvitoAccountSummary | null,
): InboxLead {
  const sourceStatusRu = AVITO_STATUS_LABEL_RU[row.status] ?? row.status
  return {
    id: `avito-${row.id}`,
    source: 'avito',
    sourceId: String(row.id),
    receivedAt: toIso(row.received_at ?? row.detected_at),
    name: row.candidate_name,
    phone: row.phone,
    preview: normalizePreview(row.preview),
    status: avitoStatusToInbox(row.status),
    sourceStatus: sourceStatusRu,
    processedAt: toIsoNullable(row.processed_at),
    sourceRefUrl: row.chat_url,
    sourceMeta: {
      accountId: row.account_id,
      accountName: account?.name ?? null,
      vacancyTitle: row.vacancy_title,
      externalId: row.external_id,
      phoneRevealedAt: toIsoNullable(row.phone_revealed_at),
      autoReplySentAt: toIsoNullable(row.auto_reply_sent_at),
      autoReplyStatus: row.auto_reply_status,
    },
    crm: {
      contactId: row.crm_contact_id,
      chatId: row.crm_chat_id,
      taskId: row.crm_task_id,
    },
  }
}
