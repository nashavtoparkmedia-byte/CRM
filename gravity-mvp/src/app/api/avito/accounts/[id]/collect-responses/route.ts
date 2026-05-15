/**
 * POST /api/avito/accounts/:id/collect-responses
 * Принудительный запуск сбора откликов: создаёт avito_jobs row,
 * worker подхватывает его на следующем тике (~1с).
 */
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const accountId = Number(id)
  try {
    const job = await prisma.avito_jobs.create({
      data: {
        type: 'collect_responses',
        payload_json: { accountId } as any,
        status: 'pending',
      },
    })
    return NextResponse.json({ ok: true, jobId: job.id })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? 'unknown' }, { status: 500 })
  }
}
