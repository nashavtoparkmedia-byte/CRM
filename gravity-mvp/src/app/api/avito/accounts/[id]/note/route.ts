/**
 * POST /api/avito/accounts/:id/note
 *
 * STEP 19 — заметка оператора, прикреплённая к аккаунту. Текст
 * сохраняется как есть (без интерпретации). Один UPDATE + одна запись
 * в журнал. Не трогает никакие системные поля.
 *
 * Тело: { note: string }. Пустая строка/null — допустимо: очищает
 * заметку (UI трактует "стереть" так же как "оставить пустым").
 */
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { logActivity } from '@/lib/avito/helpers'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const accountId = Number(id)
  if (!Number.isFinite(accountId) || accountId <= 0) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 })
  }

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 })
  }

  // `note` может быть строкой или null. Любой другой тип — отвергаем.
  let note: string | null
  if (body?.note === null || body?.note === undefined) {
    note = null
  } else if (typeof body.note === 'string') {
    note = body.note
  } else {
    return NextResponse.json(
      { error: 'note must be string or null' },
      { status: 400 },
    )
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
      data: { operator_note: note, updated_at: now },
    })
    await logActivity('account', accountId, 'note_added', {
      accountId,
      note,
    })
    return NextResponse.json({
      id: updated.id,
      operatorNote: updated.operator_note,
    })
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message ?? 'unknown' },
      { status: 500 },
    )
  }
}
