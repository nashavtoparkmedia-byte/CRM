import { NextResponse } from 'next/server'
import { TelephonyService } from '@/lib/TelephonyService'

export async function GET() {
  try {
    const devices = await TelephonyService.listDevices()
    return NextResponse.json(devices)
  } catch (err) {
    console.error('[telephony] list devices error:', err)
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }
}
