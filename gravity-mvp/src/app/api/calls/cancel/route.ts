import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/users/user-service'
import { cancelOriginate } from '@/lib/freeswitch/EslClient'
import { operationalLogV1 as opsLog } from '@/infrastructure/operations/operational-log'

/**
 * POST /api/calls/cancel
 * Body: { fsUuid: string }
 *
 * Aborts an outbound originate that's still ringing the callee. The manager
 * hit "Отбой" on the placeholder ActiveCallPopup before the b-leg INVITE
 * arrived at the browser — without this endpoint FS would keep the a-leg
 * (Megafon → callee) alive until Megafon times it out (~30 s), and the
 * callee's phone would keep ringing even though the manager hung up.
 *
 * Effect: FS sends CANCEL to Megafon → callee's phone stops ringing →
 * CHANNEL_HANGUP_COMPLETE fires with cause ORIGINATOR_CANCEL → ESL handler
 * broadcasts 'ended' → SSE clears any frontend state still showing the call.
 */
export async function POST(req: NextRequest) {
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

    let body: any
    try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }) }
    const fsUuid = String(body?.fsUuid ?? '').trim()
    if (!fsUuid) return NextResponse.json({ error: 'fsuuid_required' }, { status: 400 })

    try {
        await cancelOriginate(fsUuid)
        return NextResponse.json({ ok: true })
    } catch (err: any) {
        opsLog('error', 'cancel_failed', { operation: 'call', error: err.message, fsUuid })
        return NextResponse.json({ error: err.message }, { status: 500 })
    }
}
