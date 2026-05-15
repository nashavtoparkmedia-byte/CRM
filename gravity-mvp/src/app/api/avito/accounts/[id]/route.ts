/**
 * PATCH /api/avito/accounts/:id
 * Обновляет поля аккаунта (name, autoReplyText, responsesPollIntervalSec,
 * autoPausedAt=null чтобы снять авто-паузу, и т.п.).
 *
 * DELETE /api/avito/accounts/:id
 * Удаляет аккаунт. Cascade на responses + phone_reveal_attempts.
 * (Удаление storage/profiles/N/ — задача worker'а, тут только БД.)
 */
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const accountId = Number(id)
  if (!Number.isFinite(accountId)) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 })
  }
  const body = (await req.json()) as Record<string, unknown>
  const data: Record<string, unknown> = { updated_at: new Date() }
  // Whitelist fields, snake_case mapping
  if ('name' in body) data.name = body.name
  if ('loginPhone' in body) data.login_phone = body.loginPhone
  if ('notes' in body) data.notes = body.notes
  if ('autoReplyText' in body) data.auto_reply_text = body.autoReplyText
  if ('responsesPollIntervalSec' in body)
    data.responses_poll_interval_sec = body.responsesPollIntervalSec
  if ('operatorNote' in body) data.operator_note = body.operatorNote
  if ('autoPausedAt' in body) data.auto_paused_at = body.autoPausedAt
  if ('autoPauseReason' in body) data.auto_pause_reason = body.autoPauseReason
  if ('status' in body) data.status = body.status
  try {
    const updated = await prisma.avito_accounts.update({
      where: { id: accountId },
      data,
    })
    return NextResponse.json({ ok: true, id: updated.id })
  } catch (err: any) {
    if (err.code === 'P2025') {
      return NextResponse.json({ error: 'not found' }, { status: 404 })
    }
    return NextResponse.json({ error: err?.message ?? 'unknown' }, { status: 500 })
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const accountId = Number(id)
  if (!Number.isFinite(accountId)) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 })
  }
  try {
    await prisma.avito_accounts.delete({ where: { id: accountId } })
    return NextResponse.json({ ok: true })
  } catch (err: any) {
    if (err.code === 'P2025') {
      return NextResponse.json({ error: 'not found' }, { status: 404 })
    }
    return NextResponse.json({ error: err?.message ?? 'unknown' }, { status: 500 })
  }
}
