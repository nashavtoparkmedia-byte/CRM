/**
 * LeadStatusBadge — небольшой бейдж в строке/шапке чата, показывает
 * этап жизни контакта в системе:
 *
 *   нет driver:                           «{Канал}»               — лид
 *   driver есть, заказы за 45 дней:       «Водитель · {Канал}»    — активный
 *   driver есть, нет активности 45+ дней: «Отток · {Канал}»       — отвалился
 *
 * «Канал» — источник, откуда человек попал в CRM (Avito / Сайт /
 * WhatsApp / …). Помним его навсегда: даже когда лид Avito стал
 * водителем, постфикс «· Avito» остаётся — видно из какого канала
 * пришёл.
 *
 * Используется в:
 *   - ChatList.tsx (строка списка слева)
 *   - ChatHeader.tsx (шапка открытого чата)
 */

const CHANNEL_LABEL: Record<string, string> = {
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  max: 'MAX',
  yandex_pro: 'Yandex',
  phone: 'Телефон',
  avito: 'Avito',
}

const CHANNEL_SHORT: Record<string, string> = {
  whatsapp: 'WA',
  telegram: 'TG',
  max: 'MAX',
  yandex_pro: 'YP',
  phone: 'Тел',
  avito: 'AV',
}

// Цвета для разных каналов (используются когда у строки нет водительского
// статуса — т.е. это «свежий лид» из канала).
const CHANNEL_TINT: Record<string, string> = {
  whatsapp: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  telegram: 'bg-sky-50 text-sky-700 border-sky-200',
  max: 'bg-purple-50 text-purple-700 border-purple-200',
  yandex_pro: 'bg-amber-50 text-amber-800 border-amber-200',
  phone: 'bg-orange-50 text-orange-700 border-orange-200',
  avito: 'bg-green-50 text-green-700 border-green-200',
}

const ACTIVE_CLASS = 'bg-emerald-100 text-emerald-800 border-emerald-200'
const CHURN_CLASS = 'bg-slate-100 text-slate-600 border-slate-300'

const FORTY_FIVE_DAYS_MS = 45 * 24 * 60 * 60 * 1000

export type LeadStatusKind = 'lead' | 'active' | 'churn'

export interface LeadStatusInfo {
  kind: LeadStatusKind
  text: string
  className: string
}

/**
 * Pure-функция: вычисляет статус и подпись по каналу + driver.
 * Без UI, удобно для тестов и для использования вне React (например,
 * в фильтрах, аналитике).
 */
export function computeLeadStatus(
  channel: string,
  driver: {
    lastOrderAt?: string | Date | null
    dismissedAt?: string | Date | null
  } | null | undefined,
): LeadStatusInfo {
  const channelLabel = CHANNEL_LABEL[channel] ?? channel
  const channelTint = CHANNEL_TINT[channel] ?? 'bg-slate-100 text-slate-700 border-slate-200'

  if (!driver) {
    // Контакт не связан с водителем — показываем сам канал-источник.
    // Это лид (или просто человек написал — без CRM-обработки).
    return {
      kind: 'lead',
      text: channelLabel,
      className: channelTint,
    }
  }

  // Driver есть → проверяем активность за последние 45 дней.
  const now = Date.now()
  const lastOrderTs = driver.lastOrderAt
    ? typeof driver.lastOrderAt === 'string'
      ? new Date(driver.lastOrderAt).getTime()
      : driver.lastOrderAt.getTime()
    : 0
  const hasRecentActivity = lastOrderTs > now - FORTY_FIVE_DAYS_MS

  if (hasRecentActivity) {
    return {
      kind: 'active',
      text: `Водитель · ${channelLabel}`,
      className: ACTIVE_CLASS,
    }
  }

  // Нет активности 45+ дней (или вообще не было заказов, или формально
  // уволен) — отток. Показываем то же постфикс «· {канал}» чтобы оператор
  // видел откуда человек пришёл изначально.
  return {
    kind: 'churn',
    text: `Отток · ${channelLabel}`,
    className: CHURN_CLASS,
  }
}

/**
 * UI-компонент. Размер: компактный, для встраивания в строку чата.
 */
export function LeadStatusBadge({
  channel,
  driver,
  size = 'sm',
}: {
  channel: string
  driver?: {
    lastOrderAt?: string | Date | null
    dismissedAt?: string | Date | null
  } | null
  size?: 'xs' | 'sm'
}) {
  const status = computeLeadStatus(channel, driver)
  const sizeClass =
    size === 'xs'
      ? 'text-[10px] px-1.5 py-px'
      : 'text-[11px] px-2 py-0.5'
  return (
    <span
      className={`inline-flex items-center rounded-full border font-medium leading-none whitespace-nowrap ${sizeClass} ${status.className}`}
      title={
        status.kind === 'churn'
          ? 'Нет активности 45+ дней — водитель отпал'
          : status.kind === 'active'
            ? 'Активный водитель — есть заказы за последние 45 дней'
            : 'Лид — пришёл из канала, ещё не подключён водителем'
      }
    >
      {status.text}
    </span>
  )
}

/**
 * Короткий tag-style бейдж канала (для аватара). Старый getChannelBadge
 * из ChatList.tsx не поддерживает avito — выносим сюда + добавляем.
 */
export function ChannelTag({ channel }: { channel: string }) {
  const short = CHANNEL_SHORT[channel]
  if (!short) return null
  const tint = CHANNEL_TINT[channel] ?? ''
  return (
    <span
      className={`text-[8px] font-bold px-1 py-px rounded leading-none border ${tint}`}
    >
      {short}
    </span>
  )
}
