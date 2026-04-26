/**
 * GET /api/leads/new
 *
 * Унифицированный список новых лидов всех источников. Сейчас источник
 * один — Avito (avito_responses). Когда появится сайт/whatsapp/etc.,
 * сюда добавится UNION с другими источниковыми таблицами + соответст-
 * вующий mapper.
 *
 * Витрина /leads/new опрашивает этот endpoint каждые 5 секунд.
 *
 * Query-параметры (все опциональны):
 *   ?source=avito,site   — фильтр по источникам, через запятую
 *   ?status=new,in_progress  — фильтр по общим статусам
 *   ?limit=200           — кол-во строк (max 500)
 */

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { mapAvitoToInbox } from '@/lib/leads/mappers/avito'
import type { InboxLead, LeadSource, LeadInboxStatus } from '@/lib/leads/types'

export async function GET(request: Request) {
  try {
    const url = new URL(request.url)
    const sourceFilter = (url.searchParams.get('source') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean) as LeadSource[]
    const statusFilter = (url.searchParams.get('status') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean) as LeadInboxStatus[]
    const limit = Math.min(
      Math.max(Number(url.searchParams.get('limit') ?? '200'), 1),
      500,
    )

    const useAvito = sourceFilter.length === 0 || sourceFilter.includes('avito')

    const leads: InboxLead[] = []

    if (useAvito) {
      // Грузим аккаунты Avito одним запросом для подстановки имени
      // профиля в sourceMeta. accountId → name.
      const [responses, accounts] = await Promise.all([
        prisma.avito_responses.findMany({
          where: {
            // Скрываем системные «a2u-» (auto-to-user) — это не лиды
            // от кандидатов, а служебные тестовые сообщения.
            NOT: { external_id: { startsWith: 'a2u-' } },
          },
          orderBy: { detected_at: 'desc' },
          take: limit,
        }),
        prisma.avito_accounts.findMany({
          select: { id: true, name: true },
        }),
      ])
      const accountById = new Map(accounts.map((a) => [a.id, a]))

      for (const r of responses) {
        // r — Prisma-строка с snake_case полями. Маппер ждёт тот же
        // формат + crm_*_id (новые после миграции).
        leads.push(
          mapAvitoToInbox(r as any, accountById.get(r.account_id) ?? null),
        )
      }
    }

    // Фильтр по статусу применяем после mapper'а — общая модель уже
    // приведена к LeadInboxStatus.
    const filtered =
      statusFilter.length > 0
        ? leads.filter((l) => statusFilter.includes(l.status))
        : leads

    // Финальная сортировка по receivedAt DESC. Когда источников много
    // — каждый внутри уже отсортирован, общий merge-sort не нужен,
    // .sort() справится за O(n log n) на 200-500 строк.
    filtered.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))

    return NextResponse.json({
      leads: filtered,
      total: filtered.length,
    })
  } catch (err: any) {
    console.error('[GET /api/leads/new]', err)
    return NextResponse.json(
      { error: err?.message ?? 'unknown', leads: [], total: 0 },
      { status: 500 },
    )
  }
}
