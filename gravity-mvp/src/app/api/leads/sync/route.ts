/**
 * POST /api/leads/sync
 *
 * Catchup-синхронизация: пробегаем все avito_responses без crm_chat_id
 * и для каждого вызываем ingestLead(). Идемпотентно — повторный вызов
 * для одних и тех же строк не создаст дублей.
 *
 * Использование:
 *   - Один раз при первом включении витрины — догнать существующие лиды
 *   - Регулярно (cron / вручную) если webhook от Avito-worker не настроен
 *   - Перед демо чтобы все исторические лиды появились в /messages
 *
 * Параметры (опционально через query или body JSON):
 *   ?dryRun=1   — только посчитать сколько обработали бы, не создавать
 *   ?limit=N    — обработать максимум N (default 100)
 *   ?source=avito  — пока только avito (default)
 */

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { ingestLead, updateLeadPhone } from '@/lib/leads/intake'

export async function POST(request: Request) {
  try {
    const url = new URL(request.url)
    const dryRun = url.searchParams.get('dryRun') === '1'
    const limit = Math.min(
      Math.max(Number(url.searchParams.get('limit') ?? '100'), 1),
      1000,
    )

    // Берём avito-отклики без привязки к Chat. Это могут быть как
    // совсем новые (никогда не обрабатывались), так и старые исто-
    // рические — все они сейчас не видны оператору в /messages.
    const candidates = await prisma.avito_responses.findMany({
      where: {
        NOT: { external_id: { startsWith: 'a2u-' } },
        crm_chat_id: null,
      } as any,
      orderBy: { detected_at: 'asc' }, // от старых к новым
      take: limit,
    })

    if (dryRun) {
      return NextResponse.json({
        ok: true,
        dryRun: true,
        wouldProcess: candidates.length,
      })
    }

    let processed = 0
    let phoneUpdated = 0
    const errors: Array<{ id: number; error: string }> = []

    for (const row of candidates) {
      try {
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

        // Записываем CRM-связи обратно в avito_responses.
        await prisma.avito_responses.update({
          where: { id: row.id },
          data: {
            crm_contact_id: result.contactId,
            crm_chat_id: result.chatId,
            crm_task_id: result.taskId,
          } as any,
        })

        // Если телефон уже есть — догрузим его в Contact (на случай
        // если ingestLead создал контакт без телефона из-за того,
        // что resolveContact работает иначе, или contact уже был).
        if (row.phone && result.contactId) {
          try {
            await updateLeadPhone({
              source: 'avito',
              sourceExternalId: row.external_id,
              contactId: result.contactId,
              phone: row.phone,
            })
            phoneUpdated++
          } catch {
            // Не ошибка интеграции — телефон уже есть у контакта
            // (типичный случай). Молча пропускаем.
          }
        }

        processed++
      } catch (e: any) {
        errors.push({ id: row.id, error: e?.message ?? 'unknown' })
      }
    }

    return NextResponse.json({
      ok: true,
      processed,
      phoneUpdated,
      errors,
      remaining: Math.max(0, candidates.length - processed - errors.length),
    })
  } catch (err: any) {
    console.error('[POST /api/leads/sync]', err)
    return NextResponse.json(
      { error: err?.message ?? 'unknown', ok: false },
      { status: 500 },
    )
  }
}
