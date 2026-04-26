/**
 * GET /api/leads/new/metrics
 *
 * KPI для шапки витрины /leads/new: «сегодня / вчера / 7 дней» по
 * источникам, плюс счётчики «не обработано» и «без телефона».
 *
 * Пока считаем только Avito; когда добавим site/whatsapp — тут будет
 * UNION ALL с группировкой по source.
 */

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import type { LeadInboxMetrics, LeadSource } from '@/lib/leads/types'

function startOfDay(d: Date): Date {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

export async function GET() {
  try {
    const now = new Date()
    const todayStart = startOfDay(now)
    const yesterdayStart = new Date(todayStart)
    yesterdayStart.setDate(yesterdayStart.getDate() - 1)
    const weekStart = new Date(todayStart)
    weekStart.setDate(weekStart.getDate() - 7)

    const [
      todayAvito,
      yesterdayAvito,
      weekAvito,
      unprocessedAvito,
      withoutPhoneAvito,
    ] = await Promise.all([
      prisma.avito_responses.count({
        where: {
          NOT: { external_id: { startsWith: 'a2u-' } },
          detected_at: { gte: todayStart },
        },
      }),
      prisma.avito_responses.count({
        where: {
          NOT: { external_id: { startsWith: 'a2u-' } },
          detected_at: { gte: yesterdayStart, lt: todayStart },
        },
      }),
      prisma.avito_responses.count({
        where: {
          NOT: { external_id: { startsWith: 'a2u-' } },
          detected_at: { gte: weekStart },
        },
      }),
      prisma.avito_responses.count({
        where: {
          NOT: { external_id: { startsWith: 'a2u-' } },
          processed_at: null,
        },
      }),
      prisma.avito_responses.count({
        where: {
          NOT: { external_id: { startsWith: 'a2u-' } },
          phone: null,
          processed_at: null,
        },
      }),
    ])

    const bySource: Record<LeadSource, number> = {
      avito: todayAvito,
      site: 0,
      whatsapp: 0,
      telegram: 0,
      phone: 0,
    }

    const metrics: LeadInboxMetrics = {
      today: { total: todayAvito, bySource },
      yesterday: { total: yesterdayAvito },
      last7Days: { total: weekAvito },
      unprocessed: unprocessedAvito,
      withoutPhone: withoutPhoneAvito,
    }

    return NextResponse.json(metrics)
  } catch (err: any) {
    console.error('[GET /api/leads/new/metrics]', err)
    return NextResponse.json(
      { error: err?.message ?? 'unknown' },
      { status: 500 },
    )
  }
}
