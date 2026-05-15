/**
 * POST /api/avito/accounts/:id/pause
 * Operator-driven pause: меняет accounts.status = 'paused'.
 * Worker scheduler пропускает paused аккаунты.
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
  try {
    await prisma.avito_accounts.update({
      where: { id: accountId },
      data: { status: 'paused', updated_at: new Date() },
    })
    await logActivity('account', accountId, 'paused', { requestedBy: 'operator' })
    return NextResponse.json({ ok: true })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? 'unknown' }, { status: 500 })
  }
}
