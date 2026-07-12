import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { refreshContactMainDriver } from '@/lib/driver-profiles/multi-park'

export const dynamic = 'force-dynamic'

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const contact = await prisma.contact.findUnique({
      where: { id },
      select: { id: true, isArchived: true },
    })
    if (!contact || contact.isArchived) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
    }

    const decision = await refreshContactMainDriver(id, 'card-open-refresh')
    const profiles = await prisma.driver.findMany({
      where: { contactId: id },
      select: { id: true, yandexDriverId: true, updatedAt: true, lastExternalPark: true, dismissedAt: true, statusOverride: true },
      orderBy: [{ lastExternalPark: 'asc' }, { updatedAt: 'desc' }],
    })

    return NextResponse.json({
      ok: true,
      refreshedAt: new Date().toISOString(),
      profileCount: profiles.length,
      mainDriverId: decision?.main?.id ?? null,
      anomalies: decision?.anomalies ?? [],
      profiles,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[contacts/:id/driver-profiles/refresh] POST Error:', message)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
