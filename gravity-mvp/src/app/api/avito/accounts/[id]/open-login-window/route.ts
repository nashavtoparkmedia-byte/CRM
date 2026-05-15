/**
 * POST /api/avito/accounts/:id/open-login-window
 *
 * Ставит в очередь worker'у job типа `open_login_window`. Worker
 * открывает Chromium-окно с Avito-логином в профильной директории
 * этого аккаунта (видимое окно — оператор сам вводит SMS-код /
 * пароль). После успешного входа worker сохраняет cookies в
 * profile_path; следующий scan_account/check_session сессию
 * подхватит автоматически.
 *
 * Прогресс в Журнале: `enqueued_open_login_window` →
 * `open_login_window_ready` → (когда оператор закроет окно) →
 * `reauth_completed`.
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

  const exists = await prisma.avito_accounts.findUnique({
    where: { id: accountId },
    select: { id: true },
  })
  if (!exists) {
    return NextResponse.json({ error: 'account not found' }, { status: 404 })
  }

  try {
    const job = await enqueueJob('open_login_window', { accountId })
    await logActivity('account', accountId, 'enqueued_open_login_window', {
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
