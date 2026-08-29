import {
    AiCallLifecycleInputError,
    type AiCallLifecycleEventInput,
} from '../../application/ai-call-lifecycle'
import {
    AiCallTranscriptInputError,
    normalizeAiCallTranscriptMessage,
    type AiCallTranscriptMessageInput,
} from '../../application/ai-call-transcript'

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const BRIDGE_STATES = {
    greeting: { kind: 'greeting_started', sourceSequence: 1 },
    active: { kind: 'conversation_started', sourceSequence: 2 },
    transferring: { kind: 'transfer_started', sourceSequence: 3 },
} as const

export function normalizeBridgeLifecycleCallback(
    callId: string,
    body: unknown,
): AiCallLifecycleEventInput {
    if (!isRecord(body) || typeof body.state !== 'string' || !(body.state in BRIDGE_STATES)) {
        throw new AiCallLifecycleInputError('state is invalid')
    }
    const state = body.state as keyof typeof BRIDGE_STATES
    const mapping = BRIDGE_STATES[state]
    return {
        eventId: `audio-bridge-lifecycle:v1:${callId}:${mapping.kind}`,
        source: 'audio_bridge',
        sourceSequence: mapping.sourceSequence,
        kind: mapping.kind,
        target: state,
    }
}

export function normalizeBridgeTranscriptCallback(body: unknown): AiCallTranscriptMessageInput {
    if (!isRecord(body)) throw new AiCallTranscriptInputError('body must be an object')
    return normalizeAiCallTranscriptMessage({
        messageId: body.messageId,
        ordinal: body.ordinal,
        role: body.role,
        content: body.text,
        final: body.final,
        source: 'audio_bridge',
    })
}
