/**
 * POST /api/webhooks/avito
 *
 * Receiver для webhook'ов от avito-worker'а. Worker уже формирует
 * outbox-события в `avito_crm_outbox_events` и шлёт их POST'ом на
 * настроенный crmWebhookUrl. Этот endpoint принимает их и вызывает
 * ingestLead / updateLeadPhone.
 *
 * Формат тела (см. avito-worker tab «🔗 Интеграция с CRM»):
 *   {
 *     source: "avito",
 *     schema_version: 1,
 *     event_id: string,         // дедуп-ключ для idempotency
 *     event: "lead.created" | "lead.phone_revealed" | "lead.processed" | …,
 *     ts: ISO,
 *     data: { responseId, accountId, externalId, … }
 *   }
 *
 * Авторизация: Bearer-токен в заголовке. Соответствие проверяется
 * через AVITO_WEBHOOK_TOKEN из .env (сгенерированный токен из UI
 * настроек Avito).
 *
 * NOTE: catchup-sync (POST /api/leads/sync) — fallback-механизм для
 * случаев когда webhook не настроен или временно недоступен.
 */

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { ingestLead, updateLeadPhone } from '@/lib/leads/intake'

interface AvitoWebhookEvent {
  source: 'avito'
  schema_version: number
  event_id: string
  event: string
  ts: string
  data: Record<string, unknown>
}

function verifyAuth(request: Request): boolean {
  const expected = process.env.AVITO_WEBHOOK_TOKEN
  if (!expected) return true // dev-mode: без токена принимаем всё
  const header = request.headers.get('authorization') ?? ''
  if (!header.startsWith('Bearer ')) return false
  return header.slice('Bearer '.length).trim() === expected
}

export async function POST(request: Request) {
  if (!verifyAuth(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  let body: AvitoWebhookEvent
  try {
    body = (await request.json()) as AvitoWebhookEvent
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 })
  }

  if (body.source !== 'avito') {
    return NextResponse.json(
      { error: `expected source=avito, got '${body.source}'` },
      { status: 400 },
    )
  }

  try {
    switch (body.event) {
      case 'lead.created': {
        // avito-worker шлёт data.id (см. crm-dto.ts toCrmLeadDto:165).
        // Принимаем оба варианта на случай ребренда контракта в будущем.
        const responseId = Number(body.data.id ?? body.data.responseId)
        if (!Number.isFinite(responseId)) {
          return NextResponse.json(
            { error: 'lead.created: missing data.id' },
            { status: 400 },
          )
        }
        const row = await prisma.avito_responses.findUnique({
          where: { id: responseId },
        })
        if (!row) {
          return NextResponse.json(
            { error: `avito_responses #${responseId} not found` },
            { status: 404 },
          )
        }
        const result = await ingestLead({
          source: 'avito',
          sourceExternalId: row.external_id,
          candidateName: row.candidate_name,
          phone: row.phone,
          preview: row.preview,
          receivedAt: row.received_at ?? row.detected_at,
          chatTitle: row.candidate_name,
          sourceMeta: {
            accountId: row.account_id,
            vacancyTitle: row.vacancy_title,
            chatUrl: row.chat_url,
          },
        })
        // Запись CRM-ссылок в источниковую строку.
        await prisma.avito_responses.update({
          where: { id: responseId },
          data: {
            crm_contact_id: result.contactId,
            crm_chat_id: result.chatId,
            crm_task_id: result.taskId,
          } as any,
        })
        return NextResponse.json({ ok: true, ...result })
      }

      case 'lead.phone_revealed': {
        const responseId = Number(body.data.id ?? body.data.responseId)
        const phone = String(body.data.phone ?? '')
        if (!Number.isFinite(responseId) || !phone) {
          return NextResponse.json(
            { error: 'lead.phone_revealed: missing data.id or data.phone' },
            { status: 400 },
          )
        }
        const row = await prisma.avito_responses.findUnique({
          where: { id: responseId },
        })
        if (!row) {
          return NextResponse.json(
            { error: `avito_responses #${responseId} not found` },
            { status: 404 },
          )
        }
        // Если LeadIntake ещё не пробежал по этому отклику — догоним
        // сейчас (lead.phone_revealed может прилететь раньше, чем
        // lead.created успел обработаться). Иначе просто обновляем
        // телефон.
        let contactId = (row as any).crm_contact_id ?? null
        if (!contactId) {
          const ingested = await ingestLead({
            source: 'avito',
            sourceExternalId: row.external_id,
            candidateName: row.candidate_name,
            phone: row.phone ?? phone,
            preview: row.preview,
            receivedAt: row.received_at ?? row.detected_at,
            chatTitle: row.candidate_name,
            sourceMeta: {
              accountId: row.account_id,
              vacancyTitle: row.vacancy_title,
              chatUrl: row.chat_url,
            },
          })
          await prisma.avito_responses.update({
            where: { id: responseId },
            data: {
              crm_contact_id: ingested.contactId,
              crm_chat_id: ingested.chatId,
              crm_task_id: ingested.taskId,
            } as any,
          })
          contactId = ingested.contactId
        }
        const result = await updateLeadPhone({
          source: 'avito',
          sourceExternalId: row.external_id,
          contactId,
          phone,
        })
        return NextResponse.json({ ok: true, ...result })
      }

      case 'lead.processed': {
        // Worker уже сам обновил avito_responses.processed_at в БД;
        // Chat-маркер actually-processed обновим тоже — чтобы /messages
        // отрефлектил и снял requiresResponse.
        const responseId = Number(body.data.id ?? body.data.responseId)
        if (!Number.isFinite(responseId)) {
          return NextResponse.json({ ok: true, ignored: 'no id' })
        }
        const row = await prisma.avito_responses.findUnique({
          where: { id: responseId },
          select: { crm_chat_id: true } as any,
        }) as any
        if (row?.crm_chat_id) {
          await prisma.chat.update({
            where: { id: row.crm_chat_id },
            data: { requiresResponse: false, status: 'resolved' },
          })
        }
        return NextResponse.json({ ok: true })
      }

      default:
        // Неизвестное событие — не ошибка, просто игнорируем (worker
        // может слать новые типы; ack'аем чтобы он не ретраил).
        return NextResponse.json({
          ok: true,
          ignored: true,
          event: body.event,
        })
    }
  } catch (err: any) {
    console.error('[POST /api/webhooks/avito]', body.event, err)
    return NextResponse.json(
      { error: err?.message ?? 'unknown', ok: false },
      { status: 500 },
    )
  }
}
