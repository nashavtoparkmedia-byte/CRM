/**
 * POST /api/avito/accounts/:id/reauth-completed
 *
 * STEP 15 — оператор вручную пометил, что повторно вошёл в аккаунт
 * (через open-login-window или другим путём). Очищаем
 * reauth_required_at, чтобы аккаунт перестал светиться сигналом
 * «нужен повторный вход».
 *
 * НЕ трогаем retry_required / status / last_scan_* / acknowledged_at —
 * это независимые сигналы. Один UPDATE + одна запись в журнал.
 */
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { logActivity } from '@/lib/avito/helpers'

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
    const now = new Date()
    const updated = await prisma.avito_accounts.update({
      where: { id: accountId },
      data: { reauth_required_at: null, updated_at: now },
    })
    await logActivity('account', accountId, 'reauth_completed', {
      accountId,
      completedBy: 'operator',
    })
    return NextResponse.json({
      id: updated.id,
      reauthRequiredAt: updated.reauth_required_at,
    })
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message ?? 'unknown' },
      { status: 500 },
    )
  }
}
