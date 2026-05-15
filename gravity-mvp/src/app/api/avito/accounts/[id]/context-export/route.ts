/**
 * GET /api/avito/accounts/:id/context-export
 *
 * UX3 — два готовых промта в одном JSON: `claudePrompt` для нового
 * чата с Claude Code, `gptPrompt` для нового чата с ChatGPT.
 * Оба прогоняются через maskPhones() — копипаст в внешний чат не
 * утечёт сырой телефон.
 *
 * Read-only, no side effects. Cache-Control: no-store — payload
 * содержит живой хвост activity_log, кэш недопустим.
 */
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { buildContextExport } from '@/lib/avito/incident-export'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const accountId = Number(id)
  if (!Number.isFinite(accountId) || accountId <= 0) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 })
  }

  try {
    const acc = await prisma.avito_accounts.findUnique({
      where: { id: accountId },
      select: {
        id: true,
        name: true,
        status: true,
        retry_required: true,
        auto_paused_at: true,
        auto_pause_reason: true,
        last_collect_responses_at: true,
        last_collect_page_kind: true,
        last_collect_duration_ms: true,
        last_collect_new_count: true,
        last_collect_refreshed_count: true,
        last_collect_phone_success_count: true,
        last_collect_phone_failed_count: true,
        collect_fail_count_24h: true,
        ip_blocked_count_24h: true,
        login_required_count_24h: true,
        responses_poll_interval_sec: true,
      },
    })
    if (!acc) {
      return NextResponse.json({ error: 'account not found' }, { status: 404 })
    }

    // Последние 30 событий по этому аккаунту. Покрыты индексом
    // idx_avito_activity_entity (entity_type, entity_id).
    const events = await prisma.avito_activity_log.findMany({
      where: { entity_type: 'account', entity_id: String(accountId) },
      orderBy: { created_at: 'desc' },
      take: 30,
      select: { created_at: true, action: true, details_json: true },
    })

    const result = buildContextExport(acc, events)
    return new NextResponse(JSON.stringify(result), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    })
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message ?? 'unknown' },
      { status: 500 },
    )
  }
}
