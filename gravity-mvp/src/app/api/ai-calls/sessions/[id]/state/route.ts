import { NextRequest, NextResponse } from 'next/server'
import { operationalLogV1 as opsLog } from '@/infrastructure/operations/operational-log'
import {
    AiCallLifecycleConflictError,
    AiCallLifecycleInputError,
} from '@/modules/calling/application/ai-call-lifecycle'
import { changeAiCallLifecycle } from '@/modules/calling/application/ai-call-callback-runtime'
import { isBridgeMachineRequestAuthenticated } from '@/modules/calling/internal/ai-calls/bridge-machine-auth'
import { normalizeBridgeLifecycleCallback } from '@/modules/calling/internal/ai-calls/bridge-callback-normalization'

export const dynamic = 'force-dynamic'

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
        const event = normalizeBridgeLifecycleCallback(id, body)
        const result = await changeAiCallLifecycle(id, event)
        if (result.kind === 'not_found') {
            return NextResponse.json({ error: 'not_found' }, { status: 404 })
        }
        if (result.kind === 'stale') {
            opsLog('warn', 'ai_call_lifecycle_stale_rejected', {
                callId: id,
                eventId: result.receipt.eventId,
                state: result.journal.state,
                revision: result.journal.revision,
            })
            return NextResponse.json({
                error: 'stale_lifecycle_event',
                callId: id,
                state: result.journal.state,
                revision: result.journal.revision,
            }, { status: 409 })
        }

        opsLog('info', result.kind === 'duplicate' ? 'ai_call_lifecycle_replayed' : 'ai_call_lifecycle_changed', {
            callId: id,
            eventId: result.receipt.eventId,
            from: result.receipt.previousState,
            to: result.journal.state,
            revision: result.journal.revision,
        })
        return NextResponse.json({
            ok: true,
            callId: id,
            state: result.journal.state,
            revision: result.journal.revision,
            skipped: result.kind === 'duplicate',
        })
    } catch (error) {
        if (error instanceof AiCallLifecycleInputError) {
            return NextResponse.json({ error: 'invalid_state', message: error.message }, { status: 400 })
        }
        if (error instanceof AiCallLifecycleConflictError) {
            return NextResponse.json({ error: 'lifecycle_conflict', reason: error.code }, { status: 409 })
        }
        throw error
    }
}
