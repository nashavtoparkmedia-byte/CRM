/**
 * POST /api/avito/accounts/:id/acknowledge
 *
 * STEP 12 — оператор явно подтверждает что увидел текущее состояние
 * аккаунта (degraded / requires-attention). Очищает аккаунт из
 * "attention queue" в UI, НЕ трогая retry_required / status /
 * last_scan_* / любые системные поля.
 *
 * Минимально: один UPDATE + одна запись в журнал.
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
      data: { acknowledged_at: now, updated_at: now },
    })
    await logActivity('account', accountId, 'account_acknowledged', {
      accountId,
      acknowledgedBy: 'operator',
    })
    return NextResponse.json({
      id: updated.id,
      acknowledgedAt: updated.acknowledged_at,
    })
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message ?? 'unknown' },
      { status: 500 },
    )
  }
}
