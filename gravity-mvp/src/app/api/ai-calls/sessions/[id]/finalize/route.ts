import { NextRequest, NextResponse } from 'next/server'
import { operationalLogV1 as opsLog } from '@/infrastructure/operations/operational-log'
import {
    AiCallFinalizationInputError,
    type FinalizeAiCallResult,
} from '@/modules/calling/application/ai-call-finalization'
import { finalizeAiCall } from '@/modules/calling/application/ai-call-finalization-runtime'
import { AiCallTranscriptConflictError } from '@/modules/calling/application/ai-call-transcript'
import { isBridgeMachineRequestAuthenticated } from '@/modules/calling/internal/ai-calls/bridge-machine-auth'

export const dynamic = 'force-dynamic'

function toHttp(result: FinalizeAiCallResult): NextResponse {
    if (result.kind === 'not_found') return NextResponse.json({ error: 'not_found' }, { status: 404 })
    if (result.kind === 'conflict') {
        return NextResponse.json({ error: 'finalization_conflict', reason: result.reason }, { status: 409 })
    }
    if (result.kind === 'retryable') {
        return NextResponse.json({
            error: 'follow_up_retryable',
            callId: result.callId,
            followUpStatus: result.followUpStatus,
            retryAfterMs: result.retryAfterMs,
        }, {
            status: 503,
            headers: { 'retry-after': String(Math.max(1, Math.ceil(result.retryAfterMs / 1_000))) },
        })
    }
    if (result.kind === 'terminal_failure') {
        return NextResponse.json({
            error: 'follow_up_terminal_failure',
            callId: result.callId,
            failure: result.failure,
        }, { status: 422 })
    }
    return NextResponse.json({
        ok: true,
        callId: result.callId,
        sessionStatus: result.sessionStatus,
        createdTask: result.createdTask,
        duplicate: result.duplicate,
        followUpStatus: result.followUpStatus,
    })
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    if (!isBridgeMachineRequestAuthenticated(req.headers)) {
        return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }

    const { id } = await ctx.params
    if (!id) return NextResponse.json({ error: 'id_required' }, { status: 400 })

    let body: unknown
    try {
        body = await req.json()
    } catch {
        return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
    }

    try {
        return toHttp(await finalizeAiCall(id, body))
    } catch (error) {
        if (error instanceof AiCallFinalizationInputError) {
            return NextResponse.json({ error: 'invalid_payload', message: error.message }, { status: 400 })
        }
        if (error instanceof AiCallTranscriptConflictError) {
            return NextResponse.json({ error: 'transcript_conflict', reason: error.code }, { status: 409 })
        }
        opsLog('error', 'ai_call_finalize_request_failed', {
            callId: id,
            errorCode: error instanceof Error ? error.name : 'UNKNOWN_ERROR',
        })
        throw error
    }
}
