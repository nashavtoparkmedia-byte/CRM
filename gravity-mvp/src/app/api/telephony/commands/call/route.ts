import { NextRequest, NextResponse } from 'next/server'
import { TelephonyService } from '@/lib/TelephonyService'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { deviceId, phoneNumber, contactId } = body

    if (!deviceId) {
      return NextResponse.json({ error: 'device_id_required' }, { status: 400 })
    }
    if (!phoneNumber) {
      return NextResponse.json({ error: 'phone_number_required' }, { status: 400 })
    }

    const result = await TelephonyService.enqueueCommand(deviceId, 'call', {
      phoneNumber,
      contactId,
    })

    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: result.status ?? 400 })
    }

    return NextResponse.json({ commandId: result.commandId, status: 'pending' })
  } catch (err) {
    console.error('[telephony] command call error:', err)
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }
}
