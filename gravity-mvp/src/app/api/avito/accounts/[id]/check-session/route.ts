/**
 * POST /api/avito/accounts/:id/check-session
 *
 * Ставит в очередь worker'у job типа `check_session`. Worker открывает
 * Avito профильной сессией и проверяет:
 *   - сессия жива → ничего не меняет
 *   - залогинен → пишет last_auth_at
 *   - login required → ставит status=reauth_required и предлагает
 *     оператору open-login-window
 *
 * Возвращает {jobId, type, status} — UI показывает «job N enqueued»
 * пока worker не отчитается. Прогресс виден в Журнале событий
 * (`enqueued_check_session` → `check_session_result`).
 */
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { enqueueJob, logActivity } from '@/lib/avito/helpers'

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const accountId = Number(id)
  if (!Number.isFinite(accountId) || accountId <= 0) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 })
  }

  // Проверка что аккаунт существует — иначе worker подхватит мёртвый
  // job и упадёт. 404 здесь дешевле чем job, висящий с last_error.
  const exists = await prisma.avito_accounts.findUnique({
    where: { id: accountId },
    select: { id: true },
  })
  if (!exists) {
    return NextResponse.json({ error: 'account not found' }, { status: 404 })
  }

  try {
    const job = await enqueueJob('check_session', { accountId })
    await logActivity('account', accountId, 'enqueued_check_session', {
      jobId: job.jobId,
    })
    return NextResponse.json(job, { status: 202 })
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message ?? 'unknown' },
      { status: 500 },
    )
  }
}
