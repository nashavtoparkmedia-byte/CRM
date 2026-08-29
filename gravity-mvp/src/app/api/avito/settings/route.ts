/**
 * GET /api/avito/settings — все глобальные настройки Avito.
 * PATCH /api/avito/settings — обновляет переданные ключи.
 *
 * Хранятся как key/value в avito_app_settings. Парсинг типов на стороне
 * клиента: bool — '"true"' / '"false"', int — '"600"', и т.п.
 *
 * Контракт повторяет Box 1 GlobalSettings interface.
 */
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

function maskToken(t: string): string {
  if (t.length <= 4) return '****'
  return '****' + t.slice(-4)
}

export async function GET() {
  try {
    const rows = await prisma.avito_app_settings.findMany()
    const map = new Map(rows.map((r) => [r.key, r.value]))
    const parseBool = (k: string, def: boolean): boolean => {
      const v = map.get(k)
      if (v === undefined) return def
      return v === 'true'
    }
    const pollSec = map.get('responses_poll_default_sec')
    const autoReply = map.get('auto_reply_default_text')
    const tgToken = (map.get('telegram_bot_token') ?? '').trim()
    const tgChat = (map.get('telegram_chat_id') ?? '').trim()
    const crmUrl = (map.get('crm_webhook_url') ?? '').trim()
    const crmToken = (map.get('crm_token') ?? '').trim()
    return NextResponse.json({
      responsesPollDefaultSec: pollSec && /^\d+$/.test(pollSec) ? Number(pollSec) : null,
      autoReplyText: autoReply && autoReply.trim().length > 0 ? autoReply : null,
      telegramBotTokenMasked: tgToken ? maskToken(tgToken) : null,
      telegramBotTokenSet: tgToken.length > 0,
      telegramChatId: tgChat || null,
      notifyNewResponse: parseBool('notify_new_response', true),
      notifyAutoPause: parseBool('notify_auto_pause', true),
      notifyAccountDegraded: parseBool('notify_account_degraded', true),
      crmWebhookUrl: crmUrl || null,
      crmTokenMasked: crmToken ? maskToken(crmToken) : null,
      crmTokenSet: crmToken.length > 0,
      crmNotifyLeadCreated: parseBool('crm_notify_lead_created', true),
      crmNotifyLeadPhone: parseBool('crm_notify_lead_phone', true),
      crmNotifyLeadProcessed: parseBool('crm_notify_lead_processed', true),
      crmNotifyAccountPaused: parseBool('crm_notify_account_paused', true),
      crmNotifyAccountDegraded: parseBool('crm_notify_account_degraded', true),
      crmPullEnabled: parseBool('crm_pull_enabled', true),
    })
  } catch (err: any) {
    console.warn('[avito-settings] request failed')
    return NextResponse.json({ error: 'request failed' }, { status: 500 })
  }
}

export async function PATCH(req: Request) {
  const body = (await req.json()) as Record<string, unknown>
  async function upsertString(key: string, value: unknown) {
    if (value === undefined) return
    if (value === null || (typeof value === 'string' && value.trim().length === 0)) {
      await prisma.avito_app_settings.deleteMany({ where: { key } })
      return
    }
    if (typeof value !== 'string') return
    const v = value.trim()
    await prisma.avito_app_settings.upsert({
      where: { key },
      update: { value: v, updated_at: new Date() },
      create: { key, value: v },
    })
  }
  async function upsertBool(key: string, value: unknown) {
    if (value === undefined || typeof value !== 'boolean') return
    const v = value ? 'true' : 'false'
    await prisma.avito_app_settings.upsert({
      where: { key },
      update: { value: v, updated_at: new Date() },
      create: { key, value: v },
    })
  }
  async function upsertInt(key: string, value: unknown) {
    if (value === undefined) return
    if (value === null) {
      await prisma.avito_app_settings.deleteMany({ where: { key } })
      return
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) return
    const v = String(Math.floor(value))
    await prisma.avito_app_settings.upsert({
      where: { key },
      update: { value: v, updated_at: new Date() },
      create: { key, value: v },
    })
  }
  try {
    await upsertInt('responses_poll_default_sec', body.responsesPollDefaultSec)
    await upsertString('auto_reply_default_text', body.autoReplyText)
    await upsertString('telegram_bot_token', body.telegramBotToken)
    await upsertString('telegram_chat_id', body.telegramChatId)
    await upsertBool('notify_new_response', body.notifyNewResponse)
    await upsertBool('notify_auto_pause', body.notifyAutoPause)
    await upsertBool('notify_account_degraded', body.notifyAccountDegraded)
    await upsertString('crm_webhook_url', body.crmWebhookUrl)
    await upsertString('crm_token', body.crmToken)
    await upsertBool('crm_notify_lead_created', body.crmNotifyLeadCreated)
    await upsertBool('crm_notify_lead_phone', body.crmNotifyLeadPhone)
    await upsertBool('crm_notify_lead_processed', body.crmNotifyLeadProcessed)
    await upsertBool('crm_notify_account_paused', body.crmNotifyAccountPaused)
    await upsertBool('crm_notify_account_degraded', body.crmNotifyAccountDegraded)
    await upsertBool('crm_pull_enabled', body.crmPullEnabled)
    return NextResponse.json({ ok: true })
  } catch (err: any) {
    console.warn('[avito-settings] update failed')
    return NextResponse.json({ error: 'request failed' }, { status: 500 })
  }
}
