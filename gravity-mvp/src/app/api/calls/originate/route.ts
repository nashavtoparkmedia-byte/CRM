import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUserIdentityV1 as getCurrentUser } from '@/modules/identity-access/public/v1/user-directory'
import { originateCall } from '@/lib/freeswitch/EslClient'
import { operationalLogV1 as opsLog } from '@/infrastructure/operations/operational-log'

/**
 * POST /api/calls/originate
 * Body: { phoneNumber: string }
 *
 * Initiates an outbound call from the current manager's SIP extension to
 * the given number. FreeSWITCH bridges and emits CHANNEL_CREATE — the ESL
 * listener creates the Call row, which then surfaces in the UI via SSE.
 */
export async function POST(req: NextRequest) {
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

    let body: any
    try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }) }
    const phoneNumber = String(body?.phoneNumber ?? '').trim()
    if (!phoneNumber) return NextResponse.json({ error: 'phone_required' }, { status: 400 })

    try {
        const result = await originateCall({ userId: user.id, toNumber: phoneNumber })
        opsLog('info', 'click_to_call', { operation: 'call', contactId: body?.contactId, durationMs: 0 })
        return NextResponse.json({ ok: true, fsUuid: result.fsUuid })
    } catch (err: any) {
        opsLog('error', 'click_to_call_failed', { operation: 'call', error: err.message })
        return NextResponse.json({ error: err.message }, { status: 500 })
    }
}
