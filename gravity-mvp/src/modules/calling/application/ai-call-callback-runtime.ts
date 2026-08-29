import { createAiCallLifecycleOperation } from './ai-call-lifecycle'
import { createAiCallTranscriptOperation } from './ai-call-transcript'
import { aiCallLifecyclePrismaPort } from '../internal/ai-calls/ai-call-lifecycle-prisma-adapter'
import { aiCallTranscriptPrismaPort } from '../internal/ai-calls/ai-call-transcript-prisma-adapter'

export const changeAiCallLifecycle = createAiCallLifecycleOperation({
    persistence: aiCallLifecyclePrismaPort,
})

export const appendAiCallTranscriptMessage = createAiCallTranscriptOperation({
    persistence: aiCallTranscriptPrismaPort,
})
