import { NextRequest, NextResponse } from 'next/server'
import { appendAiCallTranscriptMessage } from '@/modules/calling/application/ai-call-callback-runtime'
import {
    AiCallTranscriptConflictError,
    AiCallTranscriptInputError,
} from '@/modules/calling/application/ai-call-transcript'
import { isBridgeMachineRequestAuthenticated } from '@/modules/calling/internal/ai-calls/bridge-machine-auth'
import { normalizeBridgeTranscriptCallback } from '@/modules/calling/internal/ai-calls/bridge-callback-normalization'

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
        const message = normalizeBridgeTranscriptCallback(body)
        const result = await appendAiCallTranscriptMessage(id, message)
        if (result.kind === 'not_found') {
            return NextResponse.json({ error: 'not_found' }, { status: 404 })
        }
        return NextResponse.json({
            ok: true,
            callId: id,
            messageId: result.receipt.messageId,
            ordinal: result.receipt.ordinal,
            revision: result.journal.revision,
            duplicate: result.kind === 'duplicate',
            acceptedAfterTerminal: result.receipt.acceptedAfterTerminal,
        })
    } catch (error) {
        if (error instanceof AiCallTranscriptInputError) {
            return NextResponse.json({ error: 'invalid_transcript_item', message: error.message }, { status: 400 })
        }
        if (error instanceof AiCallTranscriptConflictError) {
            return NextResponse.json({ error: 'transcript_conflict', reason: error.code }, { status: 409 })
        }
        throw error
    }
}
