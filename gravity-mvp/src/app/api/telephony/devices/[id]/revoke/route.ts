import { NextRequest, NextResponse } from 'next/server'
import { TelephonyService } from '@/lib/TelephonyService'

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const result = await TelephonyService.revokeDevice(id)
    return NextResponse.json(result)
  } catch (err) {
    console.error('[telephony] revoke error:', err)
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }
}
