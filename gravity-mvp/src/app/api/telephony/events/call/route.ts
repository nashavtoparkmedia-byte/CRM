import { NextRequest, NextResponse } from 'next/server'
import { authenticateDevice } from '@/lib/telephonyAuth'
import { TelephonyService } from '@/lib/TelephonyService'

const VALID_EVENT_TYPES = ['ringing', 'answered', 'ended']
const VALID_DIRECTIONS = ['inbound', 'outbound']

export async function POST(request: NextRequest) {
  try {
    const auth = await authenticateDevice(request)
    if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

    const body = await request.json()

    if (!body.eventType || !VALID_EVENT_TYPES.includes(body.eventType)) {
      return NextResponse.json({ error: 'invalid_event_type' }, { status: 400 })
    }
    if (!body.direction || !VALID_DIRECTIONS.includes(body.direction)) {
      return NextResponse.json({ error: 'invalid_direction' }, { status: 400 })
    }
    if (!body.phoneNumber) {
      return NextResponse.json({ error: 'phone_number_required' }, { status: 400 })
    }
    if (!body.timestamp) {
      return NextResponse.json({ error: 'timestamp_required' }, { status: 400 })
    }

    const result = await TelephonyService.handleCallEvent(auth.deviceId, {
      eventType: body.eventType,
      direction: body.direction,
      phoneNumber: body.phoneNumber,
      callSessionId: body.callSessionId,
      androidCallId: body.androidCallId,
      timestamp: body.timestamp,
      duration: body.duration,
      disposition: body.disposition,
    })

    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: result.status ?? 400 })
    }

    return NextResponse.json(result)
  } catch (err) {
    console.error('[telephony] call event error:', err)
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }
}
