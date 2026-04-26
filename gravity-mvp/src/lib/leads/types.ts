/**
 * Унифицированный тип лида для витрины /leads/new.
 *
 * Источниковые таблицы (avito_responses сейчас, site_leads и др. позже)
 * приводятся к InboxLead через маппер. Бэкенд /api/leads/new делает
 * UNION по всем источникам и сортирует по receivedAt DESC. Фронтенд
 * рендерит одну таблицу для всех источников + чипсы-фильтры.
 *
 * Источникоспецифичные поля кладутся в `sourceMeta` (Json), а
 * детальный статус источника — в `sourceStatus`. Общая колонка
 * «Статус» рендерит `status` крупно и `sourceStatus` мелким серым
 * под ним (гибридный режим — см. обсуждение архитектуры).
 */

export type LeadSource = 'avito' | 'site' | 'whatsapp' | 'telegram' | 'phone'

/**
 * Простой общий статус, одинаковый для всех источников.
 * Маппинг от источникового статуса задаётся внутри каждого mapper'а.
 */
export type LeadInboxStatus = 'new' | 'in_progress' | 'processed'

/**
 * Связи с CRM-сущностями. Заполняются LeadIntake-сервисом при
 * автоматической обработке лида. На витрине рендерятся как кликабельные
 * ссылки в /messages и /tasks.
 */
export interface LeadCrmLinks {
  contactId: string | null
  chatId: string | null
  taskId: string | null
}

export interface InboxLead {
  /** Глобально-уникальный id вида `${source}-${sourceId}` */
  id: string
  source: LeadSource
  /** Внутренний id внутри источника (число для avito_responses, string для других) */
  sourceId: string
  /** Когда лид появился (received_at у Avito; created_at у формы сайта) */
  receivedAt: string
  /** Имя кандидата / контакта */
  name: string | null
  /** Телефон в свободной форме (не нормализован) — оригинал из источника */
  phone: string | null
  /** Краткое превью первого сообщения */
  preview: string | null
  /** Общий статус для inbox-вида */
  status: LeadInboxStatus
  /** Источниковый статус — мелким серым под общим */
  sourceStatus: string | null
  /** Когда оператор обработал (если processed) */
  processedAt: string | null
  /** Диплинк в источник (Avito-диалог / форма сайта / …) */
  sourceRefUrl: string | null
  /** Источникоспецифичные поля для tooltip / расширенной информации */
  sourceMeta: Record<string, unknown>
  /** Связи с CRM-сущностями — заполнены если LeadIntake уже отработал */
  crm: LeadCrmLinks
}

/** Метрики для KPI-плашки в шапке витрины. */
export interface LeadInboxMetrics {
  today: { total: number; bySource: Record<LeadSource, number> }
  yesterday: { total: number }
  last7Days: { total: number }
  /** Сколько лидов ещё не обработаны */
  unprocessed: number
  /** Сколько без телефона (не дошли до операторской работы) */
  withoutPhone: number
}

/** Доступные источники + ярлыки/цвета для бейджей и чипсов. */
export const LEAD_SOURCES: ReadonlyArray<{
  key: LeadSource
  label: string
  /** Цвет фона для бейджа источника. Telegram-палитра. */
  badgeColor: string
}> = [
  { key: 'avito', label: 'Avito', badgeColor: '#00a046' },
  { key: 'site', label: 'Сайт', badgeColor: '#2AABEE' },
  { key: 'whatsapp', label: 'WhatsApp', badgeColor: '#25D366' },
  { key: 'telegram', label: 'Telegram', badgeColor: '#229ED9' },
  { key: 'phone', label: 'Телефон', badgeColor: '#64748B' },
]

export const LEAD_STATUS_LABEL_RU: Record<LeadInboxStatus, string> = {
  new: 'Новый',
  in_progress: 'В работе',
  processed: 'Обработан',
}
