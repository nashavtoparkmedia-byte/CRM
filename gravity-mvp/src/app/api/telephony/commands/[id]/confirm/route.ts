import { NextRequest, NextResponse } from 'next/server'
import { authenticateDevice } from '@/lib/telephonyAuth'
import { TelephonyService } from '@/lib/TelephonyService'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await authenticateDevice(request)
    if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

    const { id: commandId } = await params
    const body = await request.json()

    if (typeof body.success !== 'boolean') {
      return NextResponse.json({ error: 'success_field_required' }, { status: 400 })
    }

    const result = await TelephonyService.confirmCommandExecution(
      commandId,
      auth.deviceId,
      body.success,
      body.failReason,
    )

    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: result.status ?? 400 })
    }

    return NextResponse.json(result)
  } catch (err) {
    console.error('[telephony] confirm command error:', err)
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }
}
