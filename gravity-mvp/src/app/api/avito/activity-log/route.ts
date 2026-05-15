import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET(req: Request) {
  const url = new URL(req.url)
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 500), 1000)
  try {
    const rows = await prisma.avito_activity_log.findMany({
      orderBy: { created_at: 'desc' },
      take: limit,
    })
    return NextResponse.json(
      rows.map((e) => ({
        id: e.id,
        entityType: e.entity_type,
        entityId: e.entity_id,
        action: e.action,
        detailsJson: e.details_json,
        createdAt: e.created_at,
      })),
    )
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? 'unknown' }, { status: 500 })
  }
}
