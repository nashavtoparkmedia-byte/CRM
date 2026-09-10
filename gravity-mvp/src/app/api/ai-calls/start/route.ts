import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUserIdentityV1 as getCurrentUser } from '@/modules/identity-access/public/v1/user-directory'
import { operationalLogV1 as opsLog } from '@/infrastructure/operations/operational-log'
import { getActiveScenario } from '@/lib/ai-call/scenarios'
import {
    assertControlledDestination,
    assertControlledRequestId,
    ControlledRealCallInputError,
    parseControlledRealCallRequest,
} from '@/modules/calling/application/controlled-real-ai-call'
import { isControlledRealCallOperatorAuthenticated } from '@/modules/calling/application/controlled-real-ai-call-operator-auth'
import { ControlledRealAiCallDispatchError } from '@/modules/calling/application/controlled-real-ai-call-provider'
import {
    claimControlledRealAiCall,
    dispatchControlledRealAiCall,
    readControlledRealCallReadiness,
    recordControlledRealAiCallDispatchAccepted,
    recordControlledRealAiCallDispatchRejected,
    recordControlledRealAiCallDispatchUnknown,
} from '@/modules/calling/application/controlled-real-ai-call-runtime'
import type { ControlledRealAiCallRecord } from '@/modules/calling/application/controlled-real-ai-call-admission'
import {
    resolveAiCallContactRecipient,
    resolveAiCallDriverRecipient,
} from '@/modules/calling/application/ai-call-recipient'

export const dynamic = 'force-dynamic'

const ALLOWED_OPERATOR_ROLES = new Set(['Администратор', 'Руководитель'])
type CurrentUser = NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>
type OperatorAuthorization =
    | { ok: true; user: CurrentUser }
    | { ok: false; response: NextResponse }

function duplicateResponse(call: ControlledRealAiCallRecord): NextResponse {
    return NextResponse.json({
        ok: true,
        duplicate: true,
        dispatched: false,
        callId: call.id,
        fsUuid: call.fsUuid,
        status: call.status,
        aiSessionStatus: call.aiSessionStatus,
    })
}

async function authorizeOperator(req: NextRequest): Promise<OperatorAuthorization> {
    const user = await getCurrentUser()
    if (!user) return { ok: false, response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) }
    if (user.status !== 'Активен' || !ALLOWED_OPERATOR_ROLES.has(user.role)) {
        return { ok: false, response: NextResponse.json({ error: 'forbidden' }, { status: 403 }) }
    }
    if (!isControlledRealCallOperatorAuthenticated(req.headers)) {
        opsLog('warn', 'controlled_real_ai_call_operator_auth_blocked', { operatorId: user.id })
        return { ok: false, response: NextResponse.json({ error: 'forbidden' }, { status: 403 }) }
    }
    return { ok: true, user }
}

/** Read-only, secret-free preflight. It never creates a Call or contacts PSTN. */
export async function GET(req: NextRequest) {
    const authorization = await authorizeOperator(req)
    if (!authorization.ok) return authorization.response

    const readiness = await readControlledRealCallReadiness()
    return NextResponse.json(readiness.public, {
        status: readiness.ready ? 200 : 503,
        headers: { 'Cache-Control': 'no-store' },
    })
}

/**
 * Initiate the one globally approved live AI call. The configured requestId is
 * the one-shot budget: its deterministic Call identity is atomically claimed
 * by Calling persistence and cannot produce a second provider dispatch.
 */
