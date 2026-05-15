/**
 * POST /api/avito/settings/telegram/test
 *
 * Кнопка «Тест» в Глобальных настройках → Telegram. Читает СОХРАНЁННЫЕ
 * креды (bot_token + chat_id) из avito_app_settings — НЕ из тела запроса
 * (так оператор тестирует именно то что записано в БД).
 *
 * Возвращает `{ ok: true }` при успехе или `{ ok: false, error }` если
 * Telegram API отклонил сообщение (UI показывает inline). 400 если в
 * настройках чего-то не хватает.
 */
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

const TG_TIMEOUT_MS = 8_000
const TG_TEST_TEXT = '🧪 <b>Тест</b>\nAvito Leads — уведомления работают.'

export async function POST() {
  // Тянем оба ключа за один запрос — обычно их два, но findMany
  // дешевле двух findUnique'ов когда мы уже всё-равно читаем настройки.
  const rows = await prisma.avito_app_settings.findMany({
    where: { key: { in: ['telegram_bot_token', 'telegram_chat_id'] } },
  })
  const map = new Map(rows.map((r) => [r.key, (r.value ?? '').trim()]))
  const botToken = map.get('telegram_bot_token') ?? ''
  const chatId = map.get('telegram_chat_id') ?? ''

  if (!botToken || !chatId) {
    return NextResponse.json(
      { ok: false, error: 'TG не настроен: нет bot_token или chat_id' },
      { status: 400 },
    )
  }

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: TG_TEST_TEXT,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(TG_TIMEOUT_MS),
      },
    )
    if (!res.ok) {
      // 400/401/403 от TG обычно означают: bad token, или chat_id
      // указывает на чат куда боту не дали /start. Возвращаем мягко
      // (HTTP 200 + ok:false) чтобы UI показал inline-сообщение, а
      // не ошибку сети.
      return NextResponse.json({
        ok: false,
        error:
          'Telegram API отклонил сообщение. Проверь bot_token и chat_id, и что ты написал боту хотя бы раз.',
      })
    }
    const json = (await res.json()) as {
      ok?: boolean
      description?: string
      result?: { message_id?: number }
    }
    if (!json.ok || typeof json.result?.message_id !== 'number') {
      return NextResponse.json({
        ok: false,
        error: json.description ?? 'Telegram API вернул not-ok',
      })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    // Сеть упала / таймаут — отдельный текст, чтобы оператор понял
    // что дело не в кредах а в коннективности.
    return NextResponse.json({
      ok: false,
      error: `Не удалось связаться с Telegram API: ${
        err instanceof Error ? err.message : String(err)
      }`,
    })
  }
}
