import { NextRequest, NextResponse } from 'next/server'
import { attachDriverProfilesToContactManually } from '@/lib/driver-profiles/multi-park'

export const dynamic = 'force-dynamic'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const body = await req.json()
    const driverIds = Array.isArray(body.driverIds) ? body.driverIds.filter((value: unknown): value is string => typeof value === 'string') : []
    const selectedBy = typeof body.selectedBy === 'string' && body.selectedBy.trim() ? body.selectedBy.trim() : 'operator'
    const result = await attachDriverProfilesToContactManually(id, driverIds, selectedBy)
    if (!result.ok) {
      const status = result.error === 'profile_belongs_to_other_contact' ? 409 : 400
      return NextResponse.json(result, { status })
    }
    return NextResponse.json(result)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[contacts/:id/driver-profiles/attach] POST Error:', message)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
