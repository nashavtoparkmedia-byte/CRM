import { NextRequest, NextResponse } from 'next/server'
import { setManualMainDriverProfile } from '@/lib/driver-profiles/multi-park'

export const dynamic = 'force-dynamic'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const body = await req.json()
    const driverId = typeof body.driverId === 'string' ? body.driverId : null
    const selectedBy = typeof body.selectedBy === 'string' && body.selectedBy.trim() ? body.selectedBy.trim() : 'operator'
    if (!driverId) {
      return NextResponse.json({ error: 'driverId_required' }, { status: 400 })
    }

    const result = await setManualMainDriverProfile(id, driverId, selectedBy)
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 })
    }
    return NextResponse.json({ ok: true })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[contacts/:id/main-driver] POST Error:', message)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
