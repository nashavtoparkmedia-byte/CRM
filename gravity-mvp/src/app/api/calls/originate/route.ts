import { NextRequest, NextResponse } from 'next/server'
import { isExactSameOriginMutationRequest, isJsonMutationRequest } from '@/modules/identity-access/public/v1'
import { startManualCallV1 } from '@/modules/calling/public/v1/manual-call-handler'
import { START_MANUAL_CALL_COMMAND_V1, ManualCallContractError } from '@/contracts/calling/v1/manual-call'
import { operationalLogV1 as opsLog } from '@/infrastructure/operations/operational-log'

/**
 * POST /api/calls/originate
 * Body: { requestId: string, contactId: string, phoneId: string }
 *
 * Places a manual click-to-call to one Contact through Calling's verified-destination policy:
 * a signed Staff Session with a calling role, the canonical Contact, its own unique phone, and
 * Contacts' voice permission, all checked on the server before anything is dialled. A phone
 * number is never accepted from the client; the number comes from Contacts only.
 */
export async function POST(req: NextRequest) {
    if (!isJsonMutationRequest(req)) return NextResponse.json({ error: 'json_required' }, { status: 415 })
    if (!isExactSameOriginMutationRequest(req)) return NextResponse.json({ error: 'same_origin_required' }, { status: 403 })

    let body: unknown
    try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }) }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return NextResponse.json({ error: 'invalid_request' }, { status: 400 })
    }
    const fields = body as Record<string, unknown>
    if ('phoneNumber' in fields || 'phone' in fields) {
        return NextResponse.json({ error: 'phone_number_not_accepted' }, { status: 400 })
    }

    let result
    try {
        result = await startManualCallV1({
            contract: START_MANUAL_CALL_COMMAND_V1,
            requestId: fields.requestId,
            contactId: fields.contactId,
            phoneId: fields.phoneId,
        })
    } catch (error) {
        if (error instanceof ManualCallContractError) return NextResponse.json({ error: 'invalid_request' }, { status: 400 })
        opsLog('error', 'manual_call_failed', { operation: 'call', error: error instanceof Error ? error.name : 'unknown' })
        return NextResponse.json({ error: 'call_unavailable' }, { status: 503 })
    }

    if (result.status === 'admitted') {
        opsLog('info', 'manual_call_admitted', { operation: 'call', callId: result.callId, replay: result.replay })
        return NextResponse.json({ ok: true, callId: result.callId, fsUuid: result.fsUuid, replay: result.replay })
    }
    if (result.status === 'indeterminate') {
        opsLog('warn', 'manual_call_indeterminate', { operation: 'call', callId: result.callId })
        return NextResponse.json({ ok: false, status: 'indeterminate', callId: result.callId }, { status: 202 })
    }
    opsLog('info', 'manual_call_refused', { operation: 'call', reason: result.reason })
    const status = result.reason === 'staff_not_authenticated' ? 401
        : result.reason === 'busy' || result.reason === 'request_conflict' ? 409
        : result.reason === 'provider_unavailable' || result.reason === 'permission_unavailable' || result.reason === 'contact_unavailable' ? 503
        : 403
    return NextResponse.json({ error: result.reason, retryable: result.retryable }, { status })
}
