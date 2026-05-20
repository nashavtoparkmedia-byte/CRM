/**
 * OpenAI-powered call analysis worker.
 *
 * Reads Call.transcript and asks GPT-4o (or whatever model the admin picked
 * in TelephonyAiConfig) to evaluate the manager along five criteria. The
 * structured JSON response is persisted to Call.aiScore / aiSummary /
 * aiAnalysis, then a SSE `updated` event is broadcast so the open call
 * detail tab refreshes immediately.
 *
 * Output shape is guaranteed by `response_format: { type: 'json_object' }` —
 * OpenAI's JSON-mode prevents the model from emitting prose around the
 * payload, so the parser only has to validate the field types.
 *
 * Prompt caching: OpenAI caches the prefix of any prompt ≥1024 tokens for
 * ~5 minutes automatically. Our default system prompt is well over that
 * threshold and stays stable between calls — `usage.prompt_tokens_details.
 * cached_tokens` in the response tells us how many of the input tokens
 * came from cache, which we log for cost visibility.
 */

import { Worker, type Job } from 'bullmq'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { opsLog } from '@/lib/opsLog'
import { getRedisConnection } from '@/lib/queue/connection'
import { ANALYZE_QUEUE, type AnalyzeJobData } from '@/lib/queue/queues'
import { broadcastCall } from '@/lib/callStreamBus'
import { getOpenAI } from '@/lib/openaiClient'
import { getTelephonyAiConfig } from '@/lib/aiCallAnalysis/config'
import { parseAnalysisResponse, averageScore } from '@/lib/aiCallAnalysis/prompt'
import {
    DEFAULT_QUALIFY_PROMPT,
    parseQualifyResponse,
    type QualificationResult,
} from '@/lib/aiCallAnalysis/qualifyPrompt'

const MAX_OUTPUT_TOKENS = 1024

let worker: Worker<AnalyzeJobData> | null = null

export function startAnalyzeWorker(): void {
    if (worker) return

    worker = new Worker<AnalyzeJobData>(
        ANALYZE_QUEUE,
        async (job: Job<AnalyzeJobData>) => {
            const { callId } = job.data
            await processOne(callId)
        },
        {
            connection: getRedisConnection(),
            concurrency: Number(process.env.ANALYZE_CONCURRENCY ?? 2),
        },
    )

    worker.on('failed', (job, err) => {
        opsLog('error', 'analyze_job_failed', {
            operation: 'analyze',
            callId: job?.data.callId,
            attemptsMade: job?.attemptsMade,
            error: err.message,
        })
    })

    worker.on('completed', (job) => {
        opsLog('info', 'analyze_job_completed', {
            operation: 'analyze',
            callId: job.data.callId,
        })
    })

    opsLog('info', 'analyze_worker_started', { operation: 'queue' })
}

async function processOne(callId: string): Promise<void> {
    const call = await prisma.call.findUnique({
        where: { id: callId },
        // `isAi` decides which prompt/parser we use — manager evaluation
        // (5-criterion rubric) for human inbound calls, qualification
        // extraction (QualificationResult shape) for AI-bot outbound calls.
        select: { id: true, transcript: true, aiAnalysis: true, isAi: true },
    })
    if (!call) {
        opsLog('warn', 'analyze_call_missing', { operation: 'analyze', callId })
        return
    }
    if (!call.transcript || call.transcript.trim().length === 0) {
        opsLog('warn', 'analyze_no_transcript', { operation: 'analyze', callId })
        return
    }
    if (call.aiAnalysis) {
        // Skip if already analyzed. Avoids double-billing on accidental re-enqueue.
        // Covers both paths: AI-call where bridge already wrote aiAnalysis via
        // the `end_call` tool, and manager-call where the previous job finished.
        opsLog('info', 'analyze_skip_already_done', { operation: 'analyze', callId })
        return
    }

    const config = await getTelephonyAiConfig()
    if (!config.enabled) {
        opsLog('info', 'analyze_disabled', { operation: 'analyze', callId })
        return
    }

    if (call.isAi) {
        await analyzeAiCall(callId, call.transcript, config.model)
    } else {
        await analyzeManagerCall(callId, call.transcript, config.model, config.systemPrompt)
    }
}

/**
 * Manager evaluation path: scores a human manager's call against the
 * 5-criterion rubric and writes Call.aiScore + aiSummary + aiAnalysis
 * (CallAnalysisShape).
 */
