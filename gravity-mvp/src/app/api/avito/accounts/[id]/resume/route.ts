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
    // Снимаем operator-pause. Если был active до этого — вернём active;
    // иначе active по умолчанию (worker сам выставит правильное состояние
    // на следующем сборе).
    await prisma.avito_accounts.update({
      where: { id: accountId },
      data: { status: 'active', updated_at: new Date() },
    })
    await logActivity('account', accountId, 'resumed', { requestedBy: 'operator' })
    return NextResponse.json({ ok: true })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? 'unknown' }, { status: 500 })
  }
}
