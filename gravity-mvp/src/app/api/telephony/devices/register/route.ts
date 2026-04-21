import { NextRequest, NextResponse } from 'next/server'
import { TelephonyService } from '@/lib/TelephonyService'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { androidId, name, phoneNumber, simOperator, appVersion } = body

    if (!androidId || !name) {
      return NextResponse.json({ error: 'androidId and name are required' }, { status: 400 })
    }

    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
      ?? request.headers.get('x-real-ip')
      ?? 'unknown'

    const result = await TelephonyService.registerDevice(
      androidId, name, phoneNumber, simOperator, appVersion, ip,
    )

    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: result.status ?? 400 })
    }

    return NextResponse.json(result)
  } catch (err) {
    console.error('[telephony] register error:', err)
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }
}
