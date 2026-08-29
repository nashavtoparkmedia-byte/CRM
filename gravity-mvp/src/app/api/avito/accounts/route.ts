/**
 * GET /api/avito/accounts — список Avito-профилей с camelCase ключами
 * как в Box 1.
 *
 * POST /api/avito/accounts — добавить новый профиль. Тело:
 *   { name, loginPhone?, notes?, autoReplyText? }
 * Создаёт запись в БД (status=new), резервирует профильную директорию
 * на диске (worker будет монтировать в неё Chromium userDataDir),
 * пишет строку в журнал событий. Возвращает созданный аккаунт в
 * том же camelCase shape что GET, чтобы UI просто запушил его в
 * локальный список.
 */
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import {
  accountProfilePath,
  ensureProfileDir,
  logActivity,
} from '@/lib/avito/helpers'

export async function GET() {
  try {
    const rows = await prisma.avito_accounts.findMany({
      orderBy: { id: 'asc' },
      select: {
        id: true, name: true, login_phone: true, notes: true, status: true,
        last_auth_at: true, last_scan_at: true, last_success_at: true,
        reauth_required_at: true, last_error: true, stable_id: true,
        retry_required: true, last_scan_page_kind: true, last_scan_reason: true,
        last_scan_next_action: true, last_manual_retry_at: true,
        last_manual_retry_job_id: true, last_manual_retry_outcome: true,
        acknowledged_at: true, attention_severity: true, operator_note: true,
        responses_poll_interval_sec: true, last_collect_responses_at: true,
        auto_reply_text: true, last_collect_page_kind: true,
        last_collect_duration_ms: true, last_collect_new_count: true,
        last_collect_refreshed_count: true, last_collect_phone_success_count: true,
        last_collect_phone_failed_count: true, collect_fail_count_24h: true,
        ip_blocked_count_24h: true, login_required_count_24h: true,
        collect_fail_count_updated_at: true, ip_blocked_count_updated_at: true,
        login_required_count_updated_at: true, auto_paused_at: true,
        auto_pause_reason: true, created_at: true, updated_at: true,
        profile_path: true,
      },
    })
    return NextResponse.json(rows.map(toCamel))
  } catch (err: any) {
    console.warn('[avito-accounts] list failed')
    return NextResponse.json({ error: 'request failed' }, { status: 500 })
  }
}

/**
 * Маппинг row → camelCase. Вынесли в helper, чтобы POST мог переиспользовать
 * ту же форму ответа что GET.
 */
function toCamel(a: any) {
  return {
    id: a.id,
    name: a.name,
    loginPhone: a.login_phone,
    notes: a.notes,
    profileManaged: Boolean(a.profile_path),
    status: a.status,
    lastAuthAt: a.last_auth_at,
    lastScanAt: a.last_scan_at,
    lastSuccessAt: a.last_success_at,
    reauthRequiredAt: a.reauth_required_at,
    lastError: a.last_error,
    stableId: a.stable_id,
    retryRequired: a.retry_required,
    lastScanPageKind: a.last_scan_page_kind,
    lastScanReason: a.last_scan_reason,
    lastScanNextAction: a.last_scan_next_action,
    lastManualRetryAt: a.last_manual_retry_at,
    lastManualRetryJobId: a.last_manual_retry_job_id,
    lastManualRetryOutcome: a.last_manual_retry_outcome,
    acknowledgedAt: a.acknowledged_at,
    attentionSeverity: a.attention_severity,
    operatorNote: a.operator_note,
    responsesPollIntervalSec: a.responses_poll_interval_sec,
    lastCollectResponsesAt: a.last_collect_responses_at,
    autoReplyText: a.auto_reply_text,
    lastCollectPageKind: a.last_collect_page_kind,
    lastCollectDurationMs: a.last_collect_duration_ms,
    lastCollectNewCount: a.last_collect_new_count,
    lastCollectRefreshedCount: a.last_collect_refreshed_count,
    lastCollectPhoneSuccessCount: a.last_collect_phone_success_count,
    lastCollectPhoneFailedCount: a.last_collect_phone_failed_count,
    collectFailCount24h: a.collect_fail_count_24h,
    ipBlockedCount24h: a.ip_blocked_count_24h,
    loginRequiredCount24h: a.login_required_count_24h,
    collectFailCountUpdatedAt: a.collect_fail_count_updated_at,
    ipBlockedCountUpdatedAt: a.ip_blocked_count_updated_at,
    loginRequiredCountUpdatedAt: a.login_required_count_updated_at,
    autoPausedAt: a.auto_paused_at,
    autoPauseReason: a.auto_pause_reason,
    createdAt: a.created_at,
    updatedAt: a.updated_at,
  }
}

export async function POST(request: Request) {
  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 })
  }

  // Минимальная валидация. name — единственное обязательное поле.
  // Длина 200 — соответствует varchar в Box 1, тут не enforce'им
  // схемой, но обрезаем чтобы не ронять INSERT.
  const name = (body?.name ?? '').toString().trim().slice(0, 200)
  if (name.length === 0) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }

  const loginPhone =
    body?.loginPhone === undefined || body?.loginPhone === null
      ? null
      : String(body.loginPhone).trim() || null
  const notes =
    body?.notes === undefined || body?.notes === null
      ? null
      : String(body.notes)
  const autoReplyRaw =
    body?.autoReplyText === undefined || body?.autoReplyText === null
      ? ''
      : String(body.autoReplyText)
  const autoReplyText = autoReplyRaw.trim().length > 0 ? autoReplyRaw.trim() : null

  try {
    // 2-step как в Box 1: сначала INSERT с пустым profile_path
    // (нужен id чтобы посчитать путь), потом UPDATE с реальным.
    // Можно было бы посчитать путь заранее использовав sequence, но
    // тогда теряется атомарность; этот подход проще и безопаснее.
    const created = await prisma.avito_accounts.create({
      data: {
        name,
        login_phone: loginPhone,
        notes,
        profile_path: '',
        auto_reply_text: autoReplyText,
      },
    })
    const profilePath = accountProfilePath(created.id)
    await ensureProfileDir(profilePath)
    const updated = await prisma.avito_accounts.update({
      where: { id: created.id },
      data: { profile_path: profilePath, updated_at: new Date() },
    })

    await logActivity('account', updated.id, 'created', {
      name: updated.name,
      profileManaged: true,
      autoReplyConfigured: autoReplyText !== null,
    })

    return NextResponse.json(toCamel(updated), { status: 201 })
  } catch (err: any) {
    console.warn('[avito-accounts] create failed')
    return NextResponse.json(
      { error: 'request failed' },
      { status: 500 },
    )
  }
}
