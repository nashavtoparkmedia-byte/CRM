/**
 * POST /api/avito/accounts/:id/retry
 *
 * STEP 9 manual retry — оператор просит worker'а ещё раз пройти
 * scan_account для этого аккаунта. Особенности:
 *   - НЕ пишем `enqueued_scan_account` activity_log (только
 *     `manual_retry_requested`) — иначе журнал засоряется дублями.
 *   - НЕ трогаем retry_required / status / last_scan_* — это поля
 *     системы, worker сам обновит когда отработает.
 *   - Пишем last_manual_retry_{at,job_id,outcome=pending} на строку
 *     аккаунта — UI читает эти поля чтобы показать «retry в работе»
 *     без обращения к activity_log. Best-effort: если апдейт упал,
 *     job уже стоит в очереди, ответ всё равно успешен.
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
    const job = await enqueueJob('scan_account', { accountId })
    const now = new Date()
    try {
      await prisma.avito_accounts.update({
        where: { id: accountId },
        data: {
          last_manual_retry_at: now,
          last_manual_retry_job_id: job.jobId,
          last_manual_retry_outcome: 'pending',
          updated_at: now,
        },
      })
    } catch (err) {
      // Метаданные ретрая — best-effort. Job уже в очереди, лог пойдёт
      // ниже — это source of truth.
      console.warn(
        `[avito] last_manual_retry update failed account=${accountId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
    await logActivity('account', accountId, 'manual_retry_requested', {
      accountId,
      requestedBy: 'operator',
    })
    return NextResponse.json(
      { jobId: job.jobId, status: job.status },
      { status: 202 },
    )
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message ?? 'unknown' },
      { status: 500 },
    )
  }
}
