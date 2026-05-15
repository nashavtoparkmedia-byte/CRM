/**
 * POST /api/avito/responses/:id/mark-processed
 *
 * Помечает отклик как обработанный оператором: пишет processed_at,
 * processed_by (CRM user id) и переводит status в ready_for_manager.
 * Зеркало логики из Box 1 ResponsesService.markProcessed.
 *
 * Никаких TG-edit (это live-работа Avito-сервиса; в CRM-mode мы пока
 * не настраивали TG — добавится в будущей итерации).
 */
import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { prisma } from '@/lib/prisma'

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const responseId = Number(id)
  if (!Number.isFinite(responseId)) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 })
  }
  const cookieStore = await cookies()
  const userId = cookieStore.get('crm_user_id')?.value ?? 'operator'
  try {
    const updated = await prisma.avito_responses.update({
      where: { id: responseId },
      data: {
        processed_at: new Date(),
        processed_by: userId,
        status: 'ready_for_manager',
        updated_at: new Date(),
      },
    })
    // Audit-log
    await prisma.avito_activity_log.create({
      data: {
        entity_type: 'response',
        entity_id: String(responseId),
        action: 'response_processed',
        details_json: { responseId, accountId: updated.account_id, processedBy: userId },
      },
    })
    return NextResponse.json({ ok: true, processedAt: updated.processed_at })
  } catch (err: any) {
    if (err.code === 'P2025') {
      return NextResponse.json({ error: 'not found' }, { status: 404 })
    }
    return NextResponse.json({ error: err?.message ?? 'unknown' }, { status: 500 })
  }
}
