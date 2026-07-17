import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { refreshContactMainDriver } from '@/lib/driver-profiles/multi-park'
import { refreshContactDriverProfiles } from '@/lib/driver-profiles/contact-profile-refresh'

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

    const body = await _req.json().catch(() => ({})) as { force?: boolean; parkCode?: string }
    const refresh = await refreshContactDriverProfiles({
      contactId: id,
      parkCode: typeof body.parkCode === 'string' ? body.parkCode : undefined,
    })
    const decision = await refreshContactMainDriver(
      id,
      body.force === true ? 'card-open-manual-retry' : 'card-open-refresh',
    )
    const profiles = await prisma.driver.findMany({
      where: { contactId: id },
      select: { id: true, yandexDriverId: true, updatedAt: true, lastExternalPark: true, dismissedAt: true, statusOverride: true },
      orderBy: [{ lastExternalPark: 'asc' }, { updatedAt: 'desc' }],
    })

    return NextResponse.json({
      ok: true,
      refreshedAt: refresh.some(result => result.status === 'refreshed') ? new Date().toISOString() : null,
      profileCount: profiles.length,
      mainDriverId: decision?.main?.id ?? null,
      anomalies: decision?.anomalies ?? [],
      refresh,
      canRetry: refresh.some(result => result.status === 'backoff') === false,
      profiles,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[contacts/:id/driver-profiles/refresh] POST Error:', message)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
