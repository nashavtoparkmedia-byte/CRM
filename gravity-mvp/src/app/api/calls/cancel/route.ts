import { NextRequest, NextResponse } from 'next/server'
import { isExactSameOriginMutationRequest, isJsonMutationRequest } from '@/modules/identity-access/public/v1'
import { cancelManualCallV1 } from '@/modules/calling/public/v1/manual-call-handler'
import { CANCEL_MANUAL_CALL_COMMAND_V1, ManualCallContractError } from '@/contracts/calling/v1/manual-call'
import { operationalLogV1 as opsLog } from '@/infrastructure/operations/operational-log'

/**
 * POST /api/calls/cancel
 * Body: { fsUuid: string }
 *
 * Stops a manual outbound call that is still ringing or active ("Отбой" on the placeholder
 * popup), so the callee's phone stops ringing. Only with a signed Staff Session, only for an
 * active outbound call, and only by the employee who started it or an administrator.
 */
export async function POST(req: NextRequest) {
    if (!isJsonMutationRequest(req)) return NextResponse.json({ error: 'json_required' }, { status: 415 })
    if (!isExactSameOriginMutationRequest(req)) return NextResponse.json({ error: 'same_origin_required' }, { status: 403 })

    let body: unknown
    try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }) }
    const fsUuid = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).fsUuid : undefined

    let result
    try {
        result = await cancelManualCallV1({ contract: CANCEL_MANUAL_CALL_COMMAND_V1, fsUuid })
    } catch (error) {
        if (error instanceof ManualCallContractError) return NextResponse.json({ error: 'invalid_request' }, { status: 400 })
        opsLog('error', 'cancel_failed', { operation: 'call', error: error instanceof Error ? error.name : 'unknown' })
        return NextResponse.json({ error: 'cancel_unavailable' }, { status: 503 })
    }
    if (result.status === 'cancelled') return NextResponse.json({ ok: true })
    const status = result.reason === 'staff_not_authenticated' ? 401
        : result.reason === 'call_not_found' ? 404
        : result.reason === 'call_not_active' ? 409
        : result.reason === 'provider_unavailable' ? 503
        : 403
    return NextResponse.json({ error: result.reason }, { status })
}