export async function POST(req: NextRequest) {
    const authorization = await authorizeOperator(req)
    if (!authorization.ok) return authorization.response
    const { user } = authorization

    const readiness = await readControlledRealCallReadiness()
    if (!readiness.ready || !readiness.admission) {
        opsLog('warn', 'controlled_real_ai_call_readiness_blocked', {
            operatorId: user.id,
            blockers: readiness.blockers,
        })
        return NextResponse.json({
            error: 'controlled_real_call_not_ready',
            readiness: readiness.public,
        }, { status: 503 })
    }

    let rawBody: unknown
    try {
        rawBody = await req.json()
    } catch {
        return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
    }

    let body
    try {
        body = parseControlledRealCallRequest(rawBody)
        assertControlledRequestId(body.requestId, readiness.admission.approvedRequestId)
    } catch (error) {
        if (error instanceof ControlledRealCallInputError) {
            return NextResponse.json({ error: error.code }, { status: 400 })
        }
        throw error
    }

    let toNumber: string
    if (body.contactId) {
        const recipient = await resolveAiCallContactRecipient({
            contactId: body.contactId,
            driverId: null,
            phoneNumber: null,
        })
        if (recipient.status === 'invalid_input') {
            return NextResponse.json({ error: recipient.reason }, { status: 400 })
        }
        if (recipient.status === 'unreachable') {
            return NextResponse.json({ error: 'no_phone_number_for_lead' }, { status: 400 })
        }
        toNumber = recipient.phone
    } else if (body.driverId) {
        const recipient = await resolveAiCallDriverRecipient({
            driverId: body.driverId,
            contactId: null,
            phoneNumber: null,
        })
        if (recipient.status === 'invalid_input') {
            return NextResponse.json({ error: recipient.reason }, { status: 400 })
        }
        if (recipient.status === 'unreachable') {
            return NextResponse.json({ error: 'no_phone_number_for_lead' }, { status: 400 })
        }
        toNumber = recipient.phone
    } else {
        toNumber = body.phoneNumber ?? ''
    }

    try {
        assertControlledDestination(toNumber, readiness.admission.allowedDestinationE164)
    } catch (error) {
        if (error instanceof ControlledRealCallInputError) {
            opsLog('warn', 'controlled_real_ai_call_destination_blocked', {
                operatorId: user.id,
                recipientKind: body.contactId ? 'contact' : body.driverId ? 'driver' : 'external',
            })
            return NextResponse.json({ error: error.code }, { status: 403 })
        }
        throw error
    }

    const scenario = await getActiveScenario(body.scenarioId)
    if (!scenario) return NextResponse.json({ error: 'scenario_not_active' }, { status: 400 })

    const claim = await claimControlledRealAiCall({
        actorId: user.id,
        requestId: body.requestId,
        scenarioId: scenario.id,
        scenarioName: scenario.name,
        toNumber,
        fromNumber: readiness.admission.callerNumberE164,
        driverId: body.driverId,
        contactId: body.contactId,
        providers: readiness.admission.providers,
    })
    if (claim.kind === 'conflict') {
        return NextResponse.json({ error: 'idempotency_conflict' }, { status: 409 })
    }
    if (claim.kind === 'duplicate') return duplicateResponse(claim.call)

    let dispatch: Awaited<ReturnType<typeof dispatchControlledRealAiCall>>
    try {
        dispatch = await dispatchControlledRealAiCall({
            fsUuid: claim.fsUuid,
            toNumber,
        })
    } catch (error) {
        const failure = error instanceof ControlledRealAiCallDispatchError
            ? error.failure
            : 'unavailable'
        if (failure === 'outcome_unknown') {
            await recordControlledRealAiCallDispatchUnknown({
                callId: claim.call.id,
                requestFingerprint: claim.requestFingerprint,
            })
            opsLog('error', 'controlled_real_ai_call_provider_outcome_unknown', {
                callId: claim.call.id,
                provider: 'freeswitch',
                attempt: 1,
            })
            return NextResponse.json({
                error: 'provider_outcome_unknown',
                callId: claim.call.id,
                retryForbidden: true,
            }, { status: 504 })
        }

        await recordControlledRealAiCallDispatchRejected({
            callId: claim.call.id,
            requestFingerprint: claim.requestFingerprint,
            failureCode: failure === 'rejected' ? 'PROVIDER_REJECTED' : 'PROVIDER_UNAVAILABLE',
        })
        opsLog('error', 'controlled_real_ai_call_provider_failed', {
            callId: claim.call.id,
            provider: 'freeswitch',
            attempt: 1,
            failure,
        })
        return NextResponse.json({
            error: 'provider_originate_failed',
            callId: claim.call.id,
        }, { status: 502 })
    }

    try {
        await recordControlledRealAiCallDispatchAccepted({
            callId: claim.call.id,
            requestFingerprint: claim.requestFingerprint,
            providerReference: dispatch.providerReference,
        })
    } catch {
        // The provider has already accepted the originate command. Never turn
        // an observation write failure into a rejection or a retryable request.
        opsLog('error', 'controlled_real_ai_call_dispatch_observation_failed', {
            callId: claim.call.id,
            fsUuid: claim.fsUuid,
            provider: dispatch.provider,
            attempt: 1,
        })
        return NextResponse.json({
            ok: true,
            duplicate: false,
            dispatched: true,
            observationPending: true,
            retryForbidden: true,
            callId: claim.call.id,
            fsUuid: claim.fsUuid,
            scenarioId: scenario.id,
            scenarioName: scenario.name,
        }, { status: 202 })
    }

    opsLog('info', 'controlled_real_ai_call_dispatched', {
        callId: claim.call.id,
        fsUuid: claim.fsUuid,
        provider: dispatch.provider,
        attempt: 1,
    })

    return NextResponse.json({
        ok: true,
        duplicate: false,
        dispatched: true,
        callId: claim.call.id,
        fsUuid: claim.fsUuid,
        scenarioId: scenario.id,
        scenarioName: scenario.name,
    })
}
