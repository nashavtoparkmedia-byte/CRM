import { NextRequest, NextResponse } from 'next/server'
import { authenticateDevice } from '@/lib/telephonyAuth'
import { TelephonyService } from '@/lib/TelephonyService'
import { memLog as _flog } from '@/lib/telephonyMemLog'

export async function POST(request: NextRequest) {
  try {
    const auth = await authenticateDevice(request)
    if (!auth) {
      _flog('POST /api/telephony/devices/heartbeat 401')
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }

    const body = await request.json().catch(() => ({}))
    const result = await TelephonyService.heartbeat(auth.deviceId, {
      batteryLevel: body.batteryLevel,
      signalStrength: body.signalStrength,
    })

    _flog('POST /api/telephony/devices/heartbeat 200')
    return NextResponse.json(result)
  } catch (err) {
    console.error('[telephony] heartbeat error:', err)
    _flog('POST /api/telephony/devices/heartbeat 500')
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }
}