async function analyzeManagerCall(
    callId: string,
    transcript: string,
    model: string,
    systemPrompt: string,
): Promise<void> {
    const startedAt = Date.now()
    const openai = await getOpenAI()
    const completion = await openai.chat.completions.create({
        model,
        // JSON-mode — the model is required to emit a valid JSON object, so
        // we don't have to defensively unfence ```json blocks etc.
        response_format: { type: 'json_object' },
        // Low temperature: we want repeatable rubric scoring, not creativity.
        temperature: 0,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Расшифровка звонка:\n\n${transcript}` },
        ],
    })

    const content = completion.choices[0]?.message?.content
    if (!content) {
        throw new Error('analyze: openai returned empty content')
    }

    const parsed = parseAnalysisResponse(JSON.parse(content))
    const aiScore = averageScore(parsed.scores)

    await prisma.call.update({
        where: { id: callId },
        data: {
            aiScore,
            aiSummary: parsed.summary,
            aiAnalysis: parsed as unknown as Prisma.InputJsonValue,
        },
    })

    logUsage(callId, 'analyze_saved', model, startedAt, completion.usage, { aiScore })

    broadcastCall({
        type: 'updated',
        data: { callId, aiScore, aiSummary: parsed.summary, aiAnalysis: parsed },
    })
}

/**
 * AI-call fallback path: extracts a QualificationResult from the live
 * transcript the bridge already streamed in. Runs when the bridge
 * finalized without an `end_call` tool result (lead hung up early).
 *
 * NOT a manager evaluation — we score lead readiness, not the AI's
 * performance. aiScore stays null (the 1–10 rubric makes no sense here);
 * aiSummary gets the lead_summary so list views still have a 1-line
 * preview.
 */
async function analyzeAiCall(callId: string, transcript: string, model: string): Promise<void> {
    const startedAt = Date.now()
    const openai = await getOpenAI()
    const completion = await openai.chat.completions.create({
        model,
        response_format: { type: 'json_object' },
        temperature: 0,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: [
            { role: 'system', content: DEFAULT_QUALIFY_PROMPT },
            { role: 'user', content: `Расшифровка звонка AI-ассистента с лидом:\n\n${transcript}` },
        ],
    })

    const content = completion.choices[0]?.message?.content
    if (!content) {
        throw new Error('analyze (ai-call): openai returned empty content')
    }

    const parsed: QualificationResult = parseQualifyResponse(JSON.parse(content))

    // PR #57 — Structured Outcome Layer (fallback path).
    //
    // The analyzeWorker only fires when the bridge finalized WITHOUT an
    // end_call tool result — i.e. the lead hung up mid-call (transcript
    // exists, otherwise the enqueue is skipped in finalize route.ts).
    // So the CALL EVENT is unambiguously a drop, regardless of what the
    // post-hoc analyzer says about lead quality.
    //
    // Two distinct dimensions:
    //   - aiOutcome           — what the call EVENT was (here: drop)
    //   - qualificationScore  — how good the LEAD was (analyzer can opine)
    //
    // We set aiOutcome=dropped_mid_call deterministically. We do NOT
    // touch qualificationScore here — the post-hoc analyzer doesn't
    // currently emit a numeric score, and back-fitting one from the
    // parsed.qualification_status free-text would be guessing.
    // leadDataStructured stays null in this path: parsed.answers has a
    // fixed analyzer schema (has_license / experience_years / ...) that
    // is intentionally different from the scenario-canonical schema,
    // and mapping between them is out of scope for this PR.
    await prisma.call.update({
        where: { id: callId },
        data: {
            // aiScore intentionally NOT set — the 1–10 rubric is for human
            // manager evaluation, not for lead qualification.
            aiSummary: parsed.lead_summary,
            aiAnalysis: parsed as unknown as Prisma.InputJsonValue,
            aiOutcome: 'dropped_mid_call' as any,
            aiOutcomeReason: 'user_hangup_recovered_by_post_hoc_analysis',
        } as any,
    })

    logUsage(callId, 'analyze_ai_call_saved', model, startedAt, completion.usage, {
        qualification: parsed.qualification_status,
    })

    broadcastCall({
        type: 'updated',
        data: { callId, aiSummary: parsed.lead_summary, aiAnalysis: parsed },
    })
}

/**
 * Shared OpenAI usage-logging helper. cached_tokens visibility helps verify
 * that the long stable system prompt is hitting OpenAI's automatic prompt
 * cache (~50% input-token discount when warm).
 */
function logUsage(
    callId: string,
    event: string,
    model: string,
    startedAt: number,
    usageIn: unknown,
    extra: Record<string, unknown>,
): void {
    const usage = usageIn as
        | { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }
        | undefined

    opsLog('info', event, {
        operation: 'analyze',
        callId,
        model,
        latencyMs: Date.now() - startedAt,
        promptTokens: usage?.prompt_tokens ?? 0,
        cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
        completionTokens: usage?.completion_tokens ?? 0,
        ...extra,
    })
}

export async function stopAnalyzeWorker(): Promise<void> {
    if (!worker) return
    await worker.close()
    worker = null
}
